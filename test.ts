/** Self-check via Pi's real 0.84+ extension loader: npm test */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cwd-session-")));
const spacedSessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cwd session ")));
const worktree = realpathSync(mkdtempSync(join(tmpdir(), "cwd-worktree-")));
const alternateWorktree = realpathSync(mkdtempSync(join(tmpdir(), "cwd-alternate-")));
const inaccessible = realpathSync(mkdtempSync(join(tmpdir(), "cwd-inaccessible-")));
const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "cwd-agent-")));
const worktreeLink = join(sessionCwd, "worktree-link");
symlinkSync(worktree, worktreeLink, process.platform === "win32" ? "junction" : "dir");

const entries: any[] = [];
let branchEntries = entries;
const statuses = new Map<string, string | undefined>();
const notifications: string[] = [];
const sentMessages: unknown[] = [];

const createLoader = () => new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir,
  settingsManager: SettingsManager.inMemory(),
  additionalExtensionPaths: [join(process.cwd(), "index.ts")],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
const loadExtension = async (resourceLoader = createLoader()) => {
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
const pwd = (cwd?: string, asOptions = false) => new Promise<string>((resolve, reject) => {
  const child = cwd === undefined ? spawn("pwd") : asOptions ? spawn("pwd", { cwd }) : spawn("pwd", [], { cwd });
  let out = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk;
  });
  child.on("error", reject);
  child.on("close", () => resolve(realpathSync(out.trim() || ".")));
});
const changeDir = ext.tools.get("change_dir")!.definition;
assert.equal(changeDir.executionMode, "sequential");

// No override: inputs remain untouched.
let event: any = { toolName: "bash", input: { command: "ls" } };
if (process.platform !== "win32") assert.equal(await pwd(sessionCwd), sessionCwd);
await emit(ext, "tool_call", event);
assert.equal(event.input.command, "ls");
const rootCursorInput = { path: "src/", exclude: "test/" };
await emit(ext, "tool_result", {
  toolName: "ffgrep",
  input: rootCursorInput,
  content: [{ type: "text", text: "src/a.ts\n 1: match\n\n[Continue with cursor=\"fff_c0\"]" }],
  isError: false,
});
event = { toolName: "ffgrep", input: { pattern: "x", cursor: "fff_c0" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, rootCursorInput.path);
assert.equal(event.input.exclude, rootCursorInput.exclude);

// change_dir rejects empty, missing, and inaccessible directories.
await assert.rejects(() => changeDir.execute("t0", { path: "" }, undefined, undefined, ctx), /Path is required/);
await assert.rejects(() => changeDir.execute("t1", { path: "/nope/nothing" }, undefined, undefined, ctx), /Not an accessible directory/);
if (process.platform !== "win32") {
  chmodSync(inaccessible, 0o000);
  await assert.rejects(() => changeDir.execute("t2", { path: inaccessible }, undefined, undefined, ctx), /Not an accessible directory/);
  chmodSync(inaccessible, 0o700);
}

// Supported tilde separators resolve to the home directory.
const home = realpathSync(homedir());
for (const path of ["~/", ...(sep === "\\" ? ["~\\"] : [])]) {
  const homeResult = await changeDir.execute("tilde", { path }, undefined, undefined, ctx);
  assert.ok((homeResult.content[0] as { text: string }).text.includes(home));
}
await changeDir.execute("tilde-reset", { path: sessionCwd }, undefined, undefined, ctx);

// Switching through a symlink canonicalizes the cwd and duplicate changes do not add session entries.
const res = await changeDir.execute("t3", { path: worktreeLink }, undefined, undefined, ctx);
const firstContent = res.content[0];
assert.equal(firstContent?.type, "text");
assert.match(firstContent.text, new RegExp(worktree));
assert.equal(statuses.get("cwd"), `cwd: ${worktree}`);
const entryCount = entries.length;
await changeDir.execute("t4", { path: worktree }, undefined, undefined, ctx);
assert.equal(entries.length, entryCount);
if (sep !== "\\") {
  const literalBackslashTilde = join(worktree, "~\\literal");
  mkdirSync(literalBackslashTilde);
  await changeDir.execute("literal-tilde", { path: "~\\literal" }, undefined, undefined, ctx);
  assert.equal(statuses.get("cwd"), `cwd: ${literalBackslashTilde}`);
  await changeDir.execute("literal-tilde-reset", { path: worktree }, undefined, undefined, ctx);
}

// Bash gets a safely quoted cwd prefix.
event = { toolName: "bash", input: { command: "git status" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.command, `cd '${worktree}' || exit 1\ngit status`);
const rootCursorAfterChange = await emit(ext, "tool_call", {
  toolName: "ffgrep",
  input: { pattern: "x", cursor: "fff_c0" },
});
assert.equal(rootCursorAfterChange.block, true);
assert.match(rootCursorAfterChange.reason, /different working directory/);

// Built-in and FFF paths resolve from the virtual cwd.
event = { toolName: "read", input: { path: "src/main.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "src/main.ts"));
event = { toolName: "read", input: { path: "@src/main.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "src/main.ts"));
event = { toolName: "read", input: { path: "~/file.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(homedir(), "file.ts"));
event = { toolName: "edit", input: { path: "/abs/file.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, "/abs/file.ts");
event = { toolName: "read", input: { path: pathToFileURL(join(worktree, "src/main.ts")).href } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "src/main.ts"));
event = { toolName: "grep", input: { pattern: "x" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, worktree);
for (const toolName of ["ls", "grep", "find", "ffgrep", "fffind"]) {
  event = { toolName, input: { path: "" } };
  await emit(ext, "tool_call", event);
  assert.equal(event.input.path, worktree);
}
event = { toolName: "ffgrep", input: { pattern: "x" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, worktree);
event = { toolName: "fffind", input: { pattern: "main", path: "src" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "src"));
event = { toolName: "fffind", input: { pattern: "main", path: "@scope" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "@scope"));
const outsideWhitespacePath = await emit(ext, "tool_call", {
  toolName: "fffind",
  input: { pattern: "main", path: "relative path.ts" },
});
assert.equal(outsideWhitespacePath.block, true);
assert.match(outsideWhitespacePath.reason, /path constraint/);
const absoluteWhitespacePath = await emit(ext, "tool_call", {
  toolName: "fffind",
  input: { pattern: "main", path: pathToFileURL(join(alternateWorktree, "file name.ts")).href },
});
assert.equal(absoluteWhitespacePath.block, true);
assert.match(absoluteWhitespacePath.reason, /path constraint/);

// apply_edits and subagent receive the virtual cwd too.
event = { toolName: "apply_edits", input: { path: "a.ts", files: [{ path: "b.ts" }, { path: "/abs/c.ts" }] } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "a.ts"));
assert.equal(event.input.files[0].path, join(worktree, "b.ts"));
assert.equal(event.input.files[1].path, "/abs/c.ts");
event = { toolName: "apply_edits", input: { path: "@file.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, join(worktree, "@file.ts"));
event = { toolName: "subagent", input: { agent: "scout", task: "pwd" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.cwd, worktree);
event = { toolName: "subagent", input: { agent: "scout", task: "pwd", cwd: "src" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.cwd, join(worktree, "src"));
event = { toolName: "subagent", input: { agent: "scout", task: "pwd", cwd: "" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.cwd, worktree);
event = { toolName: "subagent", input: { agent: "scout", task: "pwd", cwd: "@scope" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.cwd, join(worktree, "@scope"));
for (const input of [
  { tasks: [{ agent: "scout", task: "pwd" }] },
  { chain: [{ agent: "scout", task: "pwd" }] },
]) {
  event = { toolName: "subagent", input };
  await emit(ext, "tool_call", event);
  assert.equal(event.input.cwd, worktree);
}

// FFF constraints and returned paths stay relative to a descendant virtual cwd.
const descendant = join(sessionCwd, "packages", "app");
mkdirSync(join(descendant, "test"), { recursive: true });
mkdirSync(join(descendant, "test.old"));
await changeDir.execute("descendant", { path: descendant }, undefined, undefined, ctx);
event = { toolName: "ffgrep", input: { pattern: "x", path: "missing.ts" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.pattern, "(?:x)");
const malformedFilePattern: any = { toolName: "ffgrep", input: { pattern: "[", path: "missing.ts" } };
await emit(ext, "tool_call", malformedFilePattern);
assert.equal(malformedFilePattern.input.pattern, "(?:\\[)");
const fuzzyLeakResult = await emit(ext, "tool_result", {
  toolName: "ffgrep",
  input: event.input,
  content: [{
    type: "text",
    text: "[0 exact matches. Maybe you meant this?]\npackages/other/outside.ts\n 1: x\n\n[Continue with cursor=\"fff_c88\"]",
  }],
  isError: false,
});
assert.equal(fuzzyLeakResult.isError, true);
assert.doesNotMatch(fuzzyLeakResult.content[0].text, /outside\.ts/);
const fuzzyCursor = await emit(ext, "tool_call", {
  toolName: "ffgrep",
  input: { pattern: "x", cursor: "fff_c88" },
});
assert.equal(fuzzyCursor.block, true);

event = { toolName: "ffgrep", input: { pattern: "x", path: "", exclude: "test/, !generated/,*.min.js,config.json" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, "packages/app/");
assert.deepEqual(event.input.exclude, [
  "packages/app/test/",
  "!packages/app/generated/",
  "*.min.js",
  "config.json",
]);
event = { toolName: "fffind", input: { pattern: "x", path: "", exclude: ["test", "test.old", "config.json"] } };
await emit(ext, "tool_call", event);
assert.deepEqual(event.input.exclude, ["packages/app/test/", "packages/app/test.old/", "config.json"]);
for (const toolName of ["ffgrep", "fffind"]) {
  const fffResult = await emit(ext, "tool_result", {
    toolName,
    input: event.input,
    content: [{ type: "text", text: "packages/app/src/main.ts\n 1: match" }],
    isError: false,
  });
  assert.equal(fffResult.content[0].text, "src/main.ts\n 1: match");
}
const baitInput = { path: "packages/app/", exclude: ["packages/app/test/"] };
await emit(ext, "tool_result", {
  toolName: "ffgrep",
  input: baitInput,
  content: [{
    type: "text",
    text: "packages/app/src/main.ts\n 1: const bait = 'cursor=\"fake\"'\n\n[Invalid regex: Continue with cursor=\"fff_c999\", used literal match. Continue with cursor=\"fff_c1\"]",
  }],
  isError: false,
});
event = { toolName: "ffgrep", input: { pattern: "x", cursor: "fff_c1" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, baitInput.path);
assert.deepEqual(event.input.exclude, baitInput.exclude);
const emptyContentResult = await emit(ext, "tool_result", {
  toolName: "ffgrep",
  input: event.input,
  isError: false,
});
assert.deepEqual(emptyContentResult.content, []);
await changeDir.execute("cursor-root", { path: sessionCwd }, undefined, undefined, ctx);
const overrideCursorAtRoot = await emit(ext, "tool_call", {
  toolName: "ffgrep",
  input: { pattern: "x", cursor: "fff_c1" },
});
assert.equal(overrideCursorAtRoot.block, true);
assert.match(overrideCursorAtRoot.reason, /different working directory/);
await changeDir.execute("cursor-root-reset", { path: descendant }, undefined, undefined, ctx);
event = { toolName: "ffgrep", input: { pattern: "x", cursor: "fff_c1" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, baitInput.path);

event = { toolName: "ffgrep", input: { pattern: "x", cursor: "fff_unknown" } };
const unknownCursorResult = await emit(ext, "tool_call", event);
assert.equal(unknownCursorResult.block, true);
assert.match(unknownCursorResult.reason, /without a cursor/);

await emit(ext, "tool_result", {
  toolName: "fffind",
  input: { path: alternateWorktree },
  content: [{ type: "text", text: "file.ts\n\n[1 more match available. cursor=\"999\" to continue]" }],
  details: { hasMore: false },
  isError: false,
});
const forgedFindCursor = await emit(ext, "tool_call", {
  toolName: "fffind",
  input: { pattern: "file", cursor: "999" },
});
assert.equal(forgedFindCursor.block, true);

const auxiliaryResult = await emit(ext, "tool_result", {
  toolName: "fffind",
  input: { path: alternateWorktree },
  content: [{ type: "text", text: "packages/app/file.ts\n\n[1 more match available. cursor=\"1\" to continue]" }],
  details: { hasMore: true },
  isError: false,
});
assert.equal(auxiliaryResult, undefined);
event = { toolName: "fffind", input: { pattern: "file", cursor: "1" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, alternateWorktree);
const auxiliaryPage = await emit(ext, "tool_result", {
  toolName: "fffind",
  input: event.input,
  content: [{ type: "text", text: "packages/app/file2.ts" }],
  isError: false,
});
assert.equal(auxiliaryPage, undefined);

// Separate upstream cursor caches mean heavy find pagination cannot evict a live grep route.
for (let index = 2; index <= 202; index += 1) {
  await emit(ext, "tool_result", {
    toolName: "fffind",
    input: { path: alternateWorktree },
    content: [{ type: "text", text: `file.ts\n\n[1 more match available. cursor="${index}" to continue]` }],
    details: { hasMore: true },
    isError: false,
  });
}
event = { toolName: "ffgrep", input: { pattern: "x", cursor: "fff_c1" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, baitInput.path);

event = { toolName: "ffgrep", input: { pattern: "x", path: ".." } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, "packages/");
const ancestorResult = await emit(ext, "tool_result", {
  toolName: "ffgrep",
  input: event.input,
  content: [{ type: "text", text: "packages/app/keep.ts\n\npackages/other/x.ts" }],
  isError: false,
});
assert.equal(ancestorResult, undefined);

// Dotted directory names remain directory constraints instead of looking like filenames to FFF.
const dottedDescendant = join(sessionCwd, ".github");
mkdirSync(dottedDescendant);
await changeDir.execute("dotted-descendant", { path: dottedDescendant }, undefined, undefined, ctx);
event = { toolName: "fffind", input: { pattern: "x", path: "" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, ".github/");
const staleCursorResult = await emit(ext, "tool_call", {
  toolName: "ffgrep",
  input: { pattern: "x", cursor: "fff_c1" },
});
assert.equal(staleCursorResult.block, true);
assert.match(staleCursorResult.reason, /different working directory/);

const bangDescendant = join(sessionCwd, "!target");
mkdirSync(bangDescendant);
await changeDir.execute("bang-descendant", { path: bangDescendant }, undefined, undefined, ctx);
const bangPathResult = await emit(ext, "tool_call", {
  toolName: "ffgrep",
  input: { pattern: "x", path: "" },
});
assert.equal(bangPathResult.block, true);
assert.match(bangPathResult.reason, /path constraint/);

// Session-root whitespace is removed before excludes reach FFF's whitespace-splitting parser.
const spacedDescendant = join(spacedSessionCwd, "packages", "app");
mkdirSync(spacedDescendant, { recursive: true });
ctx.cwd = spacedSessionCwd;
await changeDir.execute("spaced-descendant", { path: spacedDescendant }, undefined, undefined, ctx);
event = { toolName: "ffgrep", input: { pattern: "x", path: "", exclude: "test/" } };
await emit(ext, "tool_call", event);
assert.equal(event.input.path, "packages/app/");
assert.deepEqual(event.input.exclude, ["packages/app/test/"]);
ctx.cwd = sessionCwd;
await changeDir.execute("descendant-reset", { path: worktree }, undefined, undefined, ctx);

// FFF cannot safely represent whitespace inside its session-relative path grammar.
const spacedPathDescendant = join(sessionCwd, "spaced app");
mkdirSync(spacedPathDescendant);
await changeDir.execute("spaced-path", { path: spacedPathDescendant }, undefined, undefined, ctx);
const blockedFff = await emit(ext, "tool_call", { toolName: "ffgrep", input: { pattern: "x", path: "" } });
assert.equal(blockedFff.block, true);
assert.match(blockedFff.reason, /path constraint/);
await changeDir.execute("spaced-path-reset", { path: worktree }, undefined, undefined, ctx);

// Only Pi's final authoritative cwd line is rewritten; fallback still works.
let result = await emit(ext, "before_agent_start", {
  systemPrompt: `Current working directory: example from context\nintro\nCurrent working directory: ${sessionCwd}`,
});
assert.equal(result.systemPrompt, `Current working directory: example from context\nintro\nCurrent working directory: ${worktree}`);
result = await emit(ext, "before_agent_start", {
  systemPrompt: `Current working directory: ${sessionCwd}\nprose with Current working directory: an example`,
});
assert.equal(result.systemPrompt, `Current working directory: ${worktree}\nprose with Current working directory: an example`);
result = await emit(ext, "before_agent_start", { systemPrompt: "base" });
assert.match(result.systemPrompt, new RegExp(worktree));

// User bash follows the override.
const userBash = await emit(ext, "user_bash", { command: "pwd", cwd: sessionCwd });
let userBashOutput = "";
await userBash.operations.exec("pwd", sessionCwd, { onData: (chunk: Buffer) => (userBashOutput += chunk) });
assert.equal(userBashOutput.trim(), worktree);
if (process.platform !== "win32") {
  assert.equal(await pwd(sessionCwd), worktree);
  assert.equal(await pwd(sessionCwd, true), worktree);
  assert.equal(await pwd(), worktree);
  assert.equal(await pwd(alternateWorktree), alternateWorktree);
  assert.throws(() => spawn("pwd", "oops" as never), { code: "ERR_INVALID_ARG_TYPE" });
}

// Control-character directories are rejected before their paths reach tools.
if (process.platform !== "win32") {
  const controlDir = join(sessionCwd, "line\nbreak\u007f\u0085");
  mkdirSync(controlDir);
  await assert.rejects(
    () => changeDir.execute("control", { path: controlDir }, undefined, undefined, ctx),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes("line\\nbreak\\u007f\\u0085"));
      return true;
    },
  );
  event = { toolName: "bash", input: { command: "pwd" } };
  await emit(ext, "tool_call", event);
  assert.equal(event.input.command, `cd '${worktree}' || exit 1\npwd`);
}

// A fresh extension instance restores the active branch.
const ext2 = await loadExtension();
const changeDir2 = ext2.tools.get("change_dir")!.definition;
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

// Malformed and missing persisted directories are ignored safely.
branchEntries = [{ type: "custom", customType: "change-working-dir", data: { dir: { bad: true } } }];
await emit(ext2, "session_tree", {});
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, "pwd");
assert.match(notifications.at(-1)!, /invalid saved working directory/);
branchEntries = [{ type: "custom", customType: "change-working-dir", data: { dir: "relative/path" } }];
await emit(ext2, "session_tree", {});
assert.match(notifications.at(-1)!, /invalid saved working directory/);
branchEntries = [{ type: "custom", customType: "change-working-dir", data: { dir: "/nope/missing-cwd" } }];
await emit(ext2, "session_tree", {});
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, "pwd");
assert.match(notifications.at(-1)!, /Saved working directory unavailable/);

// Explicit reset also replaces malformed persisted state even though both effective dirs are the session cwd.
entries.push({ type: "custom", customType: "change-working-dir", data: { dir: { bad: true } } });
branchEntries = entries;
await emit(ext2, "session_tree", {});
const malformedEntryCount = entries.length;
await changeDir2.execute("reset-malformed", { path: sessionCwd }, undefined, undefined, ctx);
assert.equal(entries.length, malformedEntryCount + 1);
assert.equal(entries.at(-1).data.dir, undefined);

// If an unavailable saved path returns, an explicit change activates it even though persistence already matches.
const restoredThenChanged = realpathSync(mkdtempSync(join(tmpdir(), "cwd-returned-")));
rmSync(restoredThenChanged, { recursive: true });
entries.push({ type: "custom", customType: "change-working-dir", data: { dir: restoredThenChanged } });
branchEntries = entries;
await emit(ext2, "session_tree", {});
mkdirSync(restoredThenChanged);
await changeDir2.execute("activate-returned", { path: restoredThenChanged }, undefined, undefined, ctx);
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, `cd '${restoredThenChanged}' || exit 1\npwd`);
await changeDir2.execute("activate-returned-reset", { path: sessionCwd }, undefined, undefined, ctx);

// An explicit reset clears unavailable persisted state instead of resurrecting it later.
const unavailableThenRestored = realpathSync(mkdtempSync(join(tmpdir(), "cwd-restored-")));
rmSync(unavailableThenRestored, { recursive: true });
entries.push({ type: "custom", customType: "change-working-dir", data: { dir: unavailableThenRestored } });
branchEntries = entries;
await emit(ext2, "session_tree", {});
await changeDir2.execute("reset-unavailable", { path: sessionCwd }, undefined, undefined, ctx);
mkdirSync(unavailableThenRestored);
await emit(ext2, "session_tree", {});
event = { toolName: "bash", input: { command: "pwd" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, "pwd");

// Shutdown clears stale footer state, and resetting to the session cwd persists.
branchEntries = worktreeBranch;
await emit(ext2, "session_tree", {});
assert.equal(statuses.get("cwd"), `cwd: ${worktree}`);
await emit(ext2, "session_shutdown", {});
assert.equal(statuses.get("cwd"), undefined);
if (process.platform !== "win32") assert.equal(await pwd(sessionCwd), sessionCwd);
branchEntries = entries;
await changeDir2.execute("t7", { path: sessionCwd }, undefined, undefined, ctx);
event = { toolName: "bash", input: { command: "ls" } };
await emit(ext2, "tool_call", event);
assert.equal(event.input.command, "ls");
assert.equal(statuses.get("cwd"), undefined);
if (process.platform !== "win32") {
  assert.equal(await pwd(sessionCwd), sessionCwd);
  const reloadLoader = createLoader();
  const extReload = await loadExtension(reloadLoader);
  await extReload.tools.get("change_dir")!.definition.execute("reload-set", { path: worktree }, undefined, undefined, ctx);
  assert.equal(await pwd(sessionCwd), worktree);
  const patchedSpawn = spawn;
  const extReloaded = await loadExtension(reloadLoader);
  assert.equal(spawn, patchedSpawn);
  await extReloaded.tools.get("change_dir")!.definition.execute("reload-reset", { path: sessionCwd }, undefined, undefined, ctx);
  assert.equal(await pwd(sessionCwd), sessionCwd);
}

rmSync(sessionCwd, { recursive: true, force: true });
rmSync(spacedSessionCwd, { recursive: true, force: true });
rmSync(worktree, { recursive: true, force: true });
rmSync(alternateWorktree, { recursive: true, force: true });
rmSync(inaccessible, { recursive: true, force: true });
rmSync(restoredThenChanged, { recursive: true, force: true });
rmSync(unavailableThenRestored, { recursive: true, force: true });
rmSync(agentDir, { recursive: true, force: true });
console.log("ok");
