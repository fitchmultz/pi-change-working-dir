/** Native request/branch regression checks; PI_PACKAGE_DIR optionally selects a fork installation. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentSession as Session, CustomEntry, CustomMessageEntry, ExtensionContext, ExtensionError, ExtensionFactory, ExtensionRunner, ResourceLoader, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const packageUrl = process.env.PI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const agentUrl = pathToFileURL(findPackageJSON("@earendil-works/pi-agent-core", packageUrl)!);
const aiUrl = pathToFileURL(findPackageJSON("@earendil-works/pi-ai", packageUrl)!);
const { AgentSession, SessionManager, SettingsManager, ModelRuntime, createReadTool, createWriteTool, createEventBus } =
  await import(packageUrl) as typeof import("@earendil-works/pi-coding-agent");
const { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } =
  await import(new URL("./core/extensions/loader.js", packageUrl).href) as typeof import("./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const { convertToLlm } =
  await import(new URL("./core/messages.js", packageUrl).href) as typeof import("./node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js");
const { AuthStorage } =
  await import(new URL("./core/auth-storage.js", packageUrl).href) as typeof import("./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js");
const { Agent } = await import(new URL("./dist/index.js", agentUrl).href) as typeof import("@earendil-works/pi-agent-core");
const { getModel } = await import(new URL("./dist/compat.js", aiUrl).href) as typeof import("@earendil-works/pi-ai/compat");
const { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, createAssistantMessageEventStream } =
  await import(new URL("./dist/index.js", aiUrl).href) as typeof import("@earendil-works/pi-ai");
const { registerCwdContext } = await import(new URL("./cwd-context.ts", import.meta.url).href) as typeof import("./cwd-context.js");

const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-context-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const cwd = join(root, "A"), next = join(root, "B"), third = join(root, "C"), hidden = join(root, "B-hidden");
const literal = join(root, process.platform === "win32" ? "literal" : "literal\\backslash");
for (const path of [cwd, next, third, literal]) mkdirSync(path);
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Context tests must not make network requests"); };
const model = structuredClone(getModel("openai", "gpt-6-astra"));
assert.ok(model);
const selectedType = "test:selected-cwd", contextType = "change-working-dir:context";
const fallbackNotice = "The saved directory is unavailable; using the session directory until the next restore.";
const unrelatedSection = "An unrelated extension's instructions must survive.";
const requests: Message[][] = [], responses: AssistantMessage[] = [], errors: ExtensionError[] = [];
const checks: string[] = [];
let beforeSettle: ((ctx: ExtensionContext) => Promise<void>) | undefined;
let active = cwd, restores = 0, restoreStats = 0, beforeStarts = 0;
let compactFrom: string | undefined;
const manager = SessionManager.inMemory(cwd);
const selected = () => manager.getBranch().filter((entry): entry is CustomEntry<{ cwd: string }> => entry.type === "custom" && entry.customType === selectedType);
const snapshots = () => manager.getBranch().filter((entry): entry is CustomMessageEntry<{ cwd: string; notice?: string }> => entry.type === "custom_message" && entry.customType === contextType);
const nativeSystems = () => manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "system");
const cwdOf = (messages: Message[]) => getCurrentSystemPrompt(messages).match(/<cwd>\n([\s\S]*?)\n<\/cwd>/)?.[1];
const current = () => requests.at(-1)!;
const prefix = (previous: Message[], later = current()) => assert.deepEqual(later.slice(0, previous.length), previous);

const factory: ExtensionFactory = pi => {
  pi.on("before_agent_start", event => {
    beforeStarts++;
    event.systemPromptOptions.sections.unrelated = unrelatedSection;
  });
  let originalMessages: unknown, originalCopy: unknown;
  pi.on("context_with_system", event => {
    originalMessages = event.messages;
    originalCopy = structuredClone(event.messages);
    for (const message of event.messages) {
      if (message.role === "system" && message.sections) Object.freeze(message.sections);
      Object.freeze(message);
    }
    Object.freeze(event.messages);
  });
  const record = registerCwdContext(pi, () => active);
  pi.on("context_with_system", () => { assert.deepEqual(originalMessages, originalCopy); });
  const restore = (ctx: ExtensionContext) => {
    restores++;
    const saved = selected().at(-1)?.data;
    active = ctx.cwd;
    if (saved) {
      restoreStats++;
      try { if (statSync(saved.cwd).isDirectory()) active = saved.cwd; } catch { /* Missing fixture directory. */ }
    }
    record(ctx, active, saved && active !== saved.cwd ? fallbackNotice : undefined);
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  const change = (ctx: ExtensionContext, path: string) => {
    active = path;
    pi.appendEntry(selectedType, { cwd: path });
    record(ctx, active, undefined, true);
  };
  pi.registerCommand("cwd", { description: "Select a fixture directory", handler: async (path, ctx) => change(ctx, path) });
  pi.registerCommand("record-again", { description: "Check unchanged snapshot deduplication", handler: async (_args, ctx) => record(ctx, active) });
  pi.registerTool({
    name: "change_dir", label: "change_dir", description: "Select a fixture directory", parameters: Type.Object({ path: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, args, _signal, _update, ctx) => {
      change(ctx, args.path);
      return { content: [{ type: "text", text: args.path }], details: {} };
    },
  });
  pi.registerTool({
    name: "fresh_context", label: "fresh_context", description: "Start a fork context window", parameters: Type.Object({}),
    execute: async (_id, _args, _signal, _update, ctx) => {
      assert.ok("newContext" in ctx && typeof ctx.newContext === "function");
      ctx.newContext({ handoff: "same-loop context boundary" });
      return { content: [{ type: "text", text: "fresh" }], details: {} };
    },
  });
  // Use the real compaction lifecycle, with a fixed summary instead of a provider call.
  pi.on("session_before_compact", (_event, ctx) => ({ compaction: {
    summary: "Earlier work summarized.", firstKeptEntryId: compactFrom ?? ctx.sessionManager.getLeafId()!, tokensBefore: 100,
  } }));
};

async function makeSession(reason: SessionStartEvent["reason"] = "startup", realExtension = false) {
  const runtime = createExtensionRuntime();
  const bus = createEventBus();
  const extension = await loadExtensionFromFactory(realExtension ? pi => {
    pi.on("before_agent_start", event => { event.systemPromptOptions.sections.unrelated = unrelatedSection; });
    pi.on("agent_before_settle", async (_event, ctx) => {
      const callback = beforeSettle;
      beforeSettle = undefined;
      await callback?.(ctx);
    });
  } : factory, cwd, bus, runtime);
  const extensions = [extension];
  if (realExtension) {
    const loaded = await loadExtensions([fileURLToPath(new URL("./index.ts", import.meta.url))], cwd, bus, runtime);
    assert.deepEqual(loaded.errors, []);
    extensions.push(...loaded.extensions);
  }
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
  const credentials = AuthStorage.inMemory();
  await credentials.modify(model.provider, async () => ({ type: "api_key", key: "fake-key-never-sent" }));
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const ref: { current?: ExtensionRunner } = {};
  const agent = new Agent({
    initialState: { model, tools: [], messages: manager.buildSessionContext().messages },
    getApiKey: () => "fake-key-never-sent", convertToLlm,
    transformContext: messages => ref.current ? ref.current.emitContext(messages) : Promise.resolve(messages),
    streamFn: (_model, context) => {
      requests.push(structuredClone(context.messages));
      assert.ok(getCurrentSystemPrompt(context.messages).includes(unrelatedSection));
      assert.deepEqual(getCurrentTools(context.messages).map(tool => tool.name).sort(),
        realExtension ? ["change_dir", "read", "write"] : ["change_dir", "fresh_context", "read"]);
      const message = responses.shift() ?? fauxAssistantMessage("done");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
      return stream;
    },
  });
  const session = new AgentSession({
    agent, sessionManager: manager, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } }),
    cwd, modelRuntime, resourceLoader,
    baseToolsOverride: { read: createReadTool(cwd), ...(realExtension ? { write: createWriteTool(cwd) } : {}) },
    extensionRunnerRef: ref,
    sessionStartEvent: { type: "session_start", reason },
  });
  session.subscribe(() => {});
  await session.bindExtensions({ onError: error => errors.push(error) });
  return session;
}

let session: Session | undefined;
try {
  session = await makeSession();
  assert.equal(snapshots().length, 0);
  await session.prompt(`/cwd ${next}`);
  assert.equal(requests.length, 0);
  assert.equal(beforeStarts, 0);
  assert.equal(nativeSystems().length, 0);
  responses.push(fauxAssistantMessage(fauxToolCall("change_dir", { path: third }), { stopReason: "toolUse" }), fauxAssistantMessage("changed"));
  await session.prompt("first prompt: change to C");
  assert.equal(requests.length, 2);
  assert.equal(cwdOf(requests[0]), next);
  assert.equal(cwdOf(requests[1]), third);
  prefix(requests[0], requests[1]);
  assert.equal(beforeStarts, 1);
  checks.push("idle /cwd before first prompt; same-loop change; exact prior request prefix");
  const treeTarget = manager.getLeafId()!;
  await session.prompt("continue at C");
  prefix(requests[1]);
  const nativeCount = nativeSystems().length, snapshotCount = snapshots().length;
  let prior = current();
  await session.prompt("unchanged C");
  await session.prompt("/record-again");
  prefix(prior);
  assert.equal(nativeSystems().length, nativeCount);
  assert.equal(snapshots().length, snapshotCount);
  checks.push("unchanged runs and repeated idle snapshots add no directory deltas");

  await session.prompt(`/cwd ${literal}`);
  prior = current();
  await session.prompt("literal path");
  assert.equal(cwdOf(current()), literal);
  prefix(prior);
  const literalRequest = current();
  const literalHistory = structuredClone(manager.getBranch());
  await session.prompt("literal path continuation");
  prefix(literalRequest);
  assert.deepEqual(manager.getBranch().slice(0, literalHistory.length), literalHistory);
  checks.push("literal backslashes survive the native prompt builder; historical entries unchanged");

  await session.prompt(`/cwd ${next}`);
  const originalSelected = structuredClone(selected());
  renameSync(next, hidden);
  session.dispose();
  session = await makeSession("resume");
  await session.prompt("restore with unavailable B");
  const verifyFallback = () => {
    assert.equal(active, cwd);
    assert.equal(cwdOf(current()), cwd);
    assert.ok(getCurrentSystemPrompt(current()).includes(fallbackNotice));
    assert.deepEqual(selected(), originalSelected);
  };
  verifyFallback();
  const historicalSnapshots = structuredClone(snapshots());
  assert.deepEqual(historicalSnapshots.map(entry => entry.details?.cwd), [next, third, literal, next, cwd]);
  const restoredAt = restores, statsAt = restoreStats;
  await session.compact();
  assert.ok(!manager.buildSessionProjection().messages.some(message => message.role === "custom" && message.customType === contextType));
  await session.prompt("fallback after compaction drops snapshots");
  verifyFallback();
  prior = current();
  renameSync(hidden, next);
  await session.prompt("B reappeared without restore");
  verifyFallback();
  prefix(prior);

  if ("newContext" in session && typeof session.newContext === "function") {
    session.newContext({ handoff: "keep the effective fallback" });
    await session.prompt("fresh context after B reappeared");
    verifyFallback();
    prior = current();
    await session.prompt("fresh continuation");
    verifyFallback();
    prefix(prior);
    responses.push(fauxAssistantMessage(fauxToolCall("fresh_context", {}), { stopReason: "toolUse" }), fauxAssistantMessage("fresh"));
    await session.prompt("start fresh in the same loop");
    verifyFallback();
    assert.ok(!current().some(message => message.role === "toolResult"));
    checks.push("fork fresh-context and same-loop fresh-context boundaries retain the effective fallback");
  }
  assert.deepEqual(snapshots(), historicalSnapshots);
  assert.equal(restores, restoredAt);
  assert.equal(restoreStats, statsAt);
  checks.push("fallback notice and effective A survive compaction/B reappearance without touching selected B or restatting");

  session.dispose();
  session = await makeSession("resume");
  await session.prompt("explicit restore now B is available");
  assert.equal(active, next);
  assert.equal(cwdOf(current()), next);
  assert.ok(!getCurrentSystemPrompt(current()).includes(fallbackNotice));
  assert.deepEqual(selected(), originalSelected);
  assert.deepEqual(snapshots().slice(0, historicalSnapshots.length), historicalSnapshots);
  const resumedSnapshots = snapshots().length;
  session.dispose();
  session = await makeSession("reload");
  await session.prompt("unchanged reload");
  assert.equal(snapshots().length, resumedSnapshots);
  checks.push("explicit restore reactivates B; unchanged reload adds no snapshot");

  await session.navigateTree(treeTarget, { summarize: false });
  assert.equal(active, third);
  await session.prompt("restored original C branch");
  assert.equal(cwdOf(current()), third);
  assert.deepEqual(snapshots().map(entry => entry.details?.cwd), [next, third]);
  assert.ok(!getCurrentSystemPrompt(current()).includes(fallbackNotice));
  prior = current();
  await session.prompt("branch continuation");
  prefix(prior);
  checks.push("native tree navigation restores branch-specific provenance and stable continuation");

  // Retain the change itself: the new head must use the state BEFORE that snapshot.
  await session.prompt(`/cwd ${next}`);
  compactFrom = snapshots().at(-1)!.id;
  await session.prompt("before retaining the B transition");
  await session.compact();
  await session.prompt("after retaining the B transition");
  assert.equal(cwdOf(current()), next);
  assert.equal(cwdOf([current()[0]]), third);
  prior = current();
  await session.prompt("retained transition continuation");
  prefix(prior);
  checks.push("retained-boundary baseline uses the prior effective directory, then replays the retained change");
  session.dispose();
  manager.newSession();
  session = await makeSession();
  await session.prompt("initial runtime directory");
  assert.equal(cwdOf(current()), cwd);
  assert.equal(snapshots().length, 0);
  const initialNativeCount = nativeSystems().length;
  prior = current();
  await session.prompt("unchanged runtime directory");
  prefix(prior);
  assert.equal(snapshots().length, 0);
  assert.equal(nativeSystems().length, initialNativeCount);
  checks.push("a new unchanged session needs no presentation snapshots");

  session.dispose();
  manager.newSession();
  session = await makeSession("startup", true);
  const requestsBeforeCommand = requests.length;
  await session.prompt(`/cwd ${next}`);
  assert.equal(requests.length, requestsBeforeCommand);
  responses.push(fauxAssistantMessage(fauxToolCall("change_dir", { path: third }), { stopReason: "toolUse" }), fauxAssistantMessage("changed"));
  await session.prompt("real extension: change to C");
  assert.equal(requests.length, requestsBeforeCommand + 2);
  assert.equal(cwdOf(requests[requestsBeforeCommand]), next);
  assert.equal(cwdOf(current()), third);
  prefix(requests[requestsBeforeCommand]);
  prior = current();
  await session.prompt("real extension: continue at C");
  assert.equal(cwdOf(current()), third);
  prefix(prior);
  checks.push("the real index.ts extension initializes native tools and preserves idle/same-loop cwd truth");

  const roundTrips: { modelCwd: string | undefined; snapshots: string[] }[] = [];
  for (const start of [third, cwd]) {
    session.dispose();
    manager.newSession();
    session = await makeSession("startup", true);
    if (start !== cwd) await session.prompt(`/cwd ${start}`);
    await session.prompt("establish the starting directory");
    assert.equal(cwdOf(current()), start);
    const beforeSnapshots = snapshots().length;
    const beforeRequests: number = requests.length;
    responses.push(fauxAssistantMessage([
      fauxToolCall("change_dir", { path: next }),
      fauxToolCall("change_dir", { path: start }),
    ], { stopReason: "toolUse" }), fauxAssistantMessage("returned"));
    prior = current();
    await session.prompt("change to B and back in one tool batch");
    assert.equal(requests.length, beforeRequests + 2);
    prefix(prior, requests[beforeRequests]);
    prefix(requests[beforeRequests]);
    const results = current().filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "change_dir");
    assert.deepEqual(results.at(-1)?.details, { cwd: start }, "the last change_dir executed the return to the starting directory");

    roundTrips.push({ modelCwd: cwdOf(current()), snapshots: snapshots().slice(beforeSnapshots).map(entry => entry.details!.cwd) });
  }
  assert.deepEqual(roundTrips, [
    { modelCwd: third, snapshots: [next, third] },
    { modelCwd: cwd, snapshots: [next, cwd] },
  ], "queued return snapshots must survive both persisted-state and initial-anchor deduplication");
  checks.push("real same-batch B→C and B→initial-anchor returns preserve both queued snapshots and final cwd");

  const existingFile = join(cwd, "existing.txt");
  writeFileSync(existingFile, "ORIGINAL\n");
  responses.push(fauxAssistantMessage([
    fauxToolCall("change_dir", { path: join(root, "missing-worktree") }),
    fauxToolCall("write", { path: "existing.txt", content: "OVERWRITTEN\n" }),
  ], { stopReason: "toolUse" }), fauxAssistantMessage("finished"));
  await session.prompt("change to the missing worktree, then write the file");
  const failedBatch = current().filter((message): message is ToolResultMessage => message.role === "toolResult").slice(-2);
  assert.deepEqual(failedBatch.map((message) => [message.toolName, message.isError]), [
    ["change_dir", true], ["write", true],
  ], "a failed directory change must block later calls in the same batch");
  assert.equal(readFileSync(existingFile, "utf8"), "ORIGINAL\n");
  responses.push(fauxAssistantMessage(fauxToolCall("read", { path: "existing.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("read"));
  await session.prompt("read the original file on the next turn");
  const nextRead = current().filter((message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "read").at(-1);
  assert.equal(nextRead?.isError, false);
  assert.match(nextRead.content[0].type === "text" ? nextRead.content[0].text : "", /ORIGINAL/);
  checks.push("failed change_dir does not let a sibling overwrite a file in the original directory");

  await session.prompt(`/cwd ${third}`);
  await session.prompt("establish C before settlement commands");
  const beforeSettlementSnapshots = snapshots().length;
  beforeSettle = async ctx => {
    assert.equal(session!.agent.signal, undefined, "the low-level run has ended");
    assert.equal(ctx.isIdle(), false, "the session has not settled");
    assert.equal(session!.isStreaming, true, "native custom messages still queue until settlement");
    await session!.prompt(`/cwd ${next}`);
    await session!.prompt(`/cwd ${third}`);
  };
  await session.prompt("change directory while the session is settling");
  await session.prompt("continue after settlement commands");
  assert.equal(cwdOf(current()), third, "queued settlement commands must restore C in model context");
  assert.deepEqual(snapshots().slice(beforeSettlementSnapshots).map(entry => entry.details!.cwd), [next, third]);
  checks.push("commands between the low-level agent run and session settlement preserve queued cwd changes");

  assert.deepEqual(errors, []);
  console.log(`Context checks passed (${process.env.PI_PACKAGE_DIR ? "PI_PACKAGE_DIR" : "pinned package"}):\n- ${checks.join("\n- ")}`);
} finally {
  session?.dispose();
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
