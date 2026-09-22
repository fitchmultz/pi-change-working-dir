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
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as host from "@earendil-works/pi-coding-agent";
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "typebox";
import { registerCwdContext } from "./cwd-context.ts";

const ENTRY_TYPE = "change-working-dir";
const RESOLVE_CWD = "pi-change-working-dir:resolve-execution-cwd";
const SET_CWD = "pi-change-working-dir:set-execution-cwd";
const DEFAULT_PATH_TOOLS = new Set(["ls", "grep", "find"]);
const PATH_TOOLS = new Set(["read", "write", "edit", ...DEFAULT_PATH_TOOLS]);
const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

type DirectoryRequest = {
  sessionManager: ExtensionContext["sessionManager"];
  path?: unknown;
  result?: { cwd: string; error?: string };
};
type Invocation = { cwd: string; readFallback?: { bound: string; spaced: string } };
type RenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];

const expandTilde = (path: string): string =>
  path === "~" ? homedir()
    : path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"))
      ? homedir() + sep + path.slice(2) : path;

const tildify = (path: string): string =>
  path === homedir() ? "~" : path.startsWith(homedir() + sep) ? "~" + path.slice(homedir().length) : path;

const escapeControl = (path: string): string =>
  path.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x7f ? JSON.stringify(char).slice(1, -1) : `\\u${code.toString(16).padStart(4, "0")}`;
  });

const accessibleDirectory = (path: string): string | undefined => {
  try {
    if (!statSync(path).isDirectory()) return;
    const target = realpathSync.native(path);
    accessSync(target, constants.X_OK);
    return target;
  } catch {
    return;
  }
};

const sameDirectory = (left: string, right: string): boolean =>
  left === right || (accessibleDirectory(left) ?? left) === (accessibleDirectory(right) ?? right);

const assertAvailable = (cwd: string): void => {
  if (!accessibleDirectory(cwd)) {
    throw new Error(`Working directory unavailable: ${escapeControl(cwd)}. Restore it or use change_dir to select another directory.`);
  }
};

const operationPath = (path: string, cwd: string): string => {
  const expanded = path.startsWith("file://") ? fileURLToPath(path) : expandTilde(path);
  // DOS paths normalize before lookup; POSIX traversal must reach the filesystem intact.
  if (sep === "\\" && !/^\\\\[?.]\\/.test(expanded)) {
    const target = resolve(cwd, expanded);
    return /[\\/]$/.test(expanded) && !target.endsWith(sep) ? target + sep : target;
  }
  return isAbsolute(expanded) ? expanded : `${cwd}${sep}${expanded}`;
};

const bindPath = (path: unknown, cwd: string): unknown =>
  typeof path === "string" && path ? operationPath(path.startsWith("@") ? path.slice(1) : path, cwd) : path;

// The hosts' read-path helper is private. Preserve its ordered full-path variants,
// validating each with native traversal before canonicalization.
async function readTarget(path: string, spaced = path.replace(UNICODE_SPACES, " ")): Promise<string> {
  const nfd = spaced.normalize("NFD");
  const variants = new Set([path, spaced, spaced.replace(/ (AM|PM)\./gi, "\u202f$1."),
    nfd, spaced.replace(/'/g, "\u2019"), nfd.replace(/'/g, "\u2019")]);
  let failure: unknown;
  for (const candidate of variants) {
    try { await stat(candidate); } catch (error) { failure ??= error; continue; }
    return realpath(candidate);
  }
  throw failure;
}

// Official Pi has no target resolver export. Keep its default publisher, but validate
// each native parent/link before handing a canonical file URL to either host.
function fileTarget(path: string): string {
  const links = new Set<string>();
  for (;;) {
    if (path.endsWith(sep) || path.endsWith("/")) {
      statSync(path);
      return realpathSync.native(path);
    }
    const parentPath = dirname(path);
    if (!statSync(parentPath).isDirectory()) {
      throw Object.assign(new Error(`Not a directory: ${parentPath}`), { code: "ENOTDIR" });
    }
    const parent = realpathSync.native(parentPath);
    const target = join(parent, basename(path));
    let info;
    try { info = lstatSync(target); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return target;
    }
    if (!info.isSymbolicLink()) return realpathSync.native(target);
    if (links.has(target)) throw Object.assign(new Error(`Symlink cycle: ${target}`), { code: "ELOOP" });
    links.add(target);
    const link = readlinkSync(target);
    path = isAbsolute(link) ? link : `${parent}${sep}${link}`;
  }
}

// Discover queue identity without awaiting, creating parents, or admitting invalid I/O.
// Revisit symlinks after resolving absent components such as missing/../link.
function queueTarget(path: string, links = new Set<string>()): string {
  try { return realpathSync.native(path); } catch { /* Resolve prospective parents below. */ }
  const parentPath = dirname(path);
  if (parentPath === path) return path;
  const parent = queueTarget(parentPath, links);
  const target = join(parent, basename(path));
  try {
    if (lstatSync(target).isSymbolicLink()) {
      if (links.has(target)) return target;
      links.add(target);
      const link = readlinkSync(target);
      return queueTarget(isAbsolute(link) ? link : `${parent}${sep}${link}`, links);
    }
    return realpathSync.native(target);
  } catch { return target; }
}

// Reuse each host's publisher: the fork exports its atomic publisher; official Pi
// uses writeFile. The optional export is never required from official installations.
const publishFile = (host as typeof host & {
  publishLocalFile?: (path: string, content: string, signal?: AbortSignal) => Promise<void>;
}).publishLocalFile;

export default function (pi: ExtensionAPI & {
  registerBashCwdHook?: (hook: (cwd: string) => string) => void;
}) {
  let context: ExtensionContext | undefined;
  let manager: ExtensionContext["sessionManager"] | undefined;
  let directory: string | undefined;
  let savedDirectory: string | undefined;
  let savedStateValid = true;
  let toolsInstalled = false;
  let localBash = createLocalBashOperations();
  const ownedTools = new Map<string, string>();
  const invocations = new WeakMap<object, Invocation>();
  const renderCalls = new Map<string, RenderContext>();
  const hasNativeBashCwd = typeof pi.registerBashCwdHook === "function";

  const current = (ctx: ExtensionContext): string => directory ?? ctx.cwd;
  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("cwd", directory ? `cwd: ${tildify(directory)}` : undefined);
  };
  const recordContext = registerCwdContext(pi, (ctx) => {
    initialize(ctx);
    return current(ctx);
  });

  const restore = (ctx: ExtensionContext) => {
    directory = undefined;
    savedDirectory = undefined;
    savedStateValid = true;
    const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === ENTRY_TYPE);
    const data = entry?.type === "custom" ? entry.data : undefined;
    const saved = data && typeof data === "object" ? (data as { dir?: unknown }).dir : undefined;
    let notice: string | undefined;
    if ((entry && (data === null || typeof data !== "object"))
      || (saved !== undefined && (typeof saved !== "string" || !isAbsolute(saved)))) {
      savedStateValid = false;
      notice = "Ignoring an invalid saved working directory; using the session directory.";
    } else if (typeof saved === "string") {
      savedDirectory = saved;
      const target = accessibleDirectory(saved);
      if (target && escapeControl(target) === target) {
        directory = sameDirectory(target, ctx.cwd) ? undefined : target;
      } else {
        notice = `Saved working directory unavailable or unsupported; using the session directory: ${escapeControl(saved)}`;
      }
    }
    if (notice && ctx.hasUI) ctx.ui.notify(notice, "warning");
    updateStatus(ctx);
    recordContext(ctx, current(ctx), notice);
  };

  const change = (path: unknown, ctx: ExtensionContext): string => {
    initialize(ctx);
    if (typeof path !== "string" || !path) throw new Error("Path is required");
    const requested = operationPath(path, current(ctx));
    const target = accessibleDirectory(requested);
    if (!target) throw new Error(`Not an accessible directory: ${escapeControl(requested)}`);
    if (escapeControl(target) !== target) {
      throw new Error(`Directory paths with control characters are not supported: ${escapeControl(target)}`);
    }
    const next = sameDirectory(target, ctx.cwd) ? undefined : target;
    if (next !== directory || next !== savedDirectory || !savedStateValid) {
      directory = next;
      savedDirectory = next;
      savedStateValid = true;
      // Native appends are accepted in memory before journal I/O; never retry the append.
      try {
        pi.appendEntry(ENTRY_TYPE, { dir: next });
      } finally {
        updateStatus(ctx);
        recordContext(ctx, target, undefined, true);
      }
    }
    return target;
  };

  const bindInvocation = (name: string, input: Record<string, unknown>, cwd: string) => {
    assertAvailable(cwd);
    const rawPath = input.path;
    if (PATH_TOOLS.has(name)) {
      input.path = DEFAULT_PATH_TOOLS.has(name) && (input.path === undefined || input.path === "")
        ? cwd : bindPath(input.path, cwd);
    }
    // Normalize the requested spelling, never Unicode spaces in a captured cwd.
    const readFallback = name === "read" && typeof rawPath === "string" && typeof input.path === "string"
      ? { bound: input.path, spaced: bindPath(rawPath.replace(UNICODE_SPACES, " "), cwd) as string } : undefined;
    invocations.set(input, { cwd, readFallback });
  };

  const wrap = (definition: ToolDefinition<any, any, any>): ToolDefinition<any, any, any> => ({
    ...definition,
    async execute(id, value, signal, onUpdate, ctx) {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected tool arguments");
      const params = value as Record<string, unknown>;
      initialize(ctx);
      if (!invocations.has(params)) bindInvocation(definition.name, params, current(ctx));
      const { cwd, readFallback } = invocations.get(params)!;
      assertAvailable(cwd);
      const path = PATH_TOOLS.has(definition.name) && typeof params.path === "string" ? params.path : undefined;
      try {
        signal?.throwIfAborted();
        let target: string | undefined;
        let delegate = definition;
        let delegatedPath: string | undefined;
        const showTarget = (value?: string) => {
          target = value;
          const rendering = renderCalls.get(id);
          if (rendering) {
            rendering.state.workingDirectory = cwd;
            rendering.state.workingTarget = value;
            rendering.invalidate();
          }
        };
        const mutation = definition.name === "write" || definition.name === "edit";
        if (!path) showTarget();
        if (path && mutation) {
          // Factory execution registers its queue before any asynchronous preparation.
          delegatedPath = pathToFileURL(queueTarget(path)).href;
          if (definition.name === "edit") {
            try { statSync(path); showTarget(fileTarget(path)); } catch { /* Missing previews wait for queued validation. */ }
          }
          const publish = async (_path: string, content: string) => {
            signal?.throwIfAborted();
            const publishedTarget = fileTarget(path);
            showTarget(publishedTarget);
            if (publishFile) await publishFile(publishedTarget, content, signal);
            else await writeFile(publishedTarget, content, "utf8");
          };
          delegate = definition.name === "write"
            ? createWriteToolDefinition(cwd, { operations: {
              mkdir: async () => { await mkdir(dirname(path), { recursive: true }); },
              writeFile: publish,
            } })
            : createEditToolDefinition(cwd, { operations: {
              access: async () => {
                await access(path, constants.R_OK | constants.W_OK);
                await stat(path);
                signal?.throwIfAborted();
                showTarget(await realpath(path));
              },
              readFile: async () => readFile(path),
              writeFile: publish,
            } });
        } else if (path) {
          if (definition.name === "read") {
            showTarget(await readTarget(path, readFallback?.bound === path ? readFallback.spaced : undefined));
          } else {
            await stat(path);
            showTarget(await realpath(path));
          }
          delegatedPath = pathToFileURL(target!).href;
        }
        signal?.throwIfAborted();
        // File URLs bypass host Unicode-space rewriting as well as lexical traversal.
        const input = delegatedPath ? { ...params, path: delegatedPath } : params;
        const executionContext = Object.create(ctx, { cwd: { value: cwd, enumerable: true } }) as ExtensionContext;
        const result = await delegate.execute(id, input, signal, onUpdate, executionContext).catch((error: unknown) => {
          if (error instanceof Error && delegatedPath && path) {
            error.message = error.message.replaceAll(delegatedPath, target ?? path);
          }
          throw error;
        });
        // Only generated summaries/hints contain delegated URLs; never rewrite file contents.
        if (delegatedPath && target && (mutation || result.details?.truncation?.firstLineExceedsLimit)) {
          const displayPath = mutation ? target : `'${target.replaceAll("'", "'\\''")}'`;
          result.content = result.content.map((block) => block.type === "text"
            ? { ...block, text: block.text.replaceAll(delegatedPath, displayPath) } : block);
          const header = `--- ${delegatedPath}\n+++ ${delegatedPath}\n`;
          if (typeof result.details?.patch === "string" && result.details.patch.startsWith(header)) {
            result.details.patch = `--- ${target}\n+++ ${target}\n${result.details.patch.slice(header.length)}`;
          }
        }
        return {
          ...result,
          details: { ...result.details, workingDirectory: cwd, ...(path ? { workingPath: path, workingTarget: target } : {}) },
        };
      } finally {
        renderCalls.delete(id);
      }
    },
    ...(definition.renderCall ? {
      renderCall(args, theme, ctx: RenderContext) {
        if (!ctx.state.workingDirectory) renderCalls.set(ctx.toolCallId, ctx);
        // Native edit uses path for preview I/O and the legacy alias for its label.
        const bound = ctx.state.workingTarget && args && typeof args === "object"
          ? { ...args, path: definition.name === "edit" ? pathToFileURL(ctx.state.workingTarget).href : ctx.state.workingTarget,
            file_path: ctx.state.workingTarget } : args;
        return definition.renderCall!(bound, theme, {
          ...ctx,
          cwd: ctx.state.workingDirectory ?? ctx.cwd,
          invalidate() {
            const preview = definition.name === "edit" && ctx.state.callComponent?.preview;
            if (typeof preview?.error === "string" && ctx.state.workingTarget) {
              preview.error = preview.error.replaceAll(pathToFileURL(ctx.state.workingTarget).href, ctx.state.workingTarget);
            }
            ctx.invalidate();
          },
          // Argument completion precedes native preflight; don't preview the wrong file.
          argsComplete: ctx.argsComplete && Boolean(ctx.state.workingDirectory),
        });
      },
    } : {}),
    ...(definition.renderResult ? {
      renderResult(result, options, theme, ctx: RenderContext) {
        const details = result.details as { workingDirectory?: string; workingPath?: string; workingTarget?: string } | undefined;
        if (details?.workingDirectory) {
          ctx.state.workingDirectory = details.workingDirectory;
          ctx.state.workingTarget = details.workingTarget ?? details.workingPath;
        }
        renderCalls.delete(ctx.toolCallId);
        return definition.renderResult!(result, options, theme, {
          ...ctx,
          cwd: ctx.state.workingDirectory ?? ctx.cwd,
          args: ctx.state.workingTarget && ctx.args && typeof ctx.args === "object"
            ? { ...ctx.args, path: definition.name === "edit" ? pathToFileURL(ctx.state.workingTarget).href : ctx.state.workingTarget,
              file_path: ctx.state.workingTarget } : ctx.args,
        });
      },
    } : {}),
  });

  const installTools = (ctx: ExtensionContext) => {
    if (toolsInstalled) return;
    toolsInstalled = true;
    const settings = SettingsManager.create(ctx.cwd, undefined, { projectTrusted: ctx.isProjectTrusted() });
    const shellPath = settings.getShellPath();
    localBash = createLocalBashOperations({ shellPath });
    const definitions = [
      createReadToolDefinition(ctx.cwd, { autoResizeImages: settings.getImageAutoResize() }),
      createWriteToolDefinition(ctx.cwd),
      createEditToolDefinition(ctx.cwd),
      createLsToolDefinition(ctx.cwd),
      createFindToolDefinition(ctx.cwd),
      createGrepToolDefinition(ctx.cwd),
      createBashToolDefinition(ctx.cwd, { shellPath, commandPrefix: settings.getShellCommandPrefix() }),
      createPowerShellToolDefinition(ctx.cwd),
    ];
    const nativeTools = new Set(pi.getAllTools().filter((tool) => tool.sourceInfo.source === "builtin").map((tool) => tool.name));
    const activeTools = pi.getActiveTools();
    for (const definition of definitions) {
      if (!nativeTools.has(definition.name)) continue;
      pi.registerTool(wrap(definition));
      const installed = pi.getAllTools().find((tool) => tool.name === definition.name);
      if (installed) ownedTools.set(definition.name, installed.sourceInfo.path);
    }
    pi.setActiveTools(activeTools);
  };

  function initialize(ctx: ExtensionContext) {
    context = ctx;
    if (manager === ctx.sessionManager) return;
    manager = ctx.sessionManager;
    installTools(ctx);
    restore(ctx);
  }

  pi.on("session_start", (_event, ctx) => {
    const initialized = manager === ctx.sessionManager;
    initialize(ctx);
    if (initialized) restore(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    initialize(ctx);
    restore(ctx);
  });
  pi.on("agent_end", () => renderCalls.clear());
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("cwd", undefined);
    context = undefined;
    manager = undefined;
    renderCalls.clear();
  });

  for (const event of [RESOLVE_CWD, SET_CWD]) {
    pi.events.on(event, (value) => {
      if (!value || typeof value !== "object" || !context) return;
      const request = value as DirectoryRequest;
      if (request.sessionManager !== manager) return;
      try {
        const cwd = event === SET_CWD ? change(request.path, context) : current(context);
        assertAvailable(cwd);
        request.result = { cwd };
      } catch (error) {
        request.result = { cwd: current(context), error: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  if (hasNativeBashCwd) pi.registerBashCwdHook!((cwd) => directory ?? cwd);
  pi.on("user_bash", (_event, ctx) => {
    initialize(ctx);
    if (hasNativeBashCwd || !directory) return;
    const cwd = current(ctx);
    assertAvailable(cwd);
    return { operations: { exec: (command, _cwd, options) => localBash.exec(command, cwd, options) } };
  });

  pi.on("tool_call", (event, ctx) => {
    initialize(ctx);
    const owner = ownedTools.get(event.toolName);
    if (owner && pi.getAllTools().find((tool) => tool.name === event.toolName)?.sourceInfo.path === owner) {
      bindInvocation(event.toolName, event.input, current(ctx));
    }
  });

  (pi.on as unknown as (event: "session_checkpoint", handler: (event: unknown, ctx: ExtensionContext) => {
    sleepReady: boolean; reason?: string;
  }) => void)("session_checkpoint", (_event, ctx) => {
    const entry = ctx.sessionManager.getBranch().findLast((item) => item.type === "custom" && item.customType === ENTRY_TYPE);
    const data = entry?.type === "custom" ? entry.data as { dir?: unknown } | null : undefined;
    const saved = data?.dir;
    const target = typeof saved === "string" && isAbsolute(saved) ? accessibleDirectory(saved) : undefined;
    const restored = target && escapeControl(target) === target && !sameDirectory(target, ctx.cwd) ? target : undefined;
    return restored === directory ? { sleepReady: true }
      : { sleepReady: false, reason: "Working directory differs from the selected branch restore" };
  });

  pi.registerTool({
    name: "change_dir",
    label: "Change Directory",
    description: "Change the directory for subsequent file, shell, search, edit, and cooperating extension calls. Persists on this session branch. Accepts absolute, ~, or relative paths. Project settings and session identity stay unchanged.",
    promptSnippet: "Change the working directory for subsequent tool calls",
    promptGuidelines: ["Use change_dir once before dependent tools when moving to another directory. Direct sibling calls run in source order; never put change_dir in an explicit parallel batch."],
    parameters: Type.Object({ path: Type.String({ minLength: 1, description: "Directory to switch to" }) }, { additionalProperties: false }),
    constrainedSampling: { type: "json_schema", strict: "prefer" },
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = change(params.path, ctx);
      return { content: [{ type: "text", text: `Working directory: ${cwd}` }], details: { cwd } };
    },
  });
  pi.registerCommand("cwd", {
    description: "Show or change the working directory: /cwd [path|-]",
    async handler(args, ctx) {
      initialize(ctx);
      const path = args.trim();
      if (!path) {
        ctx.ui.notify(`Working directory: ${escapeControl(current(ctx))}${directory ? ` (session: ${escapeControl(ctx.cwd)})` : ""}`, "info");
        return;
      }
      try {
        ctx.ui.notify(`Working directory: ${change(path === "-" ? ctx.cwd : path, ctx)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
