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
/** Stands for a system message that the host or another extension keeps directly after the leading one. */
const leadingNote: Message = { role: "system", content: "Another leading note.", timestamp: 0 };
let withLeadingNote = false;
/** The number of kept messages of the compaction that `asSummaryBlockContext` presents with a block. */
let summaryBlockKept: number | undefined;
/**
 * The context of a host that starts a compacted window with a provider summary block: the block on
 * the leading system message, the `kept` messages, the compaction summary, then the later messages.
 * The host under test puts the summary in front of the kept messages.
 */
function asSummaryBlockContext<T extends { role: string }>(context: T[], kept: number): T[] {
  const summary = context.findIndex((message) => message.role === "compactionSummary");
  if (summary === -1) {
    return context;
  }
  const lead = {
    ...item(context, 0),
    providerSummary: {
      provider: "anthropic",
      api: "anthropic-messages",
      model: "claude",
      block: { type: "compaction", content: "Earlier work.", signature: "sig" },
      timestamp: 0,
    },
  };
  const afterSummary = summary + 1;
  return [
    lead,
    ...context.slice(1, summary),
    ...context.slice(afterSummary, afterSummary + kept),
    item(context, summary),
    ...context.slice(afterSummary + kept),
  ];
}
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
/** What a provider receives first: the prompt and the tool list of the leading system message alone. */
const leading = (prompt: Message[]) => {
  const first = item(prompt, 0);
  return { prompt: getCurrentSystemPrompt([first]), tools: getCurrentTools([first]) };
};
/** The directory that each system message of a request states, in request order. */
const cwdTrail = (prompt: Message[]) =>
  prompt
    .filter((message) => message.role === "system")
    .map((message) => cwdOf([message]))
    .filter((directory) => directory !== undefined);
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
    const hostMessages =
      summaryBlockKept === undefined
        ? event.messages
        : asSummaryBlockContext(event.messages, summaryBlockKept);
    const transcript = withLeadingNote
      ? [item(hostMessages, 0), leadingNote, ...hostMessages.slice(1)]
      : hostMessages;
    originalMessages = transcript;
    originalCopy = structuredClone(transcript);
    for (const message of transcript) {
      if (message.role === "system" && message.sections) {
        Object.freeze(message.sections);
      }
      Object.freeze(message);
    }
    Object.freeze(transcript);
    return { messages: transcript };
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
    record(ctx, active, {
      kind: "restore",
      notice: saved && active !== saved.cwd ? fallbackNotice : undefined,
    });
  };
  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  const change = (ctx: ExtensionContext, path: string) => {
    active = path;
    pi.appendEntry(selectedType, { cwd: path });
    record(ctx, active, { kind: "change" });
  };
  pi.registerCommand("cwd", {
    description: "Select a fixture directory",
    handler: async (path, ctx) => change(ctx, path),
  });
  pi.registerCommand("record-again", {
    description: "Check unchanged snapshot deduplication",
    handler: async (_args, ctx) => record(ctx, active, { kind: "restore" }),
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

async function makeSession(
  reason: SessionStartEvent["reason"] = "startup",
  realExtension = false,
  journal: { manager: typeof manager; cwd: string } = { manager, cwd },
) {
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
    journal.cwd,
    bus,
    runtime,
  );
  const extensions = [extension];
  if (realExtension) {
    const loaded = await loadExtensions(
      [fileURLToPath(new URL("./index.ts", import.meta.url))],
      journal.cwd,
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
    initialState: { model, tools: [], messages: journal.manager.buildSessionContext().messages },
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
    sessionManager: journal.manager,
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false, keepRecentTokens: 1 },
    }),
    cwd: journal.cwd,
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
  const started = leading(item(requests, 0));
  assert.ok(
    started.prompt.includes(unrelatedSection) && started.tools.length > 0,
    "the request starts with the session's prompt and tools, not with a snapshot saved before the first prompt",
  );
  checks.push(
    "idle /cwd before first prompt follows the leading system message; same-loop change; exact prior request prefix",
  );
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
    assert.deepEqual(
      leading(current()),
      started,
      "the fallback directory and its notice are an update; the leading system message stays the session's first",
    );
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
    "fallback notice and effective A survive compaction/B reappearance without touching selected B, the leading system message, or restatting",
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

  // Retain the change itself: the state BEFORE that snapshot follows the leading system message.
  await session.prompt(`/cwd ${next}`);
  const retainFrom = snapshots().at(-1);
  assert.ok(retainFrom, "the B transition snapshot exists");
  compactFrom = retainFrom.id;
  await session.prompt("before retaining the B transition");
  await session.compact();
  await session.prompt("after retaining the B transition");
  assert.equal(cwdOf(current()), next);
  assert.deepEqual(
    leading(current()),
    started,
    "a compaction after directory changes keeps the leading system message",
  );
  assert.deepEqual(
    cwdTrail(current()).slice(0, 3),
    [next, third, next],
    "the directory from before the kept entries follows the leading system message, then the kept change replays",
  );
  prior = current();
  await session.prompt("retained transition continuation");
  prefix(prior);
  checks.push(
    "retained boundary: the leading system message is unchanged, the prior effective directory follows it, then the retained change replays",
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

  // A forked child session: its own header and directory, then a copy of the parent's branch.
  const parentRequest = current();
  const forkFile = join(root, "fork.jsonl");
  writeFileSync(
    forkFile,
    `${[SessionManager.create(third, root).getHeader(), ...manager.getBranch()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const fork = SessionManager.open(forkFile);
  const forkSnapshots = () =>
    fork
      .getBranch()
      .filter(
        (entry): entry is CustomMessageEntry<{ cwd: string }> =>
          entry.type === "custom_message" && entry.customType === contextType,
      )
      .map((entry) => entry.details?.cwd);
  session.dispose();
  session = await makeSession("startup", false, { manager: fork, cwd: third });
  await session.prompt("forked child in another directory");
  prefix(parentRequest);
  assert.equal(cwdOf(current()), third);
  assert.deepEqual(forkSnapshots(), [third]);
  compactFrom = undefined;
  await session.compact();
  await session.prompt("forked child after its own compaction");
  assert.equal(cwdOf(current()), third);
  assert.deepEqual(
    leading(current()),
    leading(parentRequest),
    "a forked child keeps the parent's leading system message across its own compaction",
  );
  checks.push(
    "a forked child in another directory keeps the parent's leading prompt, also across its own compaction, then records and keeps its own directory",
  );

  session.dispose();
  manager.newSession();
  session = await makeSession();
  await session.prompt("before any directory change");
  const unchanged = leading(current());
  withLeadingNote = true;
  for (const directory of [next, third, cwd, literal]) {
    await session.prompt(`/cwd ${directory}`);
    await session.prompt("work in the selected directory");
    await session.compact();
    await session.prompt("first request after the compaction");
    assert.equal(cwdOf(current()), directory);
    assert.deepEqual(
      leading(current()),
      unchanged,
      "every compaction after a directory change keeps the leading system message",
    );
    const conversation = current().findIndex((message) => message.role !== "system");
    assert.deepEqual(
      current()
        .slice(1, conversation)
        .map((message) => cwdOf([message])),
      [undefined, directory],
      "one update with the directory from before the window stands after the other leading system messages",
    );
    prior = current();
    await session.prompt("continue after the compaction");
    prefix(prior);
  }
  withLeadingNote = false;
  checks.push(
    "repeated directory changes and compactions keep the leading system message; one update follows the leading system messages and keeps its place",
  );

  // The provider keeps the reasoning of the kept messages only while they follow the block directly.
  session.dispose();
  manager.newSession();
  session = await makeSession();
  await session.prompt("before any directory change");
  await session.prompt(`/cwd ${next}`);
  await session.prompt("work that the block summarizes");
  await session.prompt("work that the compaction keeps");
  const keptFrom = manager
    .getBranch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(keptFrom, "the kept prompt exists");
  compactFrom = keptFrom.id;
  summaryBlockKept = 2;
  await session.compact();
  await session.prompt("first request after the summary block");
  const afterBlock = current();
  const firstKept = afterBlock.findIndex((message) => message.role !== "system");
  assert.deepEqual(
    cwdTrail(afterBlock.slice(0, firstKept)),
    [cwd],
    "no directory update stands between the summary block and the kept messages",
  );
  const summaryAt = afterBlock.findIndex((message) =>
    JSON.stringify(message).includes("Earlier work summarized."),
  );
  assert.ok(summaryAt > firstKept, "the summary follows the kept messages");
  assert.equal(
    cwdOf([item(afterBlock, summaryAt + 1)]),
    next,
    "the update with the directory from before the window stands directly after the summary",
  );
  assert.equal(cwdOf(afterBlock), next);
  await session.prompt("continue after the summary block");
  prefix(afterBlock);
  checks.push(
    "after a compaction with a provider summary block the kept messages follow the block; the directory update follows the summary and keeps its place",
  );

  // A directory change among the kept messages is the one in effect.
  session.dispose();
  manager.newSession();
  session = await makeSession();
  await session.prompt("before any directory change");
  await session.prompt(`/cwd ${next}`);
  await session.prompt("work that the block summarizes");
  const keptReply = manager
    .getBranch()
    .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
  assert.ok(keptReply, "the kept reply exists");
  compactFrom = keptReply.id;
  await session.prompt(`/cwd ${third}`);
  await session.prompt("work that the compaction keeps");
  // The kept messages: the reply, the change to C, the prompt and its reply.
  summaryBlockKept = 4;
  await session.compact();
  await session.prompt("first request after the summary block");
  assert.deepEqual(
    cwdTrail(current()),
    [cwd, third],
    "the update from before the window is not sent after a newer one among the kept messages",
  );
  assert.equal(cwdOf(current()), third);
  compactFrom = undefined;
  summaryBlockKept = undefined;
  checks.push(
    "a directory change among the kept messages of a provider summary block stays the directory in effect",
  );

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
