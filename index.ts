/**
 * pi-change-working-dir: let the agent (and user) change the session's
 * effective working directory without restarting pi.
 *
 * pi bakes the session cwd into its built-in tools at session start. This
 * extension keeps a "virtual cwd" and rewrites tool inputs on the fly:
 *   - bash: prepends `cd <dir> || exit 1`
 *   - read/write/edit/ls/grep/find: resolves relative paths against the dir
 *   - `!` user bash: runs in the dir
 * The dir persists in the session (survives resume/fork) and is shown in the
 * footer. `change_dir` tool for the agent, `/cwd [path]` for the user.
 */
import { Type } from "@earendil-works/pi-ai";
import {
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const ENTRY_TYPE = "change-working-dir";
/** Built-in tools whose `path` param resolves against the session cwd. */
const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find"]);
/** Path tools where `path` is optional and defaults to the session cwd. */
const DEFAULT_PATH_TOOLS = new Set(["ls", "grep", "find"]);

const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

const expandTilde = (p: string) =>
  p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;

export default function (pi: ExtensionAPI) {
  /** Active working directory override; undefined = session default. */
  let vcwd: string | undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setStatus("cwd", vcwd ? `cwd: ${vcwd}` : undefined);
  };

  const changeDir = (path: string, ctx: ExtensionContext): string => {
    const target = resolve(vcwd ?? ctx.cwd, expandTilde(path));
    if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`Not a directory: ${target}`);
    }
    vcwd = target === ctx.cwd ? undefined : target;
    pi.appendEntry(ENTRY_TYPE, { dir: vcwd });
    updateStatus(ctx);
    return target;
  };

  // Restore persisted dir on startup/resume/fork (last entry on branch wins).
  pi.on("session_start", (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
        vcwd = (entry.data as { dir?: string } | undefined)?.dir;
      }
    }
    if (vcwd && !statSync(vcwd, { throwIfNoEntry: false })?.isDirectory()) {
      if (ctx.hasUI) ctx.ui.notify(`Saved working directory is gone: ${vcwd}`, "warning");
      vcwd = undefined;
    }
    updateStatus(ctx);
  });

  pi.registerTool({
    name: "change_dir",
    label: "Change Directory",
    description:
      "Change the working directory for all subsequent tool calls (bash, read, edit, write, ls, grep, find). Persists for the rest of the session until changed again. Accepts absolute, ~, or relative (to the current working directory) paths.",
    promptSnippet: "Change the working directory for subsequent tool calls",
    promptGuidelines: [
      "Use change_dir once when work moves to another directory (e.g. a git worktree) instead of prefixing every bash command with cd.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Directory to switch to" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const target = changeDir(params.path, ctx);
      return {
        content: [
          {
            type: "text",
            text: `Working directory changed to ${target}. Relative paths and bash commands now resolve there.`,
          },
        ],
      };
    },
  });

  // Rewrite built-in tool inputs to honor the virtual cwd.
  pi.on("tool_call", (event) => {
    if (!vcwd) return;
    if (event.toolName === "bash") {
      const input = event.input as { command?: string };
      if (typeof input.command === "string") {
        input.command = `cd ${shellQuote(vcwd)} || exit 1\n${input.command}`;
      }
    } else if (PATH_TOOLS.has(event.toolName)) {
      const input = event.input as { path?: string };
      let p = input.path;
      if (p === undefined) {
        if (DEFAULT_PATH_TOOLS.has(event.toolName)) input.path = vcwd;
        return;
      }
      if (typeof p !== "string") return;
      if (p.startsWith("@")) p = p.slice(1); // read tool accepts @-prefixed paths
      p = expandTilde(p);
      if (!isAbsolute(p)) input.path = resolve(vcwd, p);
    }
  });

  // `!command` from the user follows the virtual cwd too.
  pi.on("user_bash", () => {
    if (!vcwd) return;
    const dir = vcwd;
    const local = createLocalBashOperations();
    return {
      operations: {
        exec: (command, _cwd, options) => local.exec(command, dir, options),
      },
    };
  });

  // Keep the model's view of the cwd accurate (system prompt states the original).
  pi.on("before_agent_start", (event) => {
    if (!vcwd) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nThe working directory has been changed to: ${vcwd} (via change_dir). Relative paths and bash commands resolve there, not in the directory listed above.`,
    };
  });

  pi.registerCommand("cwd", {
    description: "Show or change the working directory: /cwd [path|-]",
    handler: async (args, ctx) => {
      const arg = args?.trim();
      if (!arg) {
        ctx.ui.notify(`Working directory: ${vcwd ?? ctx.cwd}${vcwd ? ` (session: ${ctx.cwd})` : ""}`, "info");
        return;
      }
      try {
        const target = changeDir(arg === "-" ? ctx.cwd : arg, ctx);
        ctx.ui.notify(`Working directory: ${target}`, "info");
        pi.sendMessage(
          {
            customType: ENTRY_TYPE,
            content: `The user changed the working directory to ${target}. Relative paths and bash commands now resolve there.`,
            display: false,
          },
          { deliverAs: "nextTurn" },
        );
      } catch (error) {
        ctx.ui.notify(String(error instanceof Error ? error.message : error), "error");
      }
    },
  });
}
