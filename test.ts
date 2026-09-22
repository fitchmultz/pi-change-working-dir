/** Real-loader directory/consumer contract: npm test (no provider calls). */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const {
  createAgentSession, createReadToolDefinition, DefaultResourceLoader, isToolCallEventType, SessionManager, SettingsManager,
} = await import(process.env.PI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
  : "@earendil-works/pi-coding-agent") as typeof import("@earendil-works/pi-coding-agent");

const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-contract-")));
const origin = join(root, "origin"), target = join(root, "target's directory"), other = join(root, "other");
const agentDir = join(root, "agent");
for (const path of [origin, target, other, agentDir]) mkdirSync(path);
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
for (const [path, text] of [[origin, "ORIGIN"], [target, "TARGET"], [other, "OTHER"]]) {
  writeFileSync(join(path!, "same.txt"), `${text}\n`);
}
const contexts: Array<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; api: ExtensionAPI }> = [];
const channel = "pi-change-working-dir:resolve-execution-cwd";
const setter = "pi-change-working-dir:set-execution-cwd";

async function setup(options: { cwd?: string; bind?: boolean; customFirst?: boolean; factory?: (pi: ExtensionAPI) => void } = {}) {
  const cwd = options.cwd ?? origin;
  let api!: ExtensionAPI;
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(process.cwd(), "index.ts")],
    extensionFactories: [(pi) => { api = pi; options.factory?.(pi); }],
    extensionsOverride: options.customFirst ? (loaded) => ({ ...loaded, extensions: [...loaded.extensions].reverse() }) : undefined,
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
  });
  contexts.push({ session, api });
  if (options.bind !== false) await session.bindExtensions({ onError: (error) => assert.fail(error.error) });
  return { session, api };
}

type Session = Awaited<ReturnType<typeof setup>>["session"];
async function execute(session: Session, name: string, args: Record<string, unknown>) {
  const input = structuredClone(args);
  const event = { type: "tool_call" as const, toolCallId: "test", toolName: name, input };
  const blocked = await session.extensionRunner!.emitToolCall(event);
  assert.ok(!blocked?.block, blocked?.reason);
  const definition = session.getToolDefinition(name);
  assert.ok(definition, `${name} definition exists`);
  return definition.execute("test", input, undefined, undefined, session.extensionRunner!.createContext());
}
function query(api: ExtensionAPI, session: Session) {
  const request: { sessionManager: Session["sessionManager"]; result?: { cwd: string; error?: string } } = { sessionManager: session.sessionManager };
  api.events.emit(channel, request);
  return request.result;
}
const text = (result: Awaited<ReturnType<typeof execute>>): string => result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
const entries = (session: Session) => session.sessionManager.getBranch().filter((entry): entry is Extract<typeof entry, { type: "custom" }> => entry.type === "custom" && entry.customType === "change-working-dir");

try {
  const { session, api } = await setup();
  assert.equal(session.getToolDefinition("change_dir")!.executionMode, "sequential");
  assert.deepEqual(session.getToolDefinition("change_dir")!.constrainedSampling, { type: "json_schema", strict: "prefer" });
  assert.equal(query(api, session)?.cwd, origin);
  const initialActive = api.getActiveTools();
  assert.ok(!initialActive.includes("powershell"), "wrapping defaults does not activate inactive tools");
  assert.match(text(await execute(session, "read", { path: "same.txt" })), /ORIGIN/);

  const link = join(root, "target-link");
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
  await execute(session, "change_dir", { path: link });
  assert.equal(query(api, session)?.cwd, target);
  assert.equal(session.sessionManager.getCwd(), origin);
  const count = entries(session).length;
  await execute(session, "change_dir", { path: target });
  assert.equal(entries(session).length, count, "duplicate directory selection is not appended");
  const selectedEntry = entries(session).at(-1)!;
  for (const path of ["same.txt", "@same.txt", pathToFileURL(join(target, "same.txt")).href]) {
    assert.match(text(await execute(session, "read", { path })), /TARGET/);
  }
  assert.match(text(await execute(session, "read", { path: join(origin, "same.txt") })), /ORIGIN/);
  assert.match(text(await execute(session, "ls", {})), /same\.txt/);
  await execute(session, "write", { path: "nested/new.txt", content: "new\n" });
  assert.equal(readFileSync(join(target, "nested/new.txt"), "utf8"), "new\n");
  await execute(session, "edit", { path: "nested/new.txt", edits: [{ oldText: "new", newText: "edited" }] });
  assert.equal(readFileSync(join(target, "nested/new.txt"), "utf8"), "edited\n");
  assert.ok(!existsSync(join(origin, "nested")));

  // Native shell parameters stay intact; admission captures A before an awaited policy.
  let releasePolicy!: () => void;
  const policyWait = new Promise<void>((resolve) => { releasePolicy = resolve; });
  let policyEntered!: () => void;
  const entered = new Promise<void>((resolve) => { policyEntered = resolve; });
  const invocation = { type: "tool_call" as const, toolCallId: "admitted", toolName: "write", input: { path: "admitted.txt", content: "pinned\n" } };
  const stopPolicy = api.on("tool_call", async (event) => {
    if (event.toolCallId !== "admitted" || !isToolCallEventType("write", event)) return;
    assert.equal(event.input.path, join(target, "admitted.txt"));
    policyEntered();
    await policyWait;
  });
  const admission = session.extensionRunner!.emitToolCall(invocation);
  await entered;
  await execute(session, "change_dir", { path: other });
  releasePolicy();
  await admission;
  await session.getToolDefinition("write")!.execute("admitted", invocation.input, undefined, undefined, session.extensionRunner!.createContext());
  stopPolicy();
  assert.equal(readFileSync(join(target, "admitted.txt"), "utf8"), "pinned\n");
  assert.ok(!existsSync(join(other, "admitted.txt")));

  // Explicit and omitted subprocess roots are never intercepted globally.
  assert.equal(realpathSync((await api.exec(process.execPath, ["-p", "process.cwd()"], { cwd: origin })).stdout.trim()), origin);
  assert.equal(realpathSync((await api.exec(process.execPath, ["-p", "process.cwd()"])).stdout.trim()), origin);
  assert.equal(realpathSync((await api.exec(process.execPath, ["-p", "process.cwd()"], { cwd: target })).stdout.trim()), target);
  const second = await setup({ cwd: other });
  await execute(second.session, "change_dir", { path: target });
  assert.equal(query(api, session)?.cwd, other);
  assert.equal(query(second.api, second.session)?.cwd, target);
  const wrongSession = { sessionManager: second.session.sessionManager, result: undefined };
  api.events.emit(channel, wrongSession);
  assert.equal(wrongSession.result, undefined);

  // The owner's setter uses the same validation/persistence as the tool.
  const setRequest = { sessionManager: session.sessionManager, path: target, result: undefined as { cwd: string; error?: string } | undefined };
  api.events.emit(setter, setRequest);
  assert.deepEqual(setRequest.result, { cwd: target });
  api.events.emit(setter, { ...setRequest, path: "" });
  assert.equal(query(api, session)?.cwd, target);
  await assert.rejects(() => execute(session, "change_dir", { path: "" }), /Path is required/);
  await assert.rejects(() => execute(session, "change_dir", { path: join(root, "missing") }), /Not an accessible directory/);
  await assert.rejects(() => execute(session, "change_dir", { path: join(target, "same.txt") }), /Not an accessible directory/);
  if (process.platform !== "win32") {
    const denied = join(root, "denied"); mkdirSync(denied); chmodSync(denied, 0);
    await assert.rejects(() => execute(session, "change_dir", { path: denied }), /Not an accessible directory/);
    chmodSync(denied, 0o700);
    const control = join(root, "line\nbreak"); mkdirSync(control);
    await assert.rejects(() => execute(session, "change_dir", { path: control }), /control characters/);
    for (const name of ["literal\\directory", "nonbreaking\u00a0directory"]) {
      const literal = join(root, name); mkdirSync(literal); writeFileSync(join(literal, "same.txt"), "LITERAL\n");
      await execute(session, "change_dir", { path: literal });
      assert.match(text(await execute(session, "read", { path: "same.txt" })), /LITERAL/);
    }
  }

  // Branch selection survives reload/tree; reset is relative to the runtime anchor.
  await execute(session, "change_dir", { path: target });
  await session.reload();
  assert.throws(() => query(api, session), /stale/, "old event-bus API is invalidated on reload");
  const ctx = session.extensionRunner!.createContext();
  assert.equal(ctx.cwd, origin);
  assert.match(text(await execute(session, "read", { path: "same.txt" })), /TARGET/);
  await execute(session, "change_dir", { path: other });
  await session.navigateTree(selectedEntry.id, { summarize: false });
  assert.match(text(await execute(session, "read", { path: "same.txt" })), /TARGET/);
  await session.prompt("/cwd -");
  assert.match(text(await execute(session, "read", { path: "same.txt" })), /ORIGIN/);

  // A live deleted root never gets recreated, even via an absolute write elsewhere.
  const removed = join(root, "removed"); mkdirSync(removed);
  await execute(session, "change_dir", { path: removed });
  rmSync(removed, { recursive: true });
  await assert.rejects(() => execute(session, "write", { path: "new.txt", content: "no" }), /Working directory unavailable/);
  await assert.rejects(() => execute(session, "write", { path: join(other, "blocked.txt"), content: "no" }), /Working directory unavailable/);
  assert.ok(!existsSync(removed)); assert.ok(!existsSync(join(other, "blocked.txt")));
  // Restoring an unavailable SAVED selection preserves it but falls back to origin.
  await session.reload();
  assert.match(text(await execute(session, "read", { path: "same.txt" })), /ORIGIN/);
  assert.deepEqual(entries(session).at(-1)?.data, { dir: removed });
  mkdirSync(removed); writeFileSync(join(removed, "same.txt"), "RETURNED\n");
  assert.match(text(await execute(session, "read", { path: "same.txt" })), /ORIGIN/);
  await session.reload();
  assert.match(text(await execute(session, "read", { path: "same.txt" })), /RETURNED/);
  await session.prompt("/cwd -");

  // Custom definitions are never replaced, rebased or stripped of their executor.
  const customRead = createReadToolDefinition(other);
  let customContext: ExtensionContext | undefined;
  const custom = await setup({ factory(pi) {
    pi.registerTool({ ...customRead, async execute(id, args, signal, update, executionContext) {
      customContext = executionContext;
      return customRead.execute(id, args, signal, update, executionContext);
    } });
  } });
  await execute(custom.session, "change_dir", { path: target });
  await execute(custom.session, "read", { path: "same.txt" });
  assert.equal(customContext?.cwd, origin, "uncooperating custom tool retains its native context");
  assert.notEqual(custom.session.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.path, join(process.cwd(), "index.ts"));

  // Native runtime registration can replace an adapter; routing follows its current owner.
  const late = await setup({ customFirst: true });
  let latePath: string | undefined;
  late.api.registerTool({ ...createReadToolDefinition(origin), async execute(_id, params) {
    latePath = params.path;
    return { content: [{ type: "text", text: "custom read" }], details: {} };
  } });
  await execute(late.session, "change_dir", { path: target });
  await execute(late.session, "read", { path: "same.txt" });
  assert.equal(latePath, "same.txt", "late custom registration retains its original arguments");

  // /cwd before binding/first prompt initializes the owner without a model call.
  const bare = await setup({ bind: false });
  assert.equal(query(bare.api, bare.session), undefined);
  await bare.session.prompt(`/cwd ${target}`);
  assert.equal(query(bare.api, bare.session)?.cwd, target);
  assert.match(text(await execute(bare.session, "read", { path: "same.txt" })), /TARGET/);
  console.log("ok: real directory owner, native tools, policy snapshot, branches, recovery, SDK startup and process isolation");
} finally {
  for (const { session } of contexts) session.dispose();
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(root, { recursive: true, force: true });
}
