import ts from 'typescript';
import { DocumentSnapshot } from './DocumentSnapshot';
import { isSvelte } from '../typescript/utils';
import { dirname, resolve } from 'path';
import { Document } from '../../api';
import { SourceMapConsumer } from 'source-map';

export interface LanguageServiceContainer {
  updateDocument(document: Document): Promise<ts.LanguageService>;
}

const services = new Map<string, LanguageServiceContainer>();
const consumers = new Map<Document, {version: number, consumer: SourceMapConsumer}>();

export type CreateDocument = (fileName: string, content: string) => Document;

export async function getLanguageServiceForDocument(
    document: Document,
    createDocument: CreateDocument,
): Promise<ts.LanguageService> {
    const searchDir = dirname(document.getFilePath()!);
    const tsconfigPath =
        ts.findConfigFile(searchDir, ts.sys.fileExists, 'tsconfig.json') ||
        ts.findConfigFile(searchDir, ts.sys.fileExists, 'jsconfig.json') ||
        '';

    let service: LanguageServiceContainer;
    if (services.has(tsconfigPath)) {
        service = services.get(tsconfigPath)!;
    } else {
        service = createLanguageService(tsconfigPath, createDocument);
        services.set(tsconfigPath, service);
    }

    return service.updateDocument(document);
}

export function createLanguageService(
    tsconfigPath: string,
    createDocument: CreateDocument,
): LanguageServiceContainer {
    const workspacePath = tsconfigPath ? dirname(tsconfigPath) : '';
    const documents = new Map<string, DocumentSnapshot>();

    let compilerOptions: ts.CompilerOptions = {
        allowNonTsExtensions: true,
        target: ts.ScriptTarget.Latest,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        allowJs: true,
    };

    const configJson = tsconfigPath && ts.readConfigFile(tsconfigPath, ts.sys.readFile).config;
    let files: string[] = [];
    if (configJson) {
        const parsedConfig = ts.parseJsonConfigFileContent(
            configJson,
            ts.sys,
            workspacePath,
            compilerOptions,
            tsconfigPath,
            undefined,
            [
                { extension: 'html', isMixedContent: true },
                { extension: 'svelte', isMixedContent: false, scriptKind: ts.ScriptKind.TSX },
            ],
        );
        files = parsedConfig.fileNames;
        compilerOptions = { ...compilerOptions, ...parsedConfig.options };
    }

    //we force some options
    let forcedOptions: ts.CompilerOptions = { 
        noEmit: true,
        declaration: false,
        jsx: ts.JsxEmit.Preserve,
        jsxFactory: "h",
        skipLibCheck: true
    }

    compilerOptions = { ...compilerOptions, ...forcedOptions }
    const svelteTsPath = dirname(require.resolve('svelte2tsx'))
    const svelteTsxFiles = ['./svelte-shims.d.ts', './svelte-jsx.d.ts'].map(f => ts.sys.resolvePath(resolve(svelteTsPath, f)));

    const host: ts.LanguageServiceHost = {
        getCompilationSettings: () => compilerOptions,
        getScriptFileNames: () => Array.from(new Set([...files, ...Array.from(documents.keys()), ...svelteTsxFiles].map(useSvelteTsxName))),
        getScriptVersion(fileName: string) {
            const doc = getSvelteSnapshot(fileName);
            return doc ? String(doc.document.version) : '0';
        },
        getScriptSnapshot(fileName: string): ts.IScriptSnapshot | undefined {
            // console.log("get script snapshot", fileName);
            const doc = getSvelteSnapshot(fileName);
            if (doc) {
                return doc;
            }

            return ts.ScriptSnapshot.fromString(this.readFile!(fileName) || '');
        },
        getCurrentDirectory: () => workspacePath,
        getDefaultLibFileName: ts.getDefaultLibFilePath,

        resolveModuleNames(moduleNames: string[], containingFile: string): ts.ResolvedModule[] {
            return moduleNames.map(name => {
                const resolved = ts.resolveModuleName(
                    name,
                    containingFile,
                    compilerOptions,
                    {
                        fileExists,
                        readFile   
                    },
                );

                return resolved.resolvedModule!;
            });
        },

        readFile(path: string, encoding?: string): string | undefined {
            if (path.endsWith(".svelte")) {
                console.log("reading svelte file from language server host", path);
            }
            return ts.sys.readFile(path, encoding);
        },
    };

    const originalLanguageService = ts.createLanguageService(host);

    const languageService: ts.LanguageService = {
        ...originalLanguageService,
        getSyntacticDiagnostics(fileName: string): ts.DiagnosticWithLocation[] {
            const svelteFileName = useSvelteTsxName(fileName); 

            const diagnostics = originalLanguageService.getSyntacticDiagnostics(svelteFileName);

            const getOriginalIndex = getOriginalIndexForFileName(svelteFileName);

            return diagnostics.map(mapDiagnostic(getOriginalIndex));
        },
        getSemanticDiagnostics(fileName: string): ts.Diagnostic[] {
            const svelteFileName = useSvelteTsxName(fileName); 

            const diagnostics = originalLanguageService.getSemanticDiagnostics(svelteFileName);

            const getOriginalIndex = getOriginalIndexForFileName(svelteFileName);

            return diagnostics.map(mapDiagnostic(getOriginalIndex));
        },
        getSuggestionDiagnostics(fileName: string): ts.DiagnosticWithLocation[] {
            const svelteFileName = useSvelteTsxName(fileName); 

            const diagnostics = originalLanguageService.getSuggestionDiagnostics(svelteFileName);

            const getOriginalIndex = getOriginalIndexForFileName(svelteFileName);

            return diagnostics.map(mapDiagnostic(getOriginalIndex));
        },
        getQuickInfoAtPosition(fileName: string, position: number): ts.QuickInfo | undefined {
            const svelteFileName = useSvelteTsxName(fileName); 

            const getGeneratedIndex = getGeneratedIndexForFileName(svelteFileName);
            const getOriginalIndex = getOriginalIndexForFileName(svelteFileName);

            const info = originalLanguageService.getQuickInfoAtPosition(
                svelteFileName,
                getGeneratedIndex(position)
            );

            return info && {
                ...info,
                textSpan: {
                    ...info.textSpan,
                    start: getOriginalIndex(info.textSpan.start),
                }
            };
        }
    };

    function getSvelteSnapshot(fileName: string): DocumentSnapshot | undefined {
        const doc = documents.get(fileName);
        if (doc) {
            return doc;
        }

        if (isSvelteTsx(fileName)) {
            const originalName = originalNameFromSvelteTsx(fileName);
            const doc = DocumentSnapshot.fromDocument(
                createDocument(originalName, ts.sys.readFile(originalName) || ''))
            documents.set(fileName, doc);
            return doc;
        }
    }

    function isSvelteTsx(fileName: string): boolean {
        return fileName.endsWith('.svelte.tsx');
    }

    function originalNameFromSvelteTsx(filename: string) {
        return filename.substring(0, filename.length -'.tsx'.length)
    }

    function fileExists(filename: string) {
        if (isSvelteTsx(filename)) {
            return ts.sys.fileExists(originalNameFromSvelteTsx(filename))
        }
        return ts.sys.fileExists(filename);
    }

    function readFile(fileName: string) {
        // console.log("Reading file from module resolve");
        if (!isSvelteTsx) {
            return ts.sys.readFile(fileName)
        } 
        return ts.sys.readFile(originalNameFromSvelteTsx(fileName));
    }

    function useSvelteTsxName(filename: string) {
        if (isSvelte(filename)) {
            return filename+".tsx";
        }
        return filename;
    }

    function getSourceMapData(fileName: string) {
        let original: Document | undefined;
        let generated: ts.SourceFile | undefined;
        let consumer: SourceMapConsumer | undefined;

        let snapshot = getSvelteSnapshot(fileName);
        if (snapshot) {
            original = snapshot.document;
            consumer = consumers.get(original)?.consumer;
            generated = languageService.getProgram()?.getSourceFile(fileName);
        }

        return { consumer, original, generated };
    }

    function getOriginalIndexForFileName(fileName: string) {
        const { consumer, original, generated } = getSourceMapData(fileName);

        return function getOriginalIndex(index: number): number {
            if (!consumer || !original || !generated) {
                return index;
            }
            const generatedPosition = ts.getLineAndCharacterOfPosition(generated, index);
            const res = consumer.originalPositionFor({ line: generatedPosition.line+1, column: generatedPosition.character+1 });
            const originalPosition = res ? { line: (res.line || 1) - 1, character: (res.column || 1) - 1 } : generatedPosition;
            return original.offsetAt(originalPosition);
        }
    }

    function getGeneratedIndexForFileName(fileName: string) {
        const { consumer, original, generated } = getSourceMapData(fileName);

        return function (index: number): number {
            if (!consumer || !original || !generated) {
                return index;
            }

            const originalPosition = original.positionAt(index);

            const res = consumer.generatedPositionFor({
                source: originalNameFromSvelteTsx(fileName),
                line: originalPosition.line + 1,
                column: originalPosition.character + 1
            });

            const generatedPosition = res
                ? { line: (res.line || 1) - 1, character: (res.column || 1) - 1 }
                : originalPosition;

            console.log(generated.getText(), generatedPosition);

            return generated.getPositionOfLineAndCharacter(generatedPosition.line, generatedPosition.character);
        }
    }

    function mapDiagnostic<D extends ts.Diagnostic | ts.DiagnosticWithLocation = ts.DiagnosticWithLocation>(
        getOriginalIndex: ReturnType<typeof getOriginalIndexForFileName>
    ) {
        return function (diagnostic: D): D {
            return {
                ...diagnostic,
                start: diagnostic.start === undefined ? undefined : getOriginalIndex(diagnostic.start),
            }
        }
    }

    async function updateDocument(document: Document): Promise<ts.LanguageService> {
        // console.log("update document", document.getFilePath());
        const newSnapshot = DocumentSnapshot.fromDocument(document);
        documents.set(useSvelteTsxName(document.getFilePath()!), newSnapshot);

        if (newSnapshot.map) {
            let consumer = consumers.get(document);
            if (!consumer || consumer.version != document.version) {
                consumer?.consumer.destroy();
                consumer = { version: document.version, consumer: await new SourceMapConsumer(newSnapshot.map) };
                consumers.set(document, consumer);
            }
        } else {
            consumers.delete(document);
        }

        return languageService;
    }

    return { updateDocument };
}
