/** Self-check via pi's real extension loader: npm test */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piExecutable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const piPackageRoot = dirname(dirname(realpathSync(piExecutable)));
const { createExtensionRuntime, loadExtensions } = await import(
	pathToFileURL(join(piPackageRoot, "dist/core/extensions/loader.js")).href
);

const sessionCwd = realpathSync(mkdtempSync(join(tmpdir(), "cwd-session-")));
const worktree = realpathSync(mkdtempSync(join(tmpdir(), "cwd-worktree-")));

const entries: any[] = [];
const runtime = createExtensionRuntime();
runtime.appendEntry = (customType: string, data: unknown) => entries.push({ type: "custom", customType, data });
runtime.sendMessage = () => {};

const loaded = await loadExtensions([join(process.cwd(), "index.ts")], process.cwd(), undefined, runtime);
assert.deepEqual(loaded.errors, []);
const ext = loaded.extensions[0];

const ctx: any = {
	cwd: sessionCwd,
	hasUI: false,
	ui: { setStatus: () => {}, notify: () => {} },
	sessionManager: { getBranch: () => entries },
};
const emit = async (name: string, event: any) => {
	let result;
	for (const fn of ext.handlers.get(name) ?? []) result = await fn(event, ctx);
	return result;
};
const changeDir = ext.tools.get("change_dir")!.definition;

// No override: inputs untouched
let event: any = { toolName: "bash", input: { command: "ls" } };
await emit("tool_call", event);
assert.equal(event.input.command, "ls");

// change_dir validates
await assert.rejects(() => changeDir.execute("t0", { path: "/nope/nothing" }, undefined, undefined, ctx));

// change_dir switches
const res = await changeDir.execute("t1", { path: worktree }, undefined, undefined, ctx);
assert.match(res.content[0].text, new RegExp(worktree));

// bash gets cd prefix
event = { toolName: "bash", input: { command: "git status" } };
await emit("tool_call", event);
assert.equal(event.input.command, `cd '${worktree}' || exit 1\ngit status`);

// relative paths rewritten; absolute untouched; optional path defaulted
event = { toolName: "read", input: { path: "src/main.ts" } };
await emit("tool_call", event);
assert.equal(event.input.path, join(worktree, "src/main.ts"));
event = { toolName: "edit", input: { path: "/abs/file.ts" } };
await emit("tool_call", event);
assert.equal(event.input.path, "/abs/file.ts");
event = { toolName: "grep", input: { pattern: "x" } };
await emit("tool_call", event);
assert.equal(event.input.path, worktree);

// apply_edits (pi-apply-edits custom tool) paths rewritten too
event = { toolName: "apply_edits", input: { path: "a.ts", files: [{ path: "b.ts" }, { path: "/abs/c.ts" }] } };
await emit("tool_call", event);
assert.equal(event.input.path, join(worktree, "a.ts"));
assert.equal(event.input.files[0].path, join(worktree, "b.ts"));
assert.equal(event.input.files[1].path, "/abs/c.ts");

// system prompt notes the override
const r = await emit("before_agent_start", { systemPrompt: "base" });
assert.match(r.systemPrompt, new RegExp(worktree));

// user bash follows the override
const ub = await emit("user_bash", { command: "pwd", cwd: sessionCwd });
let ubOut = "";
await ub.operations.exec("pwd", sessionCwd, { onData: (chunk: Buffer) => (ubOut += chunk) });
assert.equal(ubOut.trim(), worktree);

// persisted + restored on session_start (fresh instance)
const loaded2 = await loadExtensions([join(process.cwd(), "index.ts")], process.cwd(), undefined, runtime);
const ext2 = loaded2.extensions[0];
for (const fn of ext2.handlers.get("session_start")!) await fn({}, ctx);
event = { toolName: "bash", input: { command: "pwd" } };
for (const fn of ext2.handlers.get("tool_call")!) await fn(event, ctx);
assert.equal(event.input.command, `cd '${worktree}' || exit 1\npwd`);

// switching back to session cwd clears the override
await changeDir.execute("t2", { path: sessionCwd }, undefined, undefined, ctx);
event = { toolName: "bash", input: { command: "ls" } };
await emit("tool_call", event);
assert.equal(event.input.command, "ls");

console.log("ok");
