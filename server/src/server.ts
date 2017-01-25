// Reference:
// https://code.visualstudio.com/docs/extensions/example-language-server
// https://code.visualstudio.com/docs/extensions/language-support#_programmatic-language-support

import {
	CompletionItem,
	CompletionItemKind,
	createConnection,
	Diagnostic,
	IConnection,
	InitializeResult,
	IPCMessageReader,
	IPCMessageWriter,
	Location,
	TextDocument,
	TextDocumentPositionParams,
	TextDocuments,
} from "vscode-languageserver";

import { Assembler, IAssemblerResult } from "./providers/Assembler";
import DefinitionProvider from "./providers/DefinitionProvider";
import DiagnosticsProvider from "./providers/DiagnosticsProvider";
import HoverProvider from "./providers/HoverProvider";

// Create a connection for the server. The connection uses Node's IPC as a transport
const connection:IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// Create all needed provider instances
const assembler = new Assembler();
const diagnosticsProvider = new DiagnosticsProvider();
const hoverProvider = new HoverProvider();
const definitionProvider = new DefinitionProvider();

let currentResults:IAssemblerResult;
let currentSource:string;
let currentSourceLines:string[];

// Use full document sync only for open, change and close text document events
const documents:TextDocuments = new TextDocuments();
documents.listen(connection);

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites.
let workspaceRoot:string;

connection.onInitialize((params):InitializeResult => {
	workspaceRoot = params.rootPath || "";

	return {
		// Tells the client about the server's capabilities
		capabilities: {
			// Working in FULL text document sync mode
			textDocumentSync: documents.syncKind,

			// Hover on symbols/etc
			hoverProvider: true,

			// Code complete
			completionProvider: {
				resolveProvider: true,
			},

			// Go to definition
			definitionProvider: true,
		},
	};
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
	assembleDocument(change.document);
});


interface ISettings {
	["vscode-dasm"]:IExtensionSettings;
}

interface IExtensionSettings {
	preferUppercase:string[];
}

// Hold settings
let preferUppercase:string[];

// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration((change) => {
	let settings = <ISettings>change.settings;
	preferUppercase = settings["vscode-dasm"].preferUppercase;

	console.log("[server] Uppercase preference is ", preferUppercase);

	// Revalidate any open text documents
	documents.all().forEach(assembleDocument);
});

function assembleDocument(textDocument:TextDocument):void {
	console.log("[server] Assembling");

	// Assemble first
	currentSource = textDocument.getText();
	currentSourceLines = currentSource ? currentSource.split(/\r?\n/g) : [];
	currentResults = assembler.assemble(currentSource);

	// Provide diagnostics
	const diagnostics:Diagnostic[] = diagnosticsProvider.process(currentSourceLines, currentResults);

	// Send the computed diagnostics to VSCode
	connection.sendDiagnostics({ uri:textDocument.uri, diagnostics });
}

connection.onHover((textDocumentPosition, token) => {
	return hoverProvider.process(textDocumentPosition, currentSourceLines, currentResults);
});

// This handler provides the initial list of the completion items.
connection.onCompletion((textDocumentPosition:TextDocumentPositionParams): CompletionItem[] => {
	// The pass parameter contains the position of the text document in
	// which code complete got requested. For the example we ignore this
	// info and always provide the same completion items.
	return [
		{
			label: "processor",
			kind: CompletionItemKind.Text,
			data: 1,
		}
	]
});

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
	if (item.data === 1) {
		item.detail = "Processor type";
		item.documentation = "Selects the processor type for the assembly";
	}
	return item;
});

connection.onDidChangeWatchedFiles((change) => {
	// Monitored files have change in VSCode
	connection.console.log('We received an file change event');
});

connection.onDefinition((textDocumentPosition:TextDocumentPositionParams): Location[] => {
	return definitionProvider.process(textDocumentPosition, currentSourceLines, currentResults);
});
/*
connection.onDidOpenTextDocument((params) => {
	// A text document got opened in VSCode.
	// params.uri uniquely identifies the document. For documents store on disk this is a file URI.
	// params.text the initial full content of the document.
	connection.console.log(`${params.textDocument.uri} opened.`);
});

connection.onDidChangeTextDocument((params) => {
	// The content of a text document did change in VSCode.
	// params.uri uniquely identifies the document.
	// params.contentChanges describe the content changes to the document.
	connection.console.log(`${params.textDocument.uri} changed:${JSON.stringify(params.contentChanges)}`);
});

connection.onDidCloseTextDocument((params) => {
	// A text document got closed in VSCode.
	// params.uri uniquely identifies the document.
	connection.console.log(`${params.textDocument.uri} closed.`);
});
*/

// Finally, listen on the connection
connection.listen();
