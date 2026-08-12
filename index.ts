/**
 * pi-change-working-dir: let the agent (and user) change the session's
 * effective working directory without restarting pi.
 *
 * pi bakes the session cwd into its built-in tools at session start. This
 * extension keeps a "virtual cwd" and rewrites tool inputs on the fly:
 *   - bash: prepends `cd <dir> || exit 1`
 *   - built-in and FFF file/search tools: resolve relative paths against the dir
 *   - apply_edits/subagent: rewrites their cwd-bearing inputs
 *   - `!` user bash: runs in the dir
 *   - pi.exec / child_process.spawn: session cwd or omitted cwd → virtual cwd
 * The dir persists on each session branch (survives resume/fork/reload/tree) and is shown
 * in the footer. `change_dir` tool for the agent, `/cwd [path]` for the user.
 */
import {
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof import("node:child_process");

const ENTRY_TYPE = "change-working-dir";
const FFF_TOOLS = new Set(["ffgrep", "fffind"]);
/** Tools whose `path` param resolves against the session cwd. */
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find", ...FFF_TOOLS]);
/** Path tools where `path` is optional and defaults to the session cwd. */
const DEFAULT_PATH_TOOLS = new Set(["ls", "grep", "find", ...FFF_TOOLS]);

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
const fffNoFallbackPattern = (pattern: string): string => {
  if (/[.*+?^${}()|[\]\\]/.test(pattern)) {
    try {
      new RegExp(pattern);
      return pattern;
    } catch {
      // Treat malformed regex syntax literally.
    }
  }
  return `(?:${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`;
};

const fffCursorFromOutput = (toolName: string, text: string, hasMore: boolean): string | undefined => {
  const output = text.trimEnd();
  const start = output.lastIndexOf("\n\n[");
  if (start < 0 || !output.endsWith("]")) return;
  const notice = output.slice(start + 3, -1);
  return toolName === "ffgrep"
    ? notice.match(/(?:^|\. )Continue with cursor="(fff_c\d+)"$/)?.[1]
    : hasMore ? notice.match(/^\d+ more match(?:es)? available\. cursor="(\d+)" to continue$/)?.[1] : undefined;
};

const expandTilde = (p: string) =>
  p === "~" ? homedir()
  : p.startsWith("~/") || (sep === "\\" && p.startsWith("~\\")) ? homedir() + sep + p.slice(2)
  : p;

const tildify = (p: string) =>
  p === homedir() ? "~" : p.startsWith(homedir() + sep) ? "~" + p.slice(homedir().length) : p;

const escapeControl = (p: string) =>
  p.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x7f
      ? JSON.stringify(char).slice(1, -1)
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const hasUnsafeFffSuffix = (path: string): boolean => {
  let current = path;
  while (!isDirectory(current)) {
    const segment = basename(current);
    if (/\s/.test(segment) || segment.startsWith("!")) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
};

const accessibleDirectory = (path: string): string | undefined => {
  try {
    const real = realpathSync(path);
    if (!isDirectory(real)) return;
    accessSync(real, constants.X_OK);
    return real;
  } catch {
    return;
  }
};

const spawnPath = (cwd: unknown): string | undefined => {
  if (typeof cwd === "string") return cwd;
  if (cwd instanceof URL) return fileURLToPath(cwd);
};

const sameDirectory = (left: string, right: string): boolean =>
  left === right || (accessibleDirectory(left) ?? left) === (accessibleDirectory(right) ?? right);

const SPAWN_PATCH = Symbol.for("pi-change-working-dir.spawn.v1");
// Last writer wins: one live extension instance per process.
type SpawnHolder = { current: () => { vcwd?: string; sessionCwd?: string }; patched?: true };
const spawnHolder = (): SpawnHolder => {
  const g = globalThis as typeof globalThis & { [SPAWN_PATCH]?: SpawnHolder };
  return (g[SPAWN_PATCH] ??= { current: () => ({}) });
};

const patchSpawn = () => {
  const holder = spawnHolder();
  if (holder.patched) return;
  holder.patched = true;
  const spawn = childProcess.spawn as (...args: unknown[]) => ReturnType<typeof childProcess.spawn>;
  // ponytail: spawn only; patch exec/execFile/Bun.spawn if those show up
  childProcess.spawn = function (this: unknown, command: string, ...rest: unknown[]) {
    const { vcwd, sessionCwd } = holder.current();
    const i = Array.isArray(rest[0]) || rest[0] == null ? 1 : 0;
    const opts = rest[i];
    if (vcwd && (opts === undefined || (opts !== null && typeof opts === "object" && !Array.isArray(opts)))) {
      const options = opts as { cwd?: unknown } | undefined;
      const cwd = spawnPath(options?.cwd);
      if (options?.cwd == null || options.cwd === "" || (cwd && sessionCwd && sameDirectory(cwd, sessionCwd))) {
        rest[i] = { ...(options ?? {}), cwd: vcwd };
      }
    }
    return spawn.apply(this, [command, ...rest]);
  } as typeof childProcess.spawn;
  syncBuiltinESMExports();
};

export default function (pi: ExtensionAPI) {
  /** Active working directory override; undefined = session default. */
  let vcwd: string | undefined;
  let sessionCwd: string | undefined;
  const readState = () => ({ vcwd, sessionCwd });
  const publish = () => {
    spawnHolder().current = readState;
    if (vcwd) patchSpawn();
  };
  publish();
  let persistedDir: string | undefined;
  let persistedStateValid = true;
  type FffCursorState = {
    path?: string;
    exclude?: string | string[];
    vcwd?: string;
    rebase: boolean;
  };
  const fffCursors = new Map<string, Map<string, FffCursorState>>([
    ["ffgrep", new Map()],
    ["fffind", new Map()],
  ]);
  const localBash = createLocalBashOperations();

  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("cwd", vcwd ? `cwd: ${tildify(vcwd)}` : undefined);
  };

  const rememberSession = (ctx: ExtensionContext) => {
    sessionCwd = accessibleDirectory(ctx.cwd) ?? ctx.cwd;
  };

  const changeDir = (path: string, ctx: ExtensionContext): string => {
    rememberSession(ctx);
    if (!path) throw new Error("Path is required");
    const requested = resolve(vcwd ?? ctx.cwd, expandTilde(path));
    const target = accessibleDirectory(requested);
    if (!target) throw new Error(`Not an accessible directory: ${escapeControl(requested)}`);
    const displayed = escapeControl(target);
    if (displayed !== target) {
      throw new Error(`Directory paths with control characters are not supported: ${displayed}`);
    }

    const next = sameDirectory(target, ctx.cwd) ? undefined : target;
    if (next !== vcwd || next !== persistedDir || !persistedStateValid) {
      vcwd = next;
      persistedDir = next;
      persistedStateValid = true;
      pi.appendEntry(ENTRY_TYPE, { dir: vcwd });
      updateStatus(ctx);
    }
    publish();
    return target;
  };

  const restoreDir = (ctx: ExtensionContext) => {
    rememberSession(ctx);
    vcwd = undefined;
    persistedDir = undefined;
    persistedStateValid = true;
    const branch = ctx.sessionManager.getBranch();
    let data: unknown;
    let found = false;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index]!;
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        data = entry.data;
        found = true;
        break;
      }
    }

    const saved = data && typeof data === "object" ? (data as { dir?: unknown }).dir : undefined;
    if ((found && (data === null || typeof data !== "object"))
      || (saved !== undefined && (typeof saved !== "string" || !isAbsolute(saved)))) {
      persistedStateValid = false;
      if (ctx.hasUI) ctx.ui.notify("Ignoring an invalid saved working directory; using the session directory", "warning");
    } else if (typeof saved === "string") {
      persistedDir = saved;
      const target = accessibleDirectory(saved);
      if (target && escapeControl(target) === target) {
        vcwd = sameDirectory(target, ctx.cwd) ? undefined : target;
      } else if (ctx.hasUI) {
        ctx.ui.notify(`Saved working directory unavailable or unsupported; using the session directory: ${escapeControl(saved)}`, "warning");
      }
    }
    updateStatus(ctx);
    publish();
  };

  // Restore the active branch's persisted dir on startup/resume/fork and tree navigation.
  pi.on("session_start", (_event, ctx) => restoreDir(ctx));
  pi.on("session_tree", (_event, ctx) => restoreDir(ctx));
  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("cwd", undefined);
    const holder = spawnHolder();
    if (holder.current === readState) holder.current = () => ({});
  });

  pi.registerTool({
    name: "change_dir",
    label: "Change Directory",
    description:
      "Change the working directory for subsequent filesystem, shell, search, edit, and subagent calls. Persists on the session branch. Accepts absolute, ~, or relative paths. Direct siblings run there in source order; do not use in an explicit parallel batch.",
    promptSnippet: "Change the working directory for subsequent tool calls",
    promptGuidelines: [
      "Use change_dir once when moving to another directory, then use bare commands and relative paths. Call it before dependent tools and never in an explicit parallel batch.",
    ],
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Directory to switch to" }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = changeDir(params.path, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Working directory changed to ${target}. Subsequent tools resolve there — no cd prefix needed.`,
          },
        ],
        details: {},
      };
    },
  });

  // Rewrite tool inputs to honor the virtual cwd.
  pi.on("tool_call", (event, ctx) => {
    if (FFF_TOOLS.has(event.toolName)) {
      const input = event.input as { path?: string; exclude?: string | string[]; cursor?: string };
      if (input.cursor) {
        const resumed = fffCursors.get(event.toolName)!.get(input.cursor);
        if (!resumed) return { block: true, reason: "Unknown FFF cursor; repeat the search without a cursor" };
        if (resumed.vcwd !== vcwd) {
          return { block: true, reason: "FFF cursor belongs to a different working directory; repeat the search without a cursor" };
        }
        input.path = resumed.path;
        input.exclude = Array.isArray(resumed.exclude) ? [...resumed.exclude] : resumed.exclude;
        return;
      }
    }
    if (!vcwd) return;
    const dir = vcwd;
    const rewrite = (p: unknown, stripAtPrefix = false): unknown => {
      if (typeof p !== "string" || !p) return p;
      const hadAtPrefix = stripAtPrefix && p.startsWith("@");
      const raw = hadAtPrefix ? p.slice(1) : p;
      const clean = raw.startsWith("file://") ? fileURLToPath(raw) : expandTilde(raw);
      if (!isAbsolute(clean)) return resolve(dir, clean);
      return hadAtPrefix && clean === raw ? p : clean;
    };
    const relativeToSession = (p: string): string | undefined => {
      const scoped = relative(ctx.cwd, p);
      if (scoped === "") return "";
      if (scoped === ".." || scoped.startsWith(`..${sep}`) || isAbsolute(scoped)) return;
      return scoped.split(sep).join("/");
    };
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      if (typeof input.command === "string") {
        input.command = `cd ${shellQuote(dir)} || exit 1\n${input.command}`;
      }
    } else if (PATH_TOOLS.has(event.toolName)) {
      const input = event.input as { path?: string; pattern?: string; exclude?: string | string[]; cursor?: string };
      const fff = FFF_TOOLS.has(event.toolName);
      const originalPath = input.path;
      const resolvedPath = DEFAULT_PATH_TOOLS.has(event.toolName) && (input.path === undefined || input.path === "")
        ? dir
        : rewrite(input.path, !fff) as string | undefined;
      const scopedPath = fff && resolvedPath ? relativeToSession(resolvedPath) : undefined;
      const unsafeFffPath = fff && (
        (typeof originalPath === "string" && !isAbsolute(expandTilde(originalPath))
          && (/\s/.test(originalPath) || originalPath.startsWith("!")))
        || (scopedPath !== undefined && (/\s/.test(scopedPath) || scopedPath.startsWith("!")))
        || (scopedPath === undefined && resolvedPath !== undefined && hasUnsafeFffSuffix(resolvedPath))
      );
      if (unsafeFffPath) {
        return { block: true, reason: "FFF cannot safely represent this path constraint; start Pi at the intended search root or use the built-in search tools" };
      }
      input.path = fff && scopedPath !== undefined
        && isDirectory(resolvedPath!)
        ? scopedPath ? `${scopedPath}/` : "./"
        : resolvedPath;

      const lastPathSegment = input.path?.split(/[\\/]/).pop() ?? "";
      if (event.toolName === "ffgrep" && typeof input.pattern === "string"
        && /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastPathSegment)) {
        input.pattern = fffNoFallbackPattern(input.pattern);
      }

      if (fff && input.exclude !== undefined) {
        const values = Array.isArray(input.exclude) ? input.exclude : [input.exclude];
        input.exclude = values
          .flatMap((value) => value.split(/[,\s]+/).filter(Boolean))
          .map((value) => {
            const negated = value.startsWith("!");
            const path = negated ? value.slice(1) : value;
            let rewritten = path;
            const resolved = rewrite(path) as string;
            const directory = isDirectory(resolved);
            if (scopedPath !== undefined && (/[\\/]/.test(path) || directory)) {
              const scoped = relativeToSession(resolved);
              if (scoped !== undefined && !/[,\s]/.test(scoped)) {
                rewritten = directory || /[\\/]$/.test(path) ? `${scoped}/` : scoped;
              }
            }
            return negated ? `!${rewritten}` : rewritten;
          });
      }
    } else if (event.toolName === "apply_edits") {
      // pi-apply-edits resolves relative paths against the session cwd
      const input = event.input as { path?: unknown; files?: Array<{ path?: unknown }> };
      input.path = rewrite(input.path);
      if (Array.isArray(input.files)) {
        for (const f of input.files) if (f && typeof f === "object") f.path = rewrite(f.path);
      }
    } else if (event.toolName === "subagent") {
      // pi-subagents resolves all nested cwd values from its top-level cwd.
      const input = event.input as { cwd?: unknown };
      input.cwd = input.cwd === undefined || input.cwd === "" ? dir : rewrite(input.cwd);
    }
  });

  // FFF indexes the immutable session cwd, so make descendant results relative to vcwd.
  pi.on("tool_result", (event, ctx) => {
    if (!FFF_TOOLS.has(event.toolName)) return;
    const input = event.input as { path?: unknown; exclude?: string | string[]; cursor?: string };
    const cursorMap = fffCursors.get(event.toolName)!;
    const resumed = input.cursor ? cursorMap.get(input.cursor) : undefined;
    const descendant = vcwd ? relative(ctx.cwd, vcwd).split(sep).join("/") : "";
    const searched = typeof input.path === "string" ? resolve(ctx.cwd, input.path) : undefined;
    const fromVcwd = vcwd && searched ? relative(vcwd, searched) : undefined;
    const rebase = resumed
      ? resumed.vcwd === vcwd && resumed.rebase
      : !input.cursor && Boolean(vcwd && descendant && descendant !== ".." && !descendant.startsWith("../")
        && !isAbsolute(descendant) && fromVcwd !== undefined && fromVcwd !== ".."
        && !fromVcwd.startsWith(`..${sep}`) && !isAbsolute(fromVcwd));
    const content = event.content ?? [];
    const filePath = typeof input.path === "string" ? input.path.split(/[\\/]/).pop() ?? "" : "";
    const fuzzyFileFallback = vcwd && event.toolName === "ffgrep"
      && /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(filePath)
      && content.some((block) => block.type === "text"
        && block.text.startsWith("[0 exact matches. Maybe you meant this?]\n"));
    if (fuzzyFileFallback) {
      return {
        content: [{ type: "text", text: "FFF file-scoped fuzzy fallback was blocked; retry without a file path or use the built-in grep tool" }],
        isError: true,
      };
    }
    const hasMore = (event.details as { hasMore?: unknown } | undefined)?.hasMore === true;
    const nextCursor = content
      .flatMap((block) => block.type === "text" ? [fffCursorFromOutput(event.toolName, block.text, hasMore)] : [])
      .find((value): value is string => Boolean(value));
    if (nextCursor) {
      if (!cursorMap.has(nextCursor) && cursorMap.size >= 200) cursorMap.delete(cursorMap.keys().next().value!);
      cursorMap.set(nextCursor, resumed ?? {
        path: typeof input.path === "string" ? input.path : undefined,
        exclude: Array.isArray(input.exclude) ? [...input.exclude] : input.exclude,
        vcwd,
        rebase,
      });
    }
    if (!rebase) return;
    const prefix = `${descendant}/`;
    return {
      content: content.map((block) => block.type === "text"
        ? { ...block, text: block.text.split("\n").map((line) => line.startsWith(prefix) ? line.slice(prefix.length) : line).join("\n") }
        : block),
    };
  });

  // `!command` from the user follows the virtual cwd too.
  pi.on("user_bash", () => {
    if (!vcwd) return;
    const dir = vcwd;
    return {
      operations: {
        exec: (command, _cwd, options) => localBash.exec(command, dir, options),
      },
    };
  });

  // Keep the model's view of the cwd accurate (system prompt states the original).
  // Rewriting the line costs one prompt-cache miss per directory change (prefix
  // change), same as appending would — and avoids contradictory cwd signals.
  pi.on("before_agent_start", (event) => {
    if (!vcwd) return;
    const marker = "Current working directory: ";
    const line = [...event.systemPrompt.matchAll(/^Current working directory: .*$/gm)].at(-1);
    const systemPrompt = line?.index !== undefined
      ? `${event.systemPrompt.slice(0, line.index)}${marker}${vcwd}${event.systemPrompt.slice(line.index + line[0].length)}`
      : `${event.systemPrompt}\n\nThe working directory has been changed to: ${vcwd} (via change_dir). Relative paths and bash commands resolve there.`;
    return { systemPrompt };
  });

  pi.registerCommand("cwd", {
    description: "Show or change the working directory: /cwd [path|-]",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      if (!arg) {
        ctx.ui.notify(`Working directory: ${escapeControl(vcwd ?? ctx.cwd)}${vcwd ? ` (session: ${escapeControl(ctx.cwd)})` : ""}`, "info");
        return;
      }
      try {
        const target = changeDir(arg === "-" ? ctx.cwd : arg, ctx);
        ctx.ui.notify(`Working directory: ${target}`, "info");
      } catch (error) {
        ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
      }
    },
  });
}
