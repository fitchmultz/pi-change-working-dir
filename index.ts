import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLocalBashOperations,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SettingsManager,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { assertAvailable, escapeControl, isRecord } from "./native-paths.ts";
import { createSelection } from "./selection.ts";
import { createToolBinder, type ToolBinder, type WrappedDetails } from "./tool-wrapper.ts";

const RESOLVE_CWD = "pi-change-working-dir:resolve-execution-cwd";
const SET_CWD = "pi-change-working-dir:set-execution-cwd";

type DirectoryRequest = {
  sessionManager: ExtensionContext["sessionManager"];
  path?: unknown;
  result?: { cwd: string; error?: string | undefined } | undefined;
};

type InstallDeps = {
  pi: ExtensionAPI;
  binder: ToolBinder;
  ctx: ExtensionContext;
  settings: SettingsManager;
  ownedTools: Map<string, string>;
};

type AdmissionDeps = {
  pi: ExtensionAPI;
  selection: ReturnType<typeof createSelection>;
  binder: ToolBinder;
  ownedTools: Map<string, string>;
  gate: FailureGate;
  shell: ShellState;
};

type ShellState = {
  configure: (settings: SettingsManager) => void;
  operations: () => BashOperations;
};

type FailureGate = {
  failed: () => boolean;
  trip: () => void;
  reset: () => void;
};

function isDirectoryRequest(value: Record<string, unknown>): value is DirectoryRequest {
  return "sessionManager" in value;
}

/** The message of a thrown value, whatever shape it has. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tracks whether a change_dir failure should block the rest of its tool batch. */
function createFailureGate(): FailureGate {
  let failed = false;
  return {
    failed: () => failed,
    trip: () => {
      failed = true;
    },
    reset: () => {
      failed = false;
    },
  };
}

/** The shell operations user_bash rebinds to the selected directory. */
function createShellState(): ShellState {
  let operations = createLocalBashOperations();
  return {
    configure: (settings: SettingsManager) => {
      const shellPath = settings.getShellPath();
      operations =
        shellPath === undefined
          ? createLocalBashOperations()
          : createLocalBashOperations({ shellPath });
    },
    operations: () => operations,
  };
}

/** Wrap and register one native tool, tracking the source it was installed from. */
function registerWrapped<TParams extends TSchema, TDetails extends WrappedDetails, TState>(
  pi: ExtensionAPI,
  binder: ToolBinder,
  definition: ToolDefinition<TParams, TDetails, TState>,
  ownedTools: Map<string, string>,
): void {
  pi.registerTool(binder.wrap(definition));
  const installed = pi.getAllTools().find((tool) => tool.name === definition.name);
  if (installed !== undefined) {
    ownedTools.set(definition.name, installed.sourceInfo.path);
  }
}

/** The wrapped native tools, each installed under its own concrete type. */
function nativeDefinitions(deps: InstallDeps): { name: string; install: () => void }[] {
  const { pi, binder, ctx, settings, ownedTools } = deps;
  const shellPath = settings.getShellPath();
  const commandPrefix = settings.getShellCommandPrefix();
  return [
    {
      name: "read",
      install: () =>
        registerWrapped(
          pi,
          binder,
          createReadToolDefinition(ctx.cwd, { autoResizeImages: settings.getImageAutoResize() }),
          ownedTools,
        ),
    },
    {
      name: "write",
      install: () => registerWrapped(pi, binder, createWriteToolDefinition(ctx.cwd), ownedTools),
    },
    {
      name: "edit",
      install: () => registerWrapped(pi, binder, createEditToolDefinition(ctx.cwd), ownedTools),
    },
    {
      name: "ls",
      install: () => registerWrapped(pi, binder, createLsToolDefinition(ctx.cwd), ownedTools),
    },
    {
      name: "find",
      install: () => registerWrapped(pi, binder, createFindToolDefinition(ctx.cwd), ownedTools),
    },
    {
      name: "grep",
      install: () => registerWrapped(pi, binder, createGrepToolDefinition(ctx.cwd), ownedTools),
    },
    {
      name: "bash",
      install: () =>
        registerWrapped(
          pi,
          binder,
          createBashToolDefinition(ctx.cwd, {
            ...(shellPath === undefined ? {} : { shellPath }),
            ...(commandPrefix === undefined ? {} : { commandPrefix }),
          }),
          ownedTools,
        ),
    },
    {
      name: "powershell",
      install: () =>
        registerWrapped(pi, binder, createPowerShellToolDefinition(ctx.cwd), ownedTools),
    },
  ];
}

/** Installs the wrapped native tools once, preserving the active tool set. */
function createInstaller(
  pi: ExtensionAPI,
  binder: ToolBinder,
  ownedTools: Map<string, string>,
  shell: ShellState,
): { install: (ctx: ExtensionContext) => void } {
  let toolsInstalled = false;
  return {
    install: (ctx: ExtensionContext) => {
      if (toolsInstalled) {
        return;
      }
      toolsInstalled = true;
      const settings = SettingsManager.create(ctx.cwd, undefined, {
        projectTrusted: ctx.isProjectTrusted(),
      });
      shell.configure(settings);
      const nativeTools = new Set(
        pi
          .getAllTools()
          .filter((tool) => tool.sourceInfo.source === "builtin")
          .map((tool) => tool.name),
      );
      const activeTools = pi.getActiveTools();
      for (const definition of nativeDefinitions({ pi, binder, ctx, settings, ownedTools })) {
        if (nativeTools.has(definition.name)) {
          definition.install();
        }
      }
      pi.setActiveTools(activeTools);
    },
  };
}

/** Session lifecycle: rebind on switch, restore on reuse, clear status on shutdown. */
function registerLifecycle(
  pi: ExtensionAPI,
  selection: ReturnType<typeof createSelection>,
  binder: ToolBinder,
  gate: FailureGate,
): void {
  pi.on("session_start", (_event, ctx) => {
    if (selection.attach(ctx)) {
      selection.restore(ctx);
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    selection.attach(ctx);
    selection.restore(ctx);
  });
  pi.on("turn_start", () => {
    gate.reset();
  });
  pi.on("agent_end", () => {
    gate.reset();
    binder.dispose();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("cwd", undefined);
    }
    selection.reset();
    binder.dispose();
  });
}

/** The resolve/set channels cooperating extensions use to join the selected directory. */
function registerChannels(pi: ExtensionAPI, selection: ReturnType<typeof createSelection>): void {
  for (const event of [RESOLVE_CWD, SET_CWD]) {
    pi.events.on(event, (value) => {
      const ctx = selection.context();
      if (!isRecord(value) || !isDirectoryRequest(value) || ctx === undefined) {
        return;
      }
      const request = value;
      if (request.sessionManager !== ctx.sessionManager) {
        return;
      }
      let outcome: { cwd: string; error?: string | undefined };
      try {
        const cwd =
          event === SET_CWD ? selection.change(request.path, ctx) : selection.current(ctx);
        assertAvailable(cwd);
        outcome = { cwd };
      } catch (error) {
        outcome = { cwd: selection.current(ctx), error: errorMessage(error) };
      }
      request.result = outcome;
    });
  }
}

/** Admission hooks: bash rebinds, owned tools capture invocations, failures gate batches. */
function registerAdmission(deps: AdmissionDeps): void {
  const { pi, selection, binder, ownedTools, gate, shell } = deps;
  pi.on("user_bash", (_event, ctx) => {
    selection.attach(ctx);
    const cwd = selection.current(ctx);
    if (cwd === ctx.cwd) {
      return;
    }
    assertAvailable(cwd);
    return {
      operations: {
        exec: (command, _cwd, options) => shell.operations().exec(command, cwd, options),
      },
    };
  });
  pi.on("tool_call", (event, ctx) => {
    if (gate.failed()) {
      return {
        block: true,
        reason: "Skipped because change_dir failed earlier in this tool batch.",
      };
    }
    if ("namespace" in event && event.namespace !== undefined) {
      return;
    }
    selection.attach(ctx);
    const owner = ownedTools.get(event.toolName);
    const installed = pi.getAllTools().find((tool) => tool.name === event.toolName);
    if (owner !== undefined && installed?.sourceInfo.path === owner) {
      binder.bind(event.toolName, event.input, selection.current(ctx));
    }
    return;
  });
  pi.on("tool_execution_end", (event) => {
    if (
      event.toolName === "change_dir" &&
      !("namespace" in event && event.namespace !== undefined) &&
      event.isError
    ) {
      gate.trip();
    }
  });
}

/** The change_dir tool that rebinds subsequent tool calls to the selected directory. */
function registerChangeDir(pi: ExtensionAPI, selection: ReturnType<typeof createSelection>): void {
  pi.registerTool({
    name: "change_dir",
    label: "Change Directory",
    description:
      "Change the directory for subsequent file, shell, search, edit, and cooperating extension calls. Persists on this session branch. Accepts absolute, ~, or relative paths. Project settings and session identity stay unchanged.",
    promptSnippet: "Change the working directory for subsequent tool calls",
    promptGuidelines: [
      "To work in another directory, put change_dir first in the same response as the calls that need it. That response's calls run one at a time in the order written; if change_dir fails, the later calls are skipped. In a script, await change_dir before dependent calls; never put it in a parallel wrapper such as Promise.all.",
    ],
    parameters: Type.Object(
      { path: Type.String({ minLength: 1, description: "Directory to switch to" }) },
      { additionalProperties: false },
    ),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    // oxlint-disable-next-line max-params -- QX-002: the host tool execute signature fixes five positional parameters.
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const cwd = selection.change(params.path, ctx);
      return { content: [{ type: "text", text: `Working directory: ${cwd}` }], details: { cwd } };
    },
  });
}

/** The /cwd command: show the current selection or switch and reset it. */
function registerCwdCommand(pi: ExtensionAPI, selection: ReturnType<typeof createSelection>): void {
  pi.registerCommand("cwd", {
    description: "Show or change the working directory: /cwd [path|-]",
    async handler(args, ctx) {
      selection.attach(ctx);
      const path = args.trim();
      if (path === "") {
        const suffix =
          selection.current(ctx) === ctx.cwd ? "" : ` (session: ${escapeControl(ctx.cwd)})`;
        ctx.ui.notify(
          `Working directory: ${escapeControl(selection.current(ctx))}${suffix}`,
          "info",
        );
        return;
      }
      try {
        ctx.ui.notify(
          `Working directory: ${selection.change(path === "-" ? ctx.cwd : path, ctx, path === "-")}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(errorMessage(error), "error");
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  const ownedTools = new Map<string, string>();
  const gate = createFailureGate();
  const shell = createShellState();
  const selection = createSelection(pi, (ctx) => {
    installer.install(ctx);
    selection.restore(ctx);
  });
  const binder = createToolBinder(selection);
  const installer = createInstaller(pi, binder, ownedTools, shell);
  registerLifecycle(pi, selection, binder, gate);
  registerChannels(pi, selection);
  registerAdmission({ pi, selection, binder, ownedTools, gate, shell });
  registerChangeDir(pi, selection);
  registerCwdCommand(pi, selection);
}
