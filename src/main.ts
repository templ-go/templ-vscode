import * as vscode from "vscode";
import { exec } from "child_process";
import {
  CancellationToken,
  CloseAction,
  CloseHandlerResult,
  CompletionItemKind,
  ConfigurationParams,
  ConfigurationRequest,
  ErrorAction,
  ErrorHandlerResult,
  Message,
  ProvideCompletionItemsSignature,
  ProvideDocumentFormattingEditsSignature,
  ResponseError,
} from "vscode-languageclient";
import fs from "fs/promises";
import path from "path";
import { LanguageClient } from "vscode-languageclient/node";
import { lookpath } from "lookpath";
import { CustomLanguageClient } from "./custom-client";

export async function activate(ctx: vscode.ExtensionContext) {
  try {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(
        "templ.restartServer",
        startLanguageClient,
      ),
    );

    await startLanguageClient();
  } catch (err) {
    const msg = err && (err as Error) ? (err as Error).message : "unknown";
    vscode.window.showErrorMessage(`error initializing templ LSP: ${msg}`);
  }
}

interface Configuration {
  goplsLog: string;
  goplsRPCTrace: boolean;
  goplsRemote: string;
  noPreload: boolean;
  log: string;
  pprof: boolean;
  http: string;
  experiments: string;
  executablePath: string;
  goFileSupport: boolean;
}

interface TemplCtx {
  languageClient?: LanguageClient;
}

const ctx: TemplCtx = {};

const loadConfiguration = (): Configuration => {
  const c = vscode.workspace.getConfiguration("templ");
  return {
    goplsLog: c.get("goplsLog") || "",
    goplsRPCTrace: c.get("goplsRPCTrace") ? true : false,
    goplsRemote: c.get("goplsRemote") ||  "",
    noPreload: c.get("noPreload") ? true : false,
    log: c.get("log") || "",
    pprof: c.get("pprof") ? true : false,
    http: c.get("http") || "",
    experiments: c.get("experiments") || "",
    executablePath: c.get("executablePath") || "",
    goFileSupport: c.get("goFileSupport") ? true : false,
  };
};

const templLocations = [
  path.join(process.env.GOBIN ?? "", "templ"),
  path.join(process.env.GOBIN ?? "", "templ.exe"),
  path.join(process.env.GOPATH ?? "", "bin", "templ"),
  path.join(process.env.GOPATH ?? "", "bin", "templ.exe"),
  path.join(process.env.GOROOT || "", "bin", "templ"),
  path.join(process.env.GOROOT || "", "bin", "templ.exe"),
  path.join(process.env.HOME || "", "bin", "templ"),
  path.join(process.env.HOME || "", "bin", "templ.exe"),
  path.join(process.env.HOME || "", "go", "bin", "templ"),
  path.join(process.env.HOME || "", "go", "bin", "templ.exe"),
  "/usr/local/bin/templ",
  "/usr/bin/templ",
  "/usr/local/go/bin/templ",
  "/usr/local/share/go/bin/templ",
  "/usr/share/go/bin/templ",
];

async function tryGoTool(): Promise<string | undefined> {
  try {
    const go = await lookpath("go");
    if (!go) return undefined;
    const result = await run(go + " tool -n templ");
    return result
  } catch (err) {
    console.log(err)
    return undefined
  }
}

function run(cmd: string): Promise<string> {
  const dir = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0].uri.fsPath : ""
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: dir }, (error, stdout, _) => {
      if (error) return reject(error)
      resolve(stdout.trim())
    })
  })
}

async function findTempl(): Promise<string> {
  const config = loadConfiguration();
  if (config.executablePath) {
    return config.executablePath;
  }

  const goTool = await tryGoTool();
  if (goTool) {
    return goTool;
  }
  const linuxName = await lookpath("templ");
  if (linuxName) {
    return linuxName;
  }
  const windowsName = await lookpath("templ.exe");
  if (windowsName) {
    return windowsName;
  }
  for (const exe of templLocations) {
    try {
      await fs.stat(exe);
      return exe;
    } catch (err) {
      // ignore
    }
  }
  throw new Error(
    `Could not find templ executable in path or in ${templLocations.join(", ")}`,
  );
}

async function stopLanguageClient() {
  const c = ctx.languageClient;
  ctx.languageClient = undefined;
  if (!c) return false;

  if (c.diagnostics) {
    c.diagnostics.clear();
  }
  // LanguageClient.stop may hang if the language server
  // crashes during shutdown before responding to the
  // shutdown request. Enforce client-side timeout.
  try {
    c.stop(2000);
  } catch (e) {
    c.outputChannel?.appendLine(`Failed to stop client: ${e}`);
  }
}

async function startLanguageClient() {
  const config = loadConfiguration();
  const { client, goState } = await buildLanguageClient();
  ctx.languageClient = client;
  await client.start();
  // client.start() resolves after the Initialize handshake, so
  // initializeResult is available. Enable Go file navigation only if
  // both the proxy advertises support and the user has not disabled it.
  const proxySupportsGoFiles = hasGoFileSupport(client);
  goState.goFileSupport = config.goFileSupport && proxySupportsGoFiles;
  if (config.goFileSupport && !proxySupportsGoFiles) {
    vscode.window.showWarningMessage(
      "templ: Go file support is enabled in settings, but the templ binary does not support it. Update templ to enable cross-file navigation.",
    );
  }
}

// isGoDocument returns true if the document is a Go file on disk.
function isGoDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "go";
}

// hasGoFileSupport checks the Initialize response from the templ LSP to
// determine whether the proxy supports handling .go file requests for
// cross-file navigation. This allows the extension to work with both old
// and new versions of the templ binary.
function hasGoFileSupport(client: LanguageClient): boolean {
  const experimental = client.initializeResult?.capabilities?.experimental;
  return experimental?.templ?.goFileSupport === true;
}

interface GoFileState {
  goFileSupport: boolean;
}

interface BuildResult {
  client: LanguageClient;
  goState: GoFileState;
}

export async function buildLanguageClient(): Promise<BuildResult> {
  const config = loadConfiguration();

  // Register for both templ and Go files when goFileSupport is enabled.
  // Go files are included so the templ LSP proxy's internal gopls stays
  // in sync and can provide cross-file operations (e.g., renaming a Go
  // symbol updates templ files too). If the proxy does not advertise
  // goFileSupport, middleware blocks all features for Go files, making
  // registration harmless. If the user has disabled goFileSupport in
  // settings, Go files are not registered at all.
  const documentSelector = config.goFileSupport
    ? [
        { language: "templ", scheme: "file" },
        { language: "go", scheme: "file" },
      ]
    : [{ language: "templ", scheme: "file" }];
  const args: Array<string> = ["lsp"];
  if (config.goplsLog.length > 0) {
    args.push(`-goplsLog=${config.goplsLog}`);
  }
  if (config.goplsRPCTrace) {
    args.push(`-goplsRPCTrace=true`);
  }
  if (config.goplsRemote.length > 0) {
    args.push(`-gopls-remote=${config.goplsRemote}`);
  }
  if (config.noPreload) {
    args.push(`-no-preload=true`);
  }
  if (config.log.length > 0) {
    args.push(`-log=${config.log}`);
  }
  if (config.pprof) {
    args.push(`-pprof=true`);
  }
  if (config.http.length > 0) {
    args.push(`-http=${config.http}`);
  }

  const templPath = await findTempl();

  if (ctx.languageClient) {
    await stopLanguageClient();
  }

  vscode.window.setStatusBarMessage(
    `Starting LSP: ${templPath} ${args.join(" ")}`,
    3000,
  );

  const envTemplExperiments = process.env.TEMPL_EXPERIMENT;
  const templExperiments =
    config.experiments === "" ? envTemplExperiments : config.experiments;

  // Set to true after the Initialize handshake if the proxy supports Go file
  // navigation. Until then, middleware blocks all features for Go files.
  // This is mutated by startLanguageClient after client.start() resolves.
  const goState = { goFileSupport: false };

  const c = new CustomLanguageClient(
    "templ", // id
    "templ",
    {
      command: templPath,
      options: {
        env: {
          ...process.env,
          TEMPL_EXPERIMENT: templExperiments,
        },
      },
      args,
    },
    {
      documentSelector,
      initializationOptions: {},
      uriConverters: {
        // Apply file:/// scheme to all file paths.
        code2Protocol: (uri: vscode.Uri): string =>
          (uri.scheme ? uri : uri.with({ scheme: "file" })).toString(),
        protocol2Code: (uri: string) => vscode.Uri.parse(uri),
      },
      errorHandler: {
        error: (
          error: Error,
          message: Message,
          count: number,
        ): ErrorHandlerResult => {
          // Allow 5 crashes before shutdown.
          if (count < 5) {
            return { action: ErrorAction.Continue };
          }
          vscode.window.showErrorMessage(
            `Error communicating with the language server: ${error}: ${message}.`,
          );
          return { action: ErrorAction.Shutdown };
        },
        closed: (): CloseHandlerResult => ({
          action: CloseAction.DoNotRestart,
        }),
      },
      middleware: {
        // Block features for Go files that the Go extension already provides.
        // Navigation features (definition, references, rename, type definition,
        // implementation, call hierarchy) are allowed through only when the
        // proxy advertises goFileSupport, because the templ proxy converts
        // _templ.go locations to .templ locations.
        provideHover: (document, position, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, position, token);
        },
        provideDocumentFormattingEdits: async (
          document: vscode.TextDocument,
          options: vscode.FormattingOptions,
          token: vscode.CancellationToken,
          next: ProvideDocumentFormattingEditsSignature,
        ) => {
          if (isGoDocument(document)) return undefined;
          return next(document, options, token);
        },
        provideCompletionItem: async (
          document: vscode.TextDocument,
          position: vscode.Position,
          context: vscode.CompletionContext,
          token: vscode.CancellationToken,
          next: ProvideCompletionItemsSignature,
        ) => {
          if (isGoDocument(document)) return undefined;
          const list = await next(document, position, context, token);
          if (!list) {
            return list;
          }
          const items = Array.isArray(list) ? list : list.items;

          // Give all the candidates the same filterText to trick VSCode
          // into not reordering our candidates. All the candidates will
          // appear to be equally good matches, so VSCode's fuzzy
          // matching/ranking just maintains the natural "sortText"
          // ordering. We can only do this in tandem with
          // "incompleteResults" since otherwise client side filtering is
          // important.
          if (
            !Array.isArray(list) &&
            list.isIncomplete &&
            list.items.length > 1
          ) {
            let hardcodedFilterText = items[0].filterText;
            if (!hardcodedFilterText) {
              // tslint:disable:max-line-length
              // According to LSP spec,
              // https://microsoft.github.io/language-server-protocol/specifications/specification-current/#textDocument_completion
              // if filterText is falsy, the `label` should be used.
              // But we observed that's not the case.
              // Even if vscode picked the label value, that would
              // cause to reorder candidates, which is not ideal.
              // Force to use non-empty `label`.
              // https://github.com/golang/vscode-go/issues/441
              hardcodedFilterText = items[0].label.toString();
            }
            for (const item of items) {
              item.filterText = hardcodedFilterText;
            }
          }
          // TODO(hyangah): when v1.42+ api is available, we can simplify
          // language-specific configuration lookup using the new
          // ConfigurationScope.
          //    const paramHintsEnabled = vscode.workspace.getConfiguration(
          //          'editor.parameterHints',
          //          { languageId: 'go', uri: document.uri });
          const editorParamHintsEnabled = vscode.workspace.getConfiguration(
            "editor.parameterHints",
            document.uri,
          )["enabled"];
          const goParamHintsEnabled = vscode.workspace.getConfiguration(
            "[go]",
            document.uri,
          )["editor.parameterHints.enabled"];
          let paramHintsEnabled = false;
          if (typeof goParamHintsEnabled === "undefined") {
            paramHintsEnabled = editorParamHintsEnabled;
          } else {
            paramHintsEnabled = goParamHintsEnabled;
          }
          // If the user has parameterHints (signature help) enabled,
          // trigger it for function or method completion items.
          if (paramHintsEnabled) {
            for (const item of items) {
              if (
                item.kind === CompletionItemKind.Method ||
                item.kind === CompletionItemKind.Function
              ) {
                item.command = {
                  title: "triggerParameterHints",
                  command: "editor.action.triggerParameterHints",
                };
              }
            }
          }
          return list;
        },
        provideSignatureHelp: (document, position, context, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, position, context, token);
        },
        provideCodeActions: (document, range, context, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, range, context, token);
        },
        provideCodeLenses: (document, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, token);
        },
        provideDocumentHighlights: (document, position, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, position, token);
        },
        provideDocumentSymbols: (document, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, token);
        },
        provideDocumentLinks: (document, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, token);
        },
        provideDocumentSemanticTokens: (document, token, next) => {
          if (isGoDocument(document)) return undefined;
          return next(document, token);
        },
        provideDocumentSemanticTokensEdits: (
          document,
          previousResultId,
          token,
          next,
        ) => {
          if (isGoDocument(document)) return undefined;
          return next(document, previousResultId, token);
        },
        provideDocumentRangeSemanticTokens: (
          document,
          range,
          token,
          next,
        ) => {
          if (isGoDocument(document)) return undefined;
          return next(document, range, token);
        },
        // Navigation features: only forward for Go files when the proxy
        // advertises goFileSupport. Without it, the old proxy would return
        // nil for .go file navigation, giving the user no results.
        provideDefinition: (document, position, token, next) => {
          if (isGoDocument(document) && !goState.goFileSupport) return undefined;
          return next(document, position, token);
        },
        provideDeclaration: (document, position, token, next) => {
          if (isGoDocument(document) && !goState.goFileSupport) return undefined;
          return next(document, position, token);
        },
        provideReferences: (document, position, options, token, next) => {
          if (isGoDocument(document) && !goState.goFileSupport) return undefined;
          return next(document, position, options, token);
        },
        provideTypeDefinition: (document, position, token, next) => {
          if (isGoDocument(document) && !goState.goFileSupport) return undefined;
          return next(document, position, token);
        },
        provideImplementation: (document, position, token, next) => {
          if (isGoDocument(document) && !goState.goFileSupport) return undefined;
          return next(document, position, token);
        },
        provideRenameEdits: (document, position, newName, token, next) => {
          if (isGoDocument(document) && !goState.goFileSupport) return undefined;
          return next(document, position, newName, token);
        },
        prepareRename: (document, position, token, next) => {
          if (isGoDocument(document) && !goState.goFileSupport) return undefined;
          return next(document, position, token);
        },
        // Keep track of the last file change in order to not prompt
        // user if they are actively working.
        didOpen: async (e, next) => next(e),
        didChange: async (e, next) => next(e),
        didClose: (e, next) => next(e),
        didSave: (e, next) => next(e),
        workspace: {
          configuration: async (
            params: ConfigurationParams,
            token: CancellationToken,
            next: ConfigurationRequest.HandlerSignature,
          ): Promise<any[] | ResponseError<void>> => {
            const configs = await next(params, token);
            if (!configs || !Array.isArray(configs)) {
              return configs;
            }
            const ret = [] as any[];
            for (let i = 0; i < configs.length; i++) {
              ret.push(configs[i]);
            }
            return ret;
          },
        },
      },
    },
    false,
  );

  return { client: c, goState };
}
