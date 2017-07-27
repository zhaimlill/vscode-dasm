import { readFileSync } from "fs";
import { basename } from "path";

import {
	Breakpoint,
	BreakpointEvent,
	DebugSession,
	Handles,
	InitializedEvent,
	Logger,
	logger,
	LoggingDebugSession,
	OutputEvent,
	Scope,
	Source,
	StackFrame,
	StoppedEvent,
	TerminatedEvent,
	Thread,
} from "vscode-debugadapter";

import { DebugProtocol } from "vscode-debugprotocol";
import DasmConstants from "./DasmConstants";
import * as DasmTabProtocol from "./network/DasmTabProtocol";
import TabServer from "./network/TabServer";

/**
 * This interface should always match the schema found in the mock-debug extension manifest.
 */
export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	program: string;		// An absolute path to the program to debug.
	stopOnEntry?: boolean;	// Automatically stop target after launch. If not specified, target does not stop
	trace?: boolean;		// Enable logging the Debug Adapter Protocol
}

class DasmDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private _server: TabServer<DasmTabProtocol.IMessage>; // Server that communicates with the player tab

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1000;

	// This is the next line that will be 'executed'
	private __currentLine = 0;
	private get _currentLine(): number {
		return this.__currentLine;
	}
	private set _currentLine(line:number) {
		this.__currentLine = line;
		this.log("line", line);
	}

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string;

	// the contents (= lines) of the one and only file
	private _sourceLines = new Array<string>();

	// maps from sourceFile to array of Breakpoints
	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();

	private _variableHandles = new Handles<string>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super("mock-debug.txt");

		// Basic options
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._server = new TabServer<DasmTabProtocol.IMessage>(DasmConstants.PLAYER_COMMUNICATION_PORT);
		this._server.onMessage.add((message) => {
			console.log("[DEBUGGER] Received server message of type ", message.kind, message);
		});
		this._server.onClientConnect.add((id) => {
			console.log("[DEBUGGER] Connected to client", id);
		});
		this._server.onClientDisconnect.add((id) => {
			console.log("[DEBUGGER] Disconnected from client", id);
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response:DebugProtocol.InitializeResponse, args:DebugProtocol.InitializeRequestArguments): void {

		console.log("initialize!", args);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());

		response.body = response.body || {};

		// This debug adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = true;

		this.sendResponse(response);
	}

	protected launchRequest(response:DebugProtocol.LaunchResponse, args:ILaunchRequestArguments): void {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		console.log("[DEBUGGER] Launched", args);

		this._sourceFile = args.program;
		this._sourceLines = readFileSync(this._sourceFile).toString().split("\n");

		if (args.stopOnEntry) {
			this._currentLine = 0;
			this.sendResponse(response);

			// we stop on the first line
			this.sendEvent(new StoppedEvent("entry", DasmDebugSession.THREAD_ID));
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continueRequest(response as DebugProtocol.ContinueResponse, { threadId: DasmDebugSession.THREAD_ID });
		}
	}

	protected setBreakPointsRequest(response:DebugProtocol.SetBreakpointsResponse, args:DebugProtocol.SetBreakpointsArguments): void {

		const path = args.source.path as string;
		const clientLines = args.lines || [];

		// read file contents into array for direct access
		const lines = readFileSync(path).toString().split("\n");

		const breakpoints = new Array<Breakpoint>();

		// verify breakpoint locations
		for (const clientLine of clientLines) {
			let l = this.convertClientLineToDebugger(clientLine);
			let verified = false;
			if (l < lines.length) {
				const line = lines[l].trim();
				// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
				if (line.length === 0 || line.indexOf("+") === 0) {
					l++;
				}
				// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
				if (line.indexOf("-") === 0) {
					l--;
				}
				// don't set 'verified' to true if the line contains the word 'lazy'
				// in this case the breakpoint will be verified 'lazy' after hitting it once.
				if (line.indexOf("lazy") < 0) {
					verified = true;    // this breakpoint has been validated
				}
			}
			const bp = new Breakpoint(verified, this.convertDebuggerLineToClient(l)) as DebugProtocol.Breakpoint;
			bp.id = this._breakpointId++;
			breakpoints.push(bp);
		}
		this._breakPoints.set(path, breakpoints);

		// send back the actual breakpoint positions
		response.body = {
			breakpoints,
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response:DebugProtocol.ThreadsResponse): void {

		// return the default thread
		response.body = {
			threads: [
				new Thread(DasmDebugSession.THREAD_ID, "thread 1"),
			],
		};
		this.sendResponse(response);
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	protected stackTraceRequest(response:DebugProtocol.StackTraceResponse, args:DebugProtocol.StackTraceArguments): void {

		const words = this._sourceLines[this._currentLine].trim().split(/\s+/);

		const startFrame = typeof args.startFrame === "number" ? args.startFrame : 0;
		const maxLevels = typeof args.levels === "number" ? args.levels : words.length - startFrame;
		const endFrame = Math.min(startFrame + maxLevels, words.length);

		const frames = new Array<StackFrame>();
		// every word of the current line becomes a stack frame.
		for (let i = startFrame; i < endFrame; i++) {
			const name = words[i];	// use a word of the line as the stackframe name
			frames.push(new StackFrame(i, `${name}(${i})`, new Source(basename(this._sourceFile),
				this.convertDebuggerPathToClient(this._sourceFile)),
				this.convertDebuggerLineToClient(this._currentLine), 0));
		}
		response.body = {
			stackFrames: frames,
			totalFrames: words.length,
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response:DebugProtocol.ScopesResponse, args:DebugProtocol.ScopesArguments): void {

		const frameReference = args.frameId;
		const scopes = new Array<Scope>();
		scopes.push(new Scope("Local", this._variableHandles.create("local_" + frameReference), false));
		scopes.push(new Scope("Closure", this._variableHandles.create("closure_" + frameReference), false));
		scopes.push(new Scope("Global", this._variableHandles.create("global_" + frameReference), true));

		response.body = {
			scopes,
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response:DebugProtocol.VariablesResponse, args:DebugProtocol.VariablesArguments): void {

		const variables = new Array<DebugProtocol.Variable>();
		const id = this._variableHandles.get(args.variablesReference);
		if (id !== null) {
			variables.push({
				name: id + "_i",
				type: "integer",
				value: "123",
				variablesReference: 0,
			});
			variables.push({
				name: id + "_f",
				type: "float",
				value: "3.14",
				variablesReference: 0,
			});
			variables.push({
				name: id + "_s",
				type: "string",
				value: "hello world",
				variablesReference: 0,
			});
			variables.push({
				name: id + "_o",
				type: "object",
				value: "Object",
				variablesReference: this._variableHandles.create("object_"),
			});
		}

		response.body = {
			variables,
		};
		this.sendResponse(response);
	}

	protected continueRequest(response:DebugProtocol.ContinueResponse, args:DebugProtocol.ContinueArguments): void {

		for (let ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
			if (this.fireEventsForLine(response, ln)) {
				return;
			}
		}
		this.sendResponse(response);
		// no more lines: run to end
		this.sendEvent(new TerminatedEvent());
	}

	protected reverseContinueRequest(response:DebugProtocol.ReverseContinueResponse, args:DebugProtocol.ReverseContinueArguments): void {

		for (let ln = this._currentLine - 1; ln >= 0; ln--) {
			if (this.fireEventsForLine(response, ln)) {
				return;
			}
		}
		this.sendResponse(response);
		// no more lines: stop at first line
		this._currentLine = 0;
		this.sendEvent(new StoppedEvent("entry", DasmDebugSession.THREAD_ID));
	}

	protected nextRequest(response:DebugProtocol.NextResponse, args:DebugProtocol.NextArguments): void {

		for (let ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
			if (this.fireStepEvent(response, ln)) {
				return;
			}
		}
		this.sendResponse(response);
		// no more lines: run to end
		this.sendEvent(new TerminatedEvent());
	}

	protected stepBackRequest(response:DebugProtocol.StepBackResponse, args:DebugProtocol.StepBackArguments): void {

		for (let ln = this._currentLine - 1; ln >= 0; ln--) {
			if (this.fireStepEvent(response, ln)) {
				return;
			}
		}
		this.sendResponse(response);
		// no more lines: stop at first line
		this._currentLine = 0;
		this.sendEvent(new StoppedEvent("entry", DasmDebugSession.THREAD_ID));
	}

	protected evaluateRequest(response:DebugProtocol.EvaluateResponse, args:DebugProtocol.EvaluateArguments): void {

		response.body = {
			result: `evaluate(context: '${args.context}', '${args.expression}')`,
			variablesReference: 0,
		};
		this.sendResponse(response);
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
		console.log("[DEBUGGER] Disconnecting", args);

		this._server.dispose();
		this.sendResponse(response);
	}

	// ---- some helpers

	/**
	 * Fire StoppedEvent if line is not empty.
	 */
	private fireStepEvent(response:DebugProtocol.Response, ln:number): boolean {

		if (this._sourceLines[ln].trim().length > 0) {	// non-empty line
			this._currentLine = ln;
			this.sendResponse(response);
			this.sendEvent(new StoppedEvent("step", DasmDebugSession.THREAD_ID));
			return true;
		}
		return false;
	}

	/**
	 * Fire StoppedEvent if line has a breakpoint or the word 'exception' is found.
	 */
	private fireEventsForLine(response:DebugProtocol.Response, ln:number): boolean {

		// find the breakpoints for the current source file
		const breakpoints = this._breakPoints.get(this._sourceFile);
		if (breakpoints) {
			const bps = breakpoints.filter((bp) => bp.line === this.convertDebuggerLineToClient(ln));
			if (bps.length > 0) {
				this._currentLine = ln;

				// 'continue' request finished
				this.sendResponse(response);

				// send 'stopped' event
				this.sendEvent(new StoppedEvent("breakpoint", DasmDebugSession.THREAD_ID));

				// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
				// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
				if (!bps[0].verified) {
					bps[0].verified = true;
					this.sendEvent(new BreakpointEvent("update", bps[0]));
				}
				return true;
			}
		}

		// if word 'exception' found in source -> throw exception
		if (this._sourceLines[ln].indexOf("exception") >= 0) {
			this._currentLine = ln;
			this.sendResponse(response);
			this.sendEvent(new StoppedEvent("exception", DasmDebugSession.THREAD_ID));
			this.log("exception in line", ln);
			return true;
		}

		return false;
	}

	private log(msg:string, line:number) {
		const e = new OutputEvent(`${msg}: ${line}\n`);
		(e as DebugProtocol.OutputEvent).body.variablesReference = this._variableHandles.create("args");
		this.sendEvent(e);	// print current line on debug console
	}
}

DebugSession.run(DasmDebugSession);