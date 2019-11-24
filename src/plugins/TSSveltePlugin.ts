import ts from 'typescript';
import {
    DiagnosticsProvider,
    Document,
    Diagnostic,
    OnRegister,
    Host,
    Range
} from '../api';
import {
    convertRange,
    mapSeverity
} from './typescript/utils';
import { getLanguageServiceForDocument, CreateDocument, getSourceMapForDocument } from './ts-svelte/service';
import { pathToUrl } from '../utils';
import { SourceMapConsumer } from 'source-map';


export class TSSveltePlugin
    implements
    DiagnosticsProvider,
    // HoverProvider,
    OnRegister//,
// DocumentSymbolsProvider,
//  CompletionsProvider,
//  DefinitionsProvider,
//  CodeActionsProvider 
{
    //  public static matchFragment(fragment: Fragment) {
    //      return fragment.details.attributes.tag == 'script';
    //  }

    public pluginId = 'tssvelte';
    public defaultConfig = {
        enable: true,
        diagnostics: { enable: true },
    };

    private host!: Host;
    private createDocument!: CreateDocument;


    private consumers = new Map<Document, {version: number, consumer: SourceMapConsumer}>();


    onRegister(host: Host) {
        this.host = host;
        this.createDocument = (fileName, content) => {
            const uri = pathToUrl(fileName);
            const document = host.openDocument({
                languageId: '',
                text: content,
                uri,
                version: 0,
            });
            host.lockDocument(uri);
            return document;
        };
    }

    async getDiagnostics(document: Document): Promise<Diagnostic[]> {
        if (!this.host.getConfig<boolean>('tssvelte.diagnostics.enable')) {
            return [];
        }

        const lang = getLanguageServiceForDocument(document, this.createDocument);
        const isTypescript = true;

        let diagnostics: ts.Diagnostic[] = [
            ...lang.getSyntacticDiagnostics(document.getFilePath()!),
            ...lang.getSuggestionDiagnostics(document.getFilePath()!),
        ];

        if (isTypescript) {
            diagnostics.push(...lang.getSemanticDiagnostics(document.getFilePath()!));
        }

        let sourceMap = getSourceMapForDocument(document);
        let decoder: { version: number, consumer: SourceMapConsumer } | null = null;
        if (sourceMap) {
            let decoder = this.consumers.get(document);
            if (!decoder || decoder.version != document.version) {
                decoder = { version: document.version, consumer: await new SourceMapConsumer(sourceMap)};
                this.consumers.set(document, decoder);
            }
        }

        return diagnostics.map(diagnostic => ({
            range:  decoder != null ? this.mapDiagnosticLocationToRange(diagnostic, document, decoder.consumer) : convertRange(document, diagnostic) ,
            severity: mapSeverity(diagnostic.category),
            source: 'ts-svelte',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            code: diagnostic.code,
        }));
    }

    mapDiagnosticLocationToRange(diagnostic: ts.Diagnostic, document: Document, consumer: SourceMapConsumer): Range {
        if (!diagnostic.file) return convertRange(document, diagnostic)
        if (typeof diagnostic.start != "number") return convertRange(document, diagnostic)

        let start = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start);
        //these are 0 based, but we want 1 based to match sourcemap and editor etc
        start.character = start.character + 1;
        start.line = start.line + 1;

        let end;
        if (typeof diagnostic.length == "number") {
            end = ts.getLineAndCharacterOfPosition(diagnostic.file, diagnostic.start + diagnostic.length);
            end.character = end.character + 1;
            end.line = end.line + 1;
        } else {
            end = {
                line: start.line,
                character: start.character,
            } as ts.LineAndCharacter
        }

       
        for (let pos of [start, end]) {
            if (pos.line == 0) {
                console.log("invalid pos", start, end, diagnostic.start);
            }
            let res = consumer.originalPositionFor({ line: pos.line, column: pos.character })
            if (res != null) {
                pos.line = res.line || 0;
                pos.character = res.column || 0;
            }
        }

        return { start, end }
    }

}
