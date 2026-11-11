import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCwdContext } from "./cwd-context.ts";
import { accessibleDirectory, escapeControl, operationPath, tildify } from "./native-paths.ts";

const ENTRY_TYPE = "change-working-dir";

/** The directory-selection state machine: current directory, journal persistence, and restore. */
export type Selection = {
  current: (ctx: ExtensionContext) => string;
  /** Attach to the event's session; true when this session was already attached. */
  attach: (ctx: ExtensionContext) => boolean;
  change: (path: unknown, ctx: ExtensionContext, clear?: boolean) => string;
  restore: (ctx: ExtensionContext) => void;
  updateStatus: (ctx: ExtensionContext) => void;
  context: () => ExtensionContext | undefined;
  reset: () => void;
};

type SavedSelection = { valid: false; dir: undefined } | { valid: true; dir: string | undefined };

type RestoredSelection = {
  directory: string | undefined;
  saved: string | undefined;
  valid: boolean;
  notice: string | undefined;
};

/** The journal's last saved selection, and whether that entry could be used. */
type JournalSelection = { saved: string | undefined; valid: boolean };

/** Everything the selection machine knows: the session it belongs to and what is selected there. */
type SelectionState = {
  session: ExtensionContext | undefined;
  /** The selected directory; absent means the session directory. */
  directory: string | undefined;
  journal: JournalSelection;
};

/** Nothing attached, nothing selected. */
function unattached(): SelectionState {
  return { session: undefined, directory: undefined, journal: { saved: undefined, valid: true } };
}

/** Attach to the context's session; a different session starts from its own directory. */
function attachState(
  state: SelectionState,
  ctx: ExtensionContext,
): { state: SelectionState; reused: boolean } {
  if (state.session?.sessionManager !== ctx.sessionManager) {
    return { state: { ...unattached(), session: ctx }, reused: false };
  }
  return { state: { ...state, session: ctx }, reused: true };
}

/** Adopt what the journal restored, usable or not. */
function adoptRestored(state: SelectionState, saved: RestoredSelection): SelectionState {
  return {
    ...state,
    directory: saved.directory,
    journal: { saved: saved.saved, valid: saved.valid },
  };
}

/** Select a target; the journal must record it unless it already holds exactly this selection. */
function applyTarget(
  state: SelectionState,
  target: string | undefined,
): { state: SelectionState; record: boolean } {
  if (target === state.directory && target === state.journal.saved && state.journal.valid) {
    return { state, record: false };
  }
  return {
    state: { ...state, directory: target, journal: { saved: target, valid: true } },
    record: true,
  };
}

/** The saved journal entry's directory: valid means it can be restored, dir absent means none. */
function savedSelection(entry: unknown, data: unknown): SavedSelection {
  const dir: unknown =
    typeof data === "object" && data !== null && "dir" in data ? data.dir : undefined;
  if (invalidSavedEntry(entry, data) || invalidSavedDir(dir)) {
    return { valid: false, dir: undefined };
  }
  return { valid: true, dir: typeof dir === "string" ? dir : undefined };
}

/** A journal entry whose stored payload is not an object cannot be trusted. */
function invalidSavedEntry(entry: unknown, data: unknown): boolean {
  return entry !== undefined && (data === null || typeof data !== "object");
}

/** A stored directory that is not an absolute string cannot be restored. */
function invalidSavedDir(dir: unknown): boolean {
  return dir !== undefined && (typeof dir !== "string" || !isAbsolute(dir));
}

/** Restore the branch's persisted selection, reporting an invalid or unavailable state. */
function restoreFromEntry(ctx: ExtensionContext): RestoredSelection {
  const entry = ctx.sessionManager
    .getBranch()
    .findLast((item) => item.type === "custom" && item.customType === ENTRY_TYPE);
  const custom = entry?.type === "custom" ? entry : undefined;
  const data: unknown = custom === undefined ? undefined : custom.data;
  const saved = savedSelection(custom, data);
  if (!saved.valid) {
    return {
      directory: undefined,
      saved: undefined,
      valid: false,
      notice: "Ignoring an invalid saved working directory; using the session directory.",
    };
  }
  if (saved.dir === undefined) {
    return { directory: undefined, saved: undefined, valid: true, notice: undefined };
  }
  return availability(ctx, saved.dir);
}

/** A valid saved directory still has to exist and be canonical before it is selected. */
function availability(ctx: ExtensionContext, saved: string): RestoredSelection {
  const target = accessibleDirectory(saved);
  if (target !== undefined && escapeControl(target) === target) {
    return {
      directory: target === ctx.cwd ? undefined : target,
      saved,
      valid: true,
      notice: undefined,
    };
  }
  return {
    directory: undefined,
    saved,
    valid: true,
    notice: `Saved working directory unavailable or unsupported; using the session directory: ${escapeControl(saved)}`,
  };
}

/** Validate a requested directory and return its canonical, accessible target. */
function admittedTarget(path: string, current: string): string {
  const requested = operationPath(path, current);
  const target = accessibleDirectory(requested);
  if (target === undefined) {
    throw new Error(`Not an accessible directory: ${escapeControl(requested)}`);
  }
  if (escapeControl(target) !== target) {
    throw new Error(
      `Directory paths with control characters are not supported: ${escapeControl(target)}`,
    );
  }
  return target;
}

export function createSelection(
  pi: ExtensionAPI,
  onSessionManagerChange: (ctx: ExtensionContext) => void,
): Selection {
  let state = unattached();

  const current = (ctx: ExtensionContext): string => state.directory ?? ctx.cwd;
  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "cwd",
        state.directory === undefined ? undefined : `cwd: ${tildify(state.directory)}`,
      );
    }
  };
  const record = registerCwdContext(pi, (ctx) => {
    attach(ctx);
    return current(ctx);
  });

  const restore = (ctx: ExtensionContext): void => {
    const saved = restoreFromEntry(ctx);
    state = adoptRestored(state, saved);
    if (saved.notice !== undefined && ctx.hasUI) {
      ctx.ui.notify(saved.notice, "warning");
    }
    updateStatus(ctx);
    record(ctx, current(ctx), { notice: saved.notice });
  };

  const change = (path: unknown, ctx: ExtensionContext, clear = false): string => {
    attach(ctx);
    if (typeof path !== "string" || path === "") {
      throw new Error("Path is required");
    }
    const target = admittedTarget(path, current(ctx));
    const next = applyTarget(state, clear || target === ctx.cwd ? undefined : target);
    state = next.state;
    if (next.record) {
      // Native appends are accepted in memory before journal I/O; never retry the append.
      try {
        pi.appendEntry(ENTRY_TYPE, { dir: state.directory });
      } finally {
        updateStatus(ctx);
        record(ctx, current(ctx), { changed: true });
      }
    }
    return current(ctx);
  };

  function attach(ctx: ExtensionContext): boolean {
    const next = attachState(state, ctx);
    state = next.state;
    if (!next.reused) {
      onSessionManagerChange(ctx);
    }
    return next.reused;
  }

  function reset(): void {
    state = unattached();
  }

  return {
    current,
    attach,
    change,
    restore,
    updateStatus,
    context: () => state.session,
    reset,
  };
}
