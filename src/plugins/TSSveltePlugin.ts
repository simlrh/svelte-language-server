import ts from 'typescript';
import {
    DiagnosticsProvider,
    Document,
    Diagnostic,
    OnRegister,
    Host,
    Hover,
    HoverProvider,
    Position,
} from '../api';
import {
    convertRange,
    mapSeverity
} from './typescript/utils';
import { getLanguageServiceForDocument, CreateDocument } from './ts-svelte/service';
import { pathToUrl } from '../utils';



export class TSSveltePlugin
    implements
    DiagnosticsProvider,
    HoverProvider,
    OnRegister
{

    public pluginId = 'tssvelte';
    public defaultConfig = {
        enable: true,
        diagnostics: { enable: true },
    };

    private host!: Host;
    private createDocument!: CreateDocument;

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

        const lang = await getLanguageServiceForDocument(document, this.createDocument);

        const fileName = document.getFilePath()!;

        let diagnostics: ts.Diagnostic[] = [
            ...lang.getSyntacticDiagnostics(fileName),
            ...lang.getSuggestionDiagnostics(fileName),
            ...lang.getSemanticDiagnostics(fileName)
        ];

        return diagnostics.map(diagnostic => ({
            range: convertRange(document, diagnostic),
            severity: mapSeverity(diagnostic.category),
            source: 'ts-svelte',
            message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            code: diagnostic.code,
        }));
    }

    async doHover(document: Document, position: Position): Promise<Hover | null> {
        if (!this.host.getConfig<boolean>('tssvelte.hover.enable')) {
            return null;
        }

        const lang = await getLanguageServiceForDocument(document, this.createDocument);
        const info = lang.getQuickInfoAtPosition(
            document.getFilePath()!,
            document.offsetAt(position),
        );
        if (!info) {
            return null;
        }
        let contents = ts.displayPartsToString(info.displayParts);
        return {
            range: convertRange(document, info.textSpan),
            contents: { language: 'ts', value: contents },
        };
    }
}
