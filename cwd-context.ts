import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "./native-paths.ts";

const CONTEXT_TYPE = "change-working-dir:context";

type Snapshot = { cwd: string; notice?: string | undefined };

type Lineage = {
  manager: ExtensionContext["sessionManager"] | undefined;
  leaf: string | null;
};

export type CwdRecord = {
  notice?: string | undefined;
  changed?: boolean;
};

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

function sections(state: Snapshot): Record<string, string | null> {
  return {
    cwd: `<cwd>\n${state.cwd}\n</cwd>`,
    "change-working-dir":
      state.notice !== undefined
        ? `<change-working-dir>\n${state.notice}\n</change-working-dir>`
        : null,
  };
}

/** Whether the ancestry from the leaf still reaches the last projected entry. */
function lineageChanged(ctx: ExtensionContext, lineage: Lineage, nextLeaf: string | null): boolean {
  const session = ctx.sessionManager;
  if (session !== lineage.manager) {
    return true;
  }
  let cursor: string | null = nextLeaf;
  while (cursor !== null && cursor !== lineage.leaf) {
    const entry = session.getEntry(cursor);
    if (entry === undefined || entry.type === "compaction") {
      return true;
    }
    cursor = entry.parentId;
  }
  return cursor !== lineage.leaf;
}

/** The baseline snapshot to project into the leading system message. */
function baselineFrom(ctx: ExtensionContext): Snapshot {
  let baseline: Snapshot = { cwd: ctx.cwd };
  const first = ctx.sessionManager.buildSessionProjection().entries[0]?.sourceEntry;
  const cutoff = first?.type === "compaction" ? first.firstKeptEntryId : undefined;
  if (cutoff === undefined) {
    return baseline;
  }
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.id === cutoff) {
      break;
    }
    if (entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
      baseline = snapshot(entry.details) ?? baseline;
    }
  }
  return baseline;
}

/** The most recent context snapshot in the branch, if any. */
function latestSnapshot(session: ExtensionContext["sessionManager"]): Snapshot | undefined {
  let previous: Snapshot | undefined;
  for (const entry of session.getBranch()) {
    if (entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
      previous = snapshot(entry.details) ?? previous;
    }
  }
  return previous;
}

/** Whether a restore duplicates the last recorded snapshot and can be skipped. */
function shouldSuppress(
  previous: Snapshot | undefined,
  cwd: string,
  notice: string | undefined,
  sessionCwd: string,
): boolean {
  if (previous === undefined) {
    return cwd === sessionCwd && notice === undefined;
  }
  return previous.cwd === cwd && previous.notice === notice;
}

/** Project effective-directory snapshots without changing the selected-directory journal. */
export function registerCwdContext(
  pi: ExtensionAPI,
  currentCwd: (ctx: ExtensionContext) => string,
): (ctx: ExtensionContext, cwd: string, record?: CwdRecord) => void {
  let lineage: Lineage = { manager: undefined, leaf: null };
  let baseline: Snapshot = { cwd: "" };

  pi.on("before_agent_start", (event, ctx) => {
    // oxlint-disable-next-line no-param-reassign -- QX-001: the host documents systemPromptOptions as mutable during this event.
    event.systemPromptOptions.cwd = currentCwd(ctx);
    // The native cwd renderer replaces backslashes, including literal POSIX filename characters.
    // oxlint-disable-next-line no-param-reassign -- QX-001: the host documents systemPromptOptions as mutable during this event.
    event.systemPromptOptions.sections.cwd = event.systemPromptOptions.cwd;
  });

  pi.on("context_with_system", (event, ctx) => {
    const nextLeaf = ctx.sessionManager.getLeafId();
    // Inspect only new ancestry. Rebuild on compaction, branch changes, or restore,
    // never scan the entire journal on every provider request.
    if (lineageChanged(ctx, lineage, nextLeaf)) {
      baseline = baselineFrom(ctx);
    }
    lineage = { manager: ctx.sessionManager, leaf: nextLeaf };
    return {
      messages: event.messages.map((message, index) => {
        if (message.role === "custom" && message.customType === CONTEXT_TYPE) {
          const state = snapshot(message.details);
          if (state !== undefined) {
            return {
              role: "system" as const,
              content: "",
              sections: sections(state),
              timestamp: message.timestamp,
            };
          }
        }
        if (index === 0 && message.role === "system") {
          return { ...message, sections: { ...message.sections, ...sections(baseline) } };
        }
        return message;
      }),
    };
  });

  return (ctx, cwd, record) => {
    // Validated changes may still be queued; only restores can deduplicate against branch history.
    const notice = record?.notice;
    if (
      record?.changed !== true &&
      shouldSuppress(latestSnapshot(ctx.sessionManager), cwd, notice, ctx.cwd)
    ) {
      return;
    }
    pi.sendMessage(
      { customType: CONTEXT_TYPE, content: "", display: false, details: { cwd, notice } },
      { triggerTurn: false },
    );
  };
}
