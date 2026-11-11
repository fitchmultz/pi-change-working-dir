import type {
  ContextWithSystemEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isRecord } from "./native-paths.ts";

const CONTEXT_TYPE = "change-working-dir:context";

type Snapshot = { cwd: string; notice?: string | undefined };

type Messages = ContextWithSystemEvent["messages"];

type DirectoryUpdate = Extract<Messages[number], { role: "system" }>;

/** What the journal says about the directory outside the messages of the current context window. */
type Carried = {
  /** The directory sections of the leading system message. They never change within a journal. */
  leading: Record<string, string | null>;
  /** The last directory update that a compaction removed from the window, if there is one. */
  update: DirectoryUpdate | undefined;
};

/** The carried sections and the journal prefix they were read from. */
type PrefixCache = {
  manager: ExtensionContext["sessionManager"];
  leaf: string | null;
  sections: Carried;
};

/** Why a snapshot is recorded: a change is always new, a restore may repeat the journal. */
export type CwdRecord = { kind: "change" } | { kind: "restore"; notice?: string | undefined };

/** The saved context snapshot of a journal entry, when it carries a valid one. */
function snapshot(details: unknown): Snapshot | undefined {
  if (!isRecord(details)) {
    return;
  }
  const cwd: unknown = details.cwd;
  const notice: unknown = details.notice;
  if (typeof cwd !== "string") {
    return;
  }
  if (notice !== undefined && typeof notice !== "string") {
    return;
  }
  return { cwd, notice: typeof notice === "string" ? notice : undefined };
}

/** The directory section as Pi records it in a system message. */
function cwdSection(cwd: string): string {
  return `<cwd>\n${cwd}\n</cwd>`;
}

/** The system message that tells the model the directory and notice of a snapshot. */
function directoryUpdate(state: Snapshot, timestamp: number): DirectoryUpdate {
  return {
    role: "system",
    content: "",
    sections: {
      cwd: cwdSection(state.cwd),
      "change-working-dir":
        state.notice !== undefined
          ? `<change-working-dir>\n${state.notice}\n</change-working-dir>`
          : null,
    },
    timestamp,
  };
}

/** The directory update of a context message, when the message is a saved snapshot. */
function updateOf(message: Messages[number]): DirectoryUpdate | undefined {
  if (message.role !== "custom" || message.customType !== CONTEXT_TYPE) {
    return;
  }
  const state = snapshot(message.details);
  return state === undefined ? undefined : directoryUpdate(state, message.timestamp);
}

/** Whether the ancestry from the leaf still reaches the prefix the cache was read from. */
function continues(cache: PrefixCache, ctx: ExtensionContext, leaf: string | null): boolean {
  const session = ctx.sessionManager;
  if (session !== cache.manager) {
    return false;
  }
  let cursor: string | null = leaf;
  while (cursor !== null && cursor !== cache.leaf) {
    const entry = session.getEntry(cursor);
    if (entry === undefined || entry.type === "compaction") {
      return false;
    }
    cursor = entry.parentId;
  }
  return cursor === cache.leaf;
}

/**
 * The carried sections for this request. Only new ancestry is inspected: the journal is read
 * again after a compaction, a branch change, or a restore, never on every provider request.
 */
function refreshPrefix(cache: PrefixCache | undefined, ctx: ExtensionContext): PrefixCache {
  const leaf = ctx.sessionManager.getLeafId();
  const sections =
    cache !== undefined && continues(cache, ctx, leaf) ? cache.sections : carriedFrom(ctx);
  return { manager: ctx.sessionManager, leaf, sections };
}

type Branch = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;

/**
 * The directory section the journal started with: the one its first system message recorded.
 * It is read from the journal, not from this process, so a copy of the journal that runs in
 * another directory, such as a forked child session, starts from the same value as the original.
 * A journal without a recorded section started in the session directory.
 */
function startSection(branch: Branch, sessionCwd: string): string {
  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "system") {
      return entry.message.sections?.cwd ?? cwdSection(sessionCwd);
    }
  }
  return cwdSection(sessionCwd);
}

/** The update of the last snapshot saved before the entry `cutoff`; of the whole branch when no entry was kept. */
function updateBefore(branch: Branch, cutoff: string | null): DirectoryUpdate | undefined {
  let earlier: DirectoryUpdate | undefined;
  for (const entry of branch) {
    if (entry.id === cutoff) {
      break;
    }
    if (entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
      const state = snapshot(entry.details);
      earlier = state === undefined ? earlier : directoryUpdate(state, Date.parse(entry.timestamp));
    }
  }
  return earlier;
}

/**
 * The directory state that the messages of the current window do not hold. The leading system
 * message always states the directory the journal started with, so a compaction leaves the start
 * of the request as the provider cached it. The directory in effect before the window follows as
 * its own update.
 */
function carriedFrom(ctx: ExtensionContext): Carried {
  const branch = ctx.sessionManager.getBranch();
  const first = ctx.sessionManager.buildSessionProjection().entries[0]?.sourceEntry;
  return {
    leading: { cwd: startSection(branch, ctx.cwd), "change-working-dir": null },
    update: first?.type === "compaction" ? updateBefore(branch, first.firstKeptEntryId) : undefined,
  };
}

/**
 * Whether the host started the context with a provider summary block. The field is read from a
 * plain object, because only hosts that offer the block declare it.
 */
function startsWithSummaryBlock(first: object): boolean {
  return "providerSummary" in first && first.providerSummary !== undefined;
}

/**
 * Present the saved snapshots as system messages. A snapshot inside the conversation stays in its
 * place. The updates from before the conversation, carried over a compaction or saved before the
 * first prompt, go directly after the leading system messages: behind the prompt and the tool
 * changes a compaction keeps there, and in front of everything that changes with the window.
 *
 * A context that starts with a provider summary block is the exception. The provider keeps the
 * reasoning of the kept turns only while they follow the block directly, so the update carried
 * over that compaction goes behind them: directly after the compaction summary. A directory that
 * the kept turns state themselves is newer, so the carried update is then not sent.
 */
function present(messages: Messages, carried: Carried): Messages {
  const conversation = messages.findIndex(
    (message) => message.role !== "system" && updateOf(message) === undefined,
  );
  const head = messages.slice(0, conversation === -1 ? messages.length : conversation);
  const [first, ...others] = head.filter((message) => message.role === "system");
  const later = [
    ...head.filter((message) => message.role !== "system"),
    ...messages.slice(head.length),
  ].map((message) => updateOf(message) ?? message);
  if (first === undefined) {
    return later;
  }
  const lead = { ...first, sections: { ...first.sections, ...carried.leading } };
  if (carried.update === undefined) {
    return [lead, ...others, ...later];
  }
  if (!startsWithSummaryBlock(first)) {
    return [lead, ...others, carried.update, ...later];
  }
  const kept = later.slice(
    0,
    later.findLastIndex((message) => message.role === "compactionSummary") + 1,
  );
  const keptStateDirectory = kept.some(
    (message) => message.role === "system" && message.sections?.cwd !== undefined,
  );
  return [
    lead,
    ...others,
    ...kept,
    ...(keptStateDirectory ? [] : [carried.update]),
    ...later.slice(kept.length),
  ];
}

/** The most recent context snapshot in the branch, if any. */
function latestSnapshot(branch: Branch): Snapshot | undefined {
  let previous: Snapshot | undefined;
  for (const entry of branch) {
    if (entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
      previous = snapshot(entry.details) ?? previous;
    }
  }
  return previous;
}

/**
 * Whether a restore duplicates what the journal already says and can be skipped: its last
 * snapshot, or without one the directory it started with.
 */
function shouldSuppress(
  previous: Snapshot | undefined,
  cwd: string,
  notice: string | undefined,
  start: string,
): boolean {
  if (previous === undefined) {
    return cwdSection(cwd) === start && notice === undefined;
  }
  return previous.cwd === cwd && previous.notice === notice;
}

/** Project effective-directory snapshots without changing the selected-directory journal. */
export function registerCwdContext(
  pi: ExtensionAPI,
  currentCwd: (ctx: ExtensionContext) => string,
): (ctx: ExtensionContext, cwd: string, record: CwdRecord) => void {
  let prefix: PrefixCache | undefined;

  pi.on("before_agent_start", (event, ctx) => {
    // oxlint-disable-next-line no-param-reassign -- QX-001: the host documents systemPromptOptions as mutable during this event.
    event.systemPromptOptions.cwd = currentCwd(ctx);
    // The native cwd renderer replaces backslashes, including literal POSIX filename characters.
    // oxlint-disable-next-line no-param-reassign -- QX-001: the host documents systemPromptOptions as mutable during this event.
    event.systemPromptOptions.sections.cwd = event.systemPromptOptions.cwd;
  });

  pi.on("context_with_system", (event, ctx) => {
    prefix = refreshPrefix(prefix, ctx);
    return { messages: present(event.messages, prefix.sections) };
  });

  return (ctx, cwd, record) => {
    const notice = record.kind === "restore" ? record.notice : undefined;
    if (record.kind === "restore") {
      const branch = ctx.sessionManager.getBranch();
      if (shouldSuppress(latestSnapshot(branch), cwd, notice, startSection(branch, ctx.cwd))) {
        return;
      }
    }
    pi.sendMessage(
      { customType: CONTEXT_TYPE, content: "", display: false, details: { cwd, notice } },
      { triggerTurn: false },
    );
  };
}
