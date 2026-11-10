/** Native request/branch regression checks; PI_PACKAGE_DIR optionally selects a fork installation. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession as Session,
  CustomEntry,
  CustomMessageEntry,
  ExtensionContext,
  ExtensionError,
  ExtensionFactory,
  ExtensionRunner,
  ResourceLoader,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { host, loader, messages, authStorage, agentCore, ai, aiProvidersAll } from "./test-host.ts";
const { AgentSession, SessionManager, SettingsManager, ModelRuntime, createEventBus } = host;
const { createExtensionRuntime, loadExtensionFromFactory, loadExtensions } = loader;
const { convertToLlm } = messages;
const { AuthStorage } = authStorage;
const { Agent } = agentCore;
const {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  createAssistantMessageEventStream,
} = ai;
import { registerCwdContext } from "./cwd-context.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-context-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const cwd = join(root, "A"),
  next = join(root, "B"),
  third = join(root, "C"),
  hidden = join(root, "B-hidden");
const literal = join(root, process.platform === "win32" ? "literal" : "literal\\backslash");
for (const path of [cwd, next, third, literal]) {
  mkdirSync(path);
}
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("Context tests must not make network requests");
};
const model = structuredClone(aiProvidersAll.getBuiltinModel("openai", "gpt-6-astra"));
const selectedType = "test:selected-cwd",
  contextType = "change-working-dir:context";
const fallbackNotice =
  "The saved directory is unavailable; using the session directory until the next restore.";
const unrelatedSection = "An unrelated extension's instructions must survive.";
const requests: Message[][] = [],
  responses: AssistantMessage[] = [],
  errors: ExtensionError[] = [];
let presenting = false,
  presentationBranches = 0,
  presentationProjections = 0;
const checks: string[] = [];
let beforeSettle: ((ctx: ExtensionContext) => Promise<void>) | undefined;
let active = cwd,
  restores = 0,
  restoreStats = 0,
  beforeStarts = 0;
let compactFrom: string | undefined;
const manager = SessionManager.inMemory(cwd);
const getBranch = manager.getBranch.bind(manager);
manager.getBranch = (...args) => {
  if (presenting) {
    presentationBranches++;
  }
  return getBranch(...args);
};
const buildProjection = manager.buildSessionProjection.bind(manager);
manager.buildSessionProjection = (...args) => {
  if (presenting) {
    presentationProjections++;
  }
  return buildProjection(...args);
};
const selected = () =>
  manager
    .getBranch()
    .filter(
      (entry): entry is CustomEntry<{ cwd: string }> =>
        entry.type === "custom" && entry.customType === selectedType,
    );
const snapshots = () =>
  manager
    .getBranch()
    .filter(
      (entry): entry is CustomMessageEntry<{ cwd: string; notice?: string }> =>
        entry.type === "custom_message" && entry.customType === contextType,
    );
const nativeSystems = () =>
  manager
    .getBranch()
    .filter((entry) => entry.type === "message" && entry.message.role === "system");
const cwdOf = (prompt: Message[]) =>
  getCurrentSystemPrompt(prompt).match(/<cwd>\n([\s\S]*?)\n<\/cwd>/)?.[1];
const current = () => item(requests, requests.length - 1);
/** Checked index access: the surrounding assertions establish the element exists. */
function item<T>(list: T[], index: number): T {
  const value: T | undefined = list[index];
  if (value === undefined) {
    throw new Error(`missing element ${index}`);
  }
  return value;
}
const prefix = (previous: Message[], later = current()) =>
  assert.deepEqual(later.slice(0, previous.length), previous);

const factory: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", (event) => {
    beforeStarts++;
    // oxlint-disable-next-line no-param-reassign -- QX-001: the host documents systemPromptOptions as mutable here.
    event.systemPromptOptions.sections.unrelated = unrelatedSection;
  });
  let originalMessages: unknown, originalCopy: unknown;
  pi.on("context_with_system", (event) => {
    presenting = true;
    originalMessages = event.messages;
    originalCopy = structuredClone(event.messages);
    for (const message of event.messages) {
      if (message.role === "system" && message.sections) {
        Object.freeze(message.sections);
      }
      Object.freeze(message);
    }
    Object.freeze(event.messages);
  });
  const record = registerCwdContext(pi, () => active);
  pi.on("context_with_system", () => {
    presenting = false;
    assert.deepEqual(originalMessages, originalCopy);
  });
  const restore = (ctx: ExtensionContext) => {
    restores++;
    const saved = selected().at(-1)?.data;
    active = ctx.cwd;
    if (saved) {
      restoreStats++;
      try {
        if (statSync(saved.cwd).isDirectory()) {
          active = saved.cwd;
        }
      } catch {
        /* Missing fixture directory. */
      }
    }
    record(ctx, active, { notice: saved && active !== saved.cwd ? fallbackNotice : undefined });
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  const change = (ctx: ExtensionContext, path: string) => {
    active = path;
    pi.appendEntry(selectedType, { cwd: path });
    record(ctx, active, { changed: true });
  };
  pi.registerCommand("cwd", {
    description: "Select a fixture directory",
    handler: async (path, ctx) => change(ctx, path),
  });
  pi.registerCommand("record-again", {
    description: "Check unchanged snapshot deduplication",
    handler: async (_args, ctx) => record(ctx, active),
  });
  pi.registerTool({
    name: "change_dir",
    label: "change_dir",
    description: "Select a fixture directory",
    parameters: Type.Object({ path: Type.String() }),
    executionMode: "sequential",
    execute: async (_id, args, _signal, _update, ctx) => {
      change(ctx, args.path);
      return { content: [{ type: "text", text: args.path }], details: {} };
    },
  });
  // Use the real compaction lifecycle, with a fixed summary instead of a provider call.
  pi.on("session_before_compact", (_event, ctx) => {
    const leafId = ctx.sessionManager.getLeafId();
    assert.ok(leafId !== null, "the branch has a leaf");
    return {
      compaction: {
        summary: "Earlier work summarized.",
        firstKeptEntryId: compactFrom !== undefined ? compactFrom : leafId,
        tokensBefore: 100,
      },
    };
  });
};

async function makeSession(reason: SessionStartEvent["reason"] = "startup", realExtension = false) {
  const runtime = createExtensionRuntime();
  const bus = createEventBus();
  const extension = await loadExtensionFromFactory(
    realExtension
      ? (pi) => {
          pi.on("before_agent_start", (event) => {
            // oxlint-disable-next-line no-param-reassign -- QX-001: the host documents systemPromptOptions as mutable here.
            event.systemPromptOptions.sections.unrelated = unrelatedSection;
          });
          pi.on("agent_before_settle", async (_event, ctx) => {
            const callback = beforeSettle;
            beforeSettle = undefined;
            await callback?.(ctx);
          });
          pi.registerTool({
            name: "nested_cwd",
            label: "nested cwd",
            description: "Native composition fixture",
            parameters: Type.Object({ path: Type.String() }),
            executionMode: "sequential",
            async execute(_id, args, _signal, _update, ctx) {
              const change = await ctx.executeTool("change_dir", { path: args.path });
              const read = await ctx.executeTool("read", { path: "nested.txt" });
              return {
                content: read.result.content,
                details: {
                  changed: change.isError,
                  readError: read.isError,
                  receipt: read.result.details as unknown,
                },
              };
            },
          });
        }
      : factory,
    cwd,
    bus,
    runtime,
  );
  const extensions = [extension];
  if (realExtension) {
    const loaded = await loadExtensions(
      [fileURLToPath(new URL("./index.ts", import.meta.url))],
      cwd,
      bus,
      runtime,
    );
    assert.deepEqual(loaded.errors, []);
    extensions.push(...loaded.extensions);
  }
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions, errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    // oxlint-disable-next-line no-useless-undefined -- QX-003: the loader contract requires a `string | undefined` return.
    getSystemPrompt: () => undefined,
    // oxlint-disable-next-line no-useless-undefined -- QX-003: the loader contract requires a `string | undefined` return.
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    // oxlint-disable-next-line no-empty-function -- QX-006: the loader contract mandates a no-op here.
    extendResources() {},
    // oxlint-disable-next-line no-empty-function -- QX-006: the loader contract mandates a no-op here.
    async reload() {},
  };
  const credentials = AuthStorage.inMemory();
  await credentials.modify(model.provider, async () => ({
    type: "api_key",
    key: "fake-key-never-sent",
  }));
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
  });
  const ref: { current?: ExtensionRunner } = {};
  const agent = new Agent({
    initialState: { model, tools: [], messages: manager.buildSessionContext().messages },
    getApiKey: () => "fake-key-never-sent",
    convertToLlm,
    transformContext: (prompt) =>
      ref.current ? ref.current.emitContext(prompt) : Promise.resolve(prompt),
    streamFn: (_model, context) => {
      requests.push(structuredClone(context.messages));
      assert.ok(getCurrentSystemPrompt(context.messages).includes(unrelatedSection));
      assert.deepEqual(
        getCurrentTools(context.messages)
          .map((tool) => tool.name)
          .sort(),
        realExtension
          ? ["bash", "change_dir", "edit", "nested_cwd", "read", "write"]
          : ["change_dir", "read"],
      );
      const message = responses.shift() ?? fauxAssistantMessage("done");
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      return stream;
    },
  });
  const session = new AgentSession({
    agent,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1 },
    }),
    cwd,
    modelRuntime,
    resourceLoader,
    ...(realExtension ? {} : { initialActiveToolNames: ["read"] }),
    extensionRunnerRef: ref,
    sessionStartEvent: { type: "session_start", reason },
  });
  // oxlint-disable-next-line no-empty-function -- QX-006: the test ignores subscription events.
  session.subscribe(() => {});
  await session.bindExtensions({ onError: (error) => errors.push(error) });
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
  responses.push(
    fauxAssistantMessage(fauxToolCall("change_dir", { path: third }), { stopReason: "toolUse" }),
    fauxAssistantMessage("changed"),
  );
  await session.prompt("first prompt: change to C");
  assert.equal(requests.length, 2);
  assert.equal(cwdOf(item(requests, 0)), next);
  assert.equal(cwdOf(item(requests, 1)), third);
  prefix(item(requests, 0), item(requests, 1));
  assert.equal(beforeStarts, 1);
  checks.push("idle /cwd before first prompt; same-loop change; exact prior request prefix");
  const treeTarget = manager.getLeafId();
  assert.ok(treeTarget !== null, "the branch has a leaf");
  await session.prompt("continue at C");
  prefix(item(requests, 1));
  const nativeCount = nativeSystems().length,
    snapshotCount = snapshots().length;
  let prior = current();
  const branchesBefore = presentationBranches,
    projectionsBefore = presentationProjections;
  await session.prompt("unchanged C");
  await session.prompt("/record-again");
  prefix(prior);
  assert.equal(nativeSystems().length, nativeCount);
  assert.equal(snapshots().length, snapshotCount);
  assert.equal(
    presentationBranches,
    branchesBefore,
    "unchanged provider requests do not copy full cwd history",
  );
  assert.equal(
    presentationProjections,
    projectionsBefore,
    "unchanged provider requests do not rebuild cwd projection",
  );
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
  checks.push(
    "literal backslashes survive the native prompt builder; historical entries unchanged",
  );

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
  assert.deepEqual(
    historicalSnapshots.map((entry) => entry.details?.cwd),
    [next, third, literal, next, cwd],
  );
  const restoredAt = restores,
    statsAt = restoreStats;
  await session.compact();
  assert.ok(
    !manager
      .buildSessionProjection()
      .messages.some((message) => message.role === "custom" && message.customType === contextType),
  );
  await session.prompt("fallback after compaction drops snapshots");
  verifyFallback();
  prior = current();
  renameSync(hidden, next);
  await session.prompt("B reappeared without restore");
  verifyFallback();
  prefix(prior);

  manager.appendCompaction("", null, 100);
  session.agent.state.messages = manager.buildSessionContext().messages;
  await session.prompt("fallback after summary-free retain-none compaction");
  verifyFallback();
  assert.equal(
    manager.buildSessionProjection().messages.filter((message) => message.role === "user").length,
    1,
  );
  assert.ok(!current().some((message) => message.role === "toolResult"));
  checks.push("native summary-free retain-none compaction preserves the effective fallback");
  assert.deepEqual(snapshots(), historicalSnapshots);
  assert.equal(restores, restoredAt);
  assert.equal(restoreStats, statsAt);
  checks.push(
    "fallback notice and effective A survive compaction/B reappearance without touching selected B or restatting",
  );

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
  assert.deepEqual(
    snapshots().map((entry) => entry.details?.cwd),
    [next, third],
  );
  assert.ok(!getCurrentSystemPrompt(current()).includes(fallbackNotice));
  prior = current();
  await session.prompt("branch continuation");
  prefix(prior);
  checks.push("native tree navigation restores branch-specific provenance and stable continuation");

  // Retain the change itself: the new head must use the state BEFORE that snapshot.
  await session.prompt(`/cwd ${next}`);
  const retainFrom = snapshots().at(-1);
  assert.ok(retainFrom, "the B transition snapshot exists");
  compactFrom = retainFrom.id;
  await session.prompt("before retaining the B transition");
  await session.compact();
  await session.prompt("after retaining the B transition");
  assert.equal(cwdOf(current()), next);
  assert.equal(cwdOf([item(current(), 0)]), third);
  prior = current();
  await session.prompt("retained transition continuation");
  prefix(prior);
  checks.push(
    "retained-boundary baseline uses the prior effective directory, then replays the retained change",
  );
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
  responses.push(
    fauxAssistantMessage(fauxToolCall("change_dir", { path: third }), { stopReason: "toolUse" }),
    fauxAssistantMessage("changed"),
  );
  await session.prompt("real extension: change to C");
  assert.equal(requests.length - requestsBeforeCommand, 2);
  assert.equal(cwdOf(item(requests, requestsBeforeCommand)), next);
  assert.equal(cwdOf(current()), third);
  prefix(item(requests, requestsBeforeCommand));
  prior = current();
  await session.prompt("real extension: continue at C");
  assert.equal(cwdOf(current()), third);
  prefix(prior);
  checks.push(
    "the real index.ts extension initializes native tools and preserves idle/same-loop cwd truth",
  );

  const roundTrips: { modelCwd: string | undefined; snapshots: string[] }[] = [];
  for (const start of [third, cwd]) {
    session.dispose();
    manager.newSession();
    session = await makeSession("startup", true);
    if (start !== cwd) {
      await session.prompt(`/cwd ${start}`);
    }
    await session.prompt("establish the starting directory");
    assert.equal(cwdOf(current()), start);
    const beforeSnapshots = snapshots().length;
    const beforeRequests: number = requests.length;
    responses.push(
      fauxAssistantMessage(
        [fauxToolCall("change_dir", { path: next }), fauxToolCall("change_dir", { path: start })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("returned"),
    );
    prior = current();
    await session.prompt("change to B and back in one tool batch");
    assert.equal(requests.length, beforeRequests + 2);
    prefix(prior, item(requests, beforeRequests));
    prefix(item(requests, beforeRequests));
    const results = current().filter(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolName === "change_dir",
    );
    assert.deepEqual(
      results.at(-1)?.details,
      { cwd: start },
      "the last change_dir executed the return to the starting directory",
    );

    roundTrips.push({
      modelCwd: cwdOf(current()),
      snapshots: snapshots()
        .slice(beforeSnapshots)
        .map((entry) => {
          assert.ok(entry.details, "snapshot carries details");
          return entry.details.cwd;
        }),
    });
  }
  assert.deepEqual(
    roundTrips,
    [
      { modelCwd: third, snapshots: [next, third] },
      { modelCwd: cwd, snapshots: [next, cwd] },
    ],
    "queued return snapshots must survive both persisted-state and initial-anchor deduplication",
  );
  checks.push(
    "real same-batch B→C and B→initial-anchor returns preserve both queued snapshots and final cwd",
  );

  const existingFile = join(cwd, "existing.txt");
  writeFileSync(existingFile, "ORIGINAL\n");
  responses.push(
    fauxAssistantMessage(
      [
        fauxToolCall("change_dir", { path: join(root, "missing-worktree") }),
        fauxToolCall("write", { path: "existing.txt", content: "OVERWRITTEN\n" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("finished"),
  );
  await session.prompt("change to the missing worktree, then write the file");
  const failedBatch = current()
    .filter((message): message is ToolResultMessage => message.role === "toolResult")
    .slice(-2);
  assert.deepEqual(
    failedBatch.map((message) => [message.toolName, message.isError]),
    [
      ["change_dir", true],
      ["write", true],
    ],
    "a failed directory change must block later calls in the same batch",
  );
  assert.equal(readFileSync(existingFile, "utf8"), "ORIGINAL\n");
  responses.push(
    fauxAssistantMessage(fauxToolCall("read", { path: "existing.txt" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("read"),
  );
  await session.prompt("read the original file on the next turn");
  const nextRead = current().findLast(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolName === "read",
  );
  assert.ok(nextRead, "the read tool result exists");
  assert.equal(nextRead.isError, false);
  const readBlock = nextRead.content[0];
  assert.match(
    readBlock !== undefined && readBlock.type === "text" ? readBlock.text : "",
    /ORIGINAL/,
  );
  checks.push(
    "failed change_dir does not let a sibling overwrite a file in the original directory",
  );

  responses.push(
    fauxAssistantMessage(
      [
        fauxToolCall("change_dir", { path: next }),
        fauxToolCall("write", { path: "sibling.txt", content: "IN B\n" }),
        fauxToolCall("bash", { command: "pwd" }),
      ],
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("finished"),
  );
  await session.prompt("change to B, then write a file and run a command there");
  const sharedBatch = current()
    .filter((message): message is ToolResultMessage => message.role === "toolResult")
    .slice(-3);
  assert.deepEqual(
    sharedBatch.map((message) => [message.toolName, message.isError]),
    [
      ["change_dir", false],
      ["write", false],
      ["bash", false],
    ],
  );
  assert.equal(readFileSync(join(next, "sibling.txt"), "utf8"), "IN B\n");
  assert.equal(existsSync(join(cwd, "sibling.txt")), false);
  const pwdBlock = item(sharedBatch, 2).content[0];
  assert.equal(
    pwdBlock !== undefined && pwdBlock.type === "text" ? pwdBlock.text.trim() : "",
    next,
  );
  checks.push("calls after change_dir in the same response run in the new directory");

  await session.prompt(`/cwd ${third}`);
  await session.prompt("establish C before settlement commands");
  const beforeSettlementSnapshots = snapshots().length;
  beforeSettle = async (ctx) => {
    assert.ok(session, "the session is live during settlement");
    assert.equal(session.agent.signal, undefined, "the low-level run has ended");
    assert.equal(ctx.isIdle(), false, "the session has not settled");
    assert.equal(session.isStreaming, true, "native custom messages still queue until settlement");
    await session.prompt(`/cwd ${next}`);
    await session.prompt(`/cwd ${third}`);
  };
  await session.prompt("change directory while the session is settling");
  await session.prompt("continue after settlement commands");
  assert.equal(
    cwdOf(current()),
    third,
    "queued settlement commands must restore C in model context",
  );
  assert.deepEqual(
    snapshots()
      .slice(beforeSettlementSnapshots)
      .map((entry) => {
        assert.ok(entry.details, "snapshot carries details");
        return entry.details.cwd;
      }),
    [next, third],
  );
  checks.push(
    "commands between the low-level agent run and session settlement preserve queued cwd changes",
  );

  writeFileSync(join(next, "nested.txt"), "NESTED_B\n");
  writeFileSync(join(third, "nested.txt"), "NESTED_C\n");
  responses.push(
    fauxAssistantMessage(fauxToolCall("nested_cwd", { path: next }), { stopReason: "toolUse" }),
    fauxAssistantMessage("composed"),
  );
  await session.prompt("compose change and read through native executeTool");
  const composed = current().findLast(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolName === "nested_cwd",
  );
  assert.ok(composed, "the nested_cwd tool result exists");
  assert.equal(composed.isError, false);
  assert.partialDeepStrictEqual(composed.details, {
    changed: false,
    readError: false,
    receipt: { workingDirectory: next },
  });
  const composedBlock = composed.content[0];
  assert.match(
    composedBlock !== undefined && composedBlock.type === "text" ? composedBlock.text : "",
    /NESTED_B/,
  );
  responses.push(
    fauxAssistantMessage(fauxToolCall("nested_cwd", { path: join(root, "missing-nested") }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("denied"),
  );
  await session.prompt("compose a failed directory change and dependent read");
  const denied = current().findLast(
    (message): message is ToolResultMessage =>
      message.role === "toolResult" && message.toolName === "nested_cwd",
  );
  assert.partialDeepStrictEqual(denied?.details, { changed: true, readError: true });
  const deniedBlock = denied?.content[0];
  assert.match(
    deniedBlock !== undefined && deniedBlock.type === "text" ? deniedBlock.text : "",
    /change_dir failed/,
  );
  checks.push(
    "native nested calls capture selected cwd and deny dependent work after a failed change",
  );

  assert.deepEqual(errors, []);
  console.log(
    `Context checks passed (${
      process.env.PI_PACKAGE_DIR !== undefined && process.env.PI_PACKAGE_DIR !== ""
        ? "PI_PACKAGE_DIR"
        : "pinned package"
    }):\n- ${checks.join("\n- ")}`,
  );
} finally {
  session?.dispose();
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  rmSync(root, { recursive: true, force: true });
}
