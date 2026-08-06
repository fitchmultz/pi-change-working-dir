/** Self-check via Pi's real 0.84+ extension loader: npm test */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cwd-session-")));
const worktree = realpathSync(mkdtempSync(join(tmpdir(), "cwd-worktree-")));
const alternateWorktree = realpathSync(mkdtempSync(join(tmpdir(), "cwd-alternate-")));
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "cwd-agent-")));

const entries: any[] = [];
let branchEntries = entries;
const statuses = new Map<string, string | undefined>();
const notifications: string[] = [];
const sentMessages: unknown[] = [];

const loadExtension = async () => {
  const resourceLoader = new DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [join(process.cwd(), "index.ts")],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  loaded.runtime.appendEntry = (customType: string, data: unknown) =>
    entries.push({ type: "custom", customType, data });
  loaded.runtime.sendMessage = (message) => sentMessages.push(message);
  assert.deepEqual(loaded.errors, []);
  return loaded.extensions[0]!;
};

const ext = await loadExtension();

const ctx: any = {
  cwd: sessionCwd,
  hasUI: true,
  mode: "tui",
  ui: {
    setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
    notify: (message: string) => notifications.push(message),
  },
  sessionManager: { getBranch: () => branchEntries },
};
const emit = async (extension: typeof ext, name: string, event: any): Promise<any> => {
  let result: any;
  for (const fn of extension.handlers.get(name) ?? []) result = await fn(event, ctx);
  return result;
};
const changeDir = ext.tools.get("change_dir")!.definition;

// No override: inputs untouched.
let event: any = { toolName: "bash", input: { command: "ls" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.command, "ls");

// change_dir validates and switches.
await assert.rejects(() => changeDir.execute("t0", { path: "/nope/nothing" }, undefined, undefined, ctx));
const res = await changeDir.execute("t1", { path: worktree }, undefined, undefined, ctx);
const firstContent = res.content[0];
assert.equal(firstContent?.type, "text");
assert.match(firstContent.text, new RegExp(worktree));
assert.equal(statuses.get("cwd"), `cwd: ${worktree}`);

// Bash gets a cwd prefix.
event = { toolName: "bash", input: { command: "git status" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.command, `cd '${worktree}' || exit 1\ngit status`);

// Relative paths are rewritten; absolute paths are untouched; optional paths default.
event = { toolName: "read", input: { path: "src/main.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "src/main.ts"));
event = { toolName: "edit", input: { path: "/abs/file.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, "/abs/file.ts");
event = { toolName: "grep", input: { pattern: "x" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, worktree);

// apply_edits paths are rewritten too.
event = { toolName: "apply_edits", input: { path: "a.ts", files: [{ path: "b.ts" }, { path: "/abs/c.ts" }] } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "a.ts"));
assert.equal(event.input.files[0].path, join(worktree, "b.ts"));
assert.equal(event.input.files[1].path, "/abs/c.ts");

// The system prompt cwd is rewritten in place, with a fallback when the standard line is absent.
let result = await emit(ext, "before_agent_start", {
  systemPrompt: `intro\nCurrent working directory: ${sessionCwd}\noutro`,
});
assert.equal(result.systemPrompt, `intro\nCurrent working directory: ${worktree}\noutro`);
result = await emit(ext, "before_agent_start", { systemPrompt: "base" });
assert.match(result.systemPrompt, new RegExp(worktree));

// User bash follows the override.
const userBash = await emit(ext, "user_bash", { command: "pwd", cwd: sessionCwd });
let userBashOutput = "";
await userBash.operations.exec("pwd", sessionCwd, { onData: (chunk: Buffer) => (userBashOutput += chunk) });
assert.equal(userBashOutput.trim(), worktree);

// A fresh extension instance restores the active branch.
const ext2 = await loadExtension();
await emit(ext2, "session_start", {});
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, `cd '${worktree}' || exit 1\npwd`);

// A command change followed by tree navigation keeps only the selected branch's cwd context.
const worktreeBranch = [...entries];
await ext2.commands.get("cwd")!.handler(alternateWorktree, ctx);
result = await emit(ext2, "before_agent_start", { systemPrompt: "base" });
assert.match(result.systemPrompt, new RegExp(alternateWorktree));
branchEntries = worktreeBranch;
await emit(ext2, "session_tree", {});
result = await emit(ext2, "before_agent_start", { systemPrompt: "base" });
assert.match(result.systemPrompt, new RegExp(worktree));
assert.doesNotMatch(result.systemPrompt, new RegExp(alternateWorktree));
assert.deepEqual(sentMessages, []);

// Tree navigation restores the selected branch instead of leaking the old branch's cwd.
branchEntries = [];
await emit(ext2, "session_tree", {});
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, "pwd");
branchEntries = worktreeBranch;
await emit(ext2, "session_tree", {});
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, `cd '${worktree}' || exit 1\npwd`);

// Missing persisted directories are rejected safely.
branchEntries = [{ type: "custom", customType: "change-working-dir", data: { dir: "/nope/missing-cwd" } }];
await emit(ext2, "session_tree", {});
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, "pwd");
assert.match(notifications.at(-1)!, /Saved working directory is gone/);

// Switching back to the session cwd clears the override and persists the reset.
branchEntries = entries;
await changeDir.execute("t2", { path: sessionCwd }, undefined, undefined, ctx);
await emit(ext2, "session_tree", {});
event = { toolName: "bash", input: { command: "ls" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, "ls");
assert.equal(statuses.get("cwd"), undefined);

rmSync(sessionCwd, { recursive: true, force: true });
rmSync(worktree, { recursive: true, force: true });
rmSync(alternateWorktree, { recursive: true, force: true });
rmSync(agentDir, { recursive: true, force: true });
console.log("ok");
