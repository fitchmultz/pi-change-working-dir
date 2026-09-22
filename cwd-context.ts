import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CONTEXT_TYPE = "change-working-dir:context";

type Snapshot = { cwd: string; notice?: string };

function snapshot(details: unknown): Snapshot | undefined {
  if (!details || typeof details !== "object" || !("cwd" in details) || typeof details.cwd !== "string") return;
  if ("notice" in details && details.notice !== undefined && typeof details.notice !== "string") return;
  return details as Snapshot;
}

function sections(state: Snapshot) {
  return {
    cwd: `<cwd>\n${state.cwd}\n</cwd>`,
    "change-working-dir": state.notice ? `<change-working-dir>\n${state.notice}\n</change-working-dir>` : null,
  };
}

/** Project effective-directory snapshots without changing the selected-directory journal. */
export function registerCwdContext(
  pi: ExtensionAPI,
  currentCwd: (ctx: ExtensionContext) => string,
): (ctx: ExtensionContext, cwd: string, notice?: string, changed?: boolean) => void {
  pi.on("before_agent_start", (event, ctx) => {
    event.systemPromptOptions.cwd = currentCwd(ctx);
    // The native cwd renderer replaces backslashes, including literal POSIX filename characters.
    event.systemPromptOptions.sections.cwd = event.systemPromptOptions.cwd;
  });

  pi.on("context_with_system", (event, ctx) => {
    // The fork's context_window has this public shape but is absent from official Pi's entry union.
    const first: { type: string; id: string; firstKeptEntryId?: string } | undefined =
      ctx.sessionManager.buildSessionProjection().entries[0]?.sourceEntry;
    const cutoff = first?.type === "compaction" ? first.firstKeptEntryId
      : first?.type === "context_window" ? first.id : undefined;
    let baseline: Snapshot = { cwd: ctx.cwd };
    if (cutoff) {
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.id === cutoff) break;
        if (entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
          baseline = snapshot(entry.details) ?? baseline;
        }
      }
    }
    return {
      messages: event.messages.map((message, index) => {
        if (message.role === "custom" && message.customType === CONTEXT_TYPE) {
          const state = snapshot(message.details);
          if (state) return { role: "system" as const, content: "", sections: sections(state), timestamp: message.timestamp };
        }
        if (index === 0 && message.role === "system") {
          return { ...message, sections: { ...message.sections, ...sections(baseline) } };
        }
        return message;
      }),
    };
  });

  return (ctx, cwd, notice, changed = false) => {
    // Validated changes may still be queued; only restores can deduplicate against branch history.
    if (!changed) {
      let previous: Snapshot | undefined;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom_message" && entry.customType === CONTEXT_TYPE) {
          previous = snapshot(entry.details) ?? previous;
        }
      }
      if ((!previous && cwd === ctx.cwd && !notice) || (previous?.cwd === cwd && previous.notice === notice)) return;
    }
    pi.sendMessage({ customType: CONTEXT_TYPE, content: "", display: false, details: { cwd, notice } }, { triggerTurn: false });
  };
}
