import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCwdContext } from "./cwd-context.ts";
import { accessibleDirectory, escapeControl, operationPath, tildify } from "./native-paths.ts";

const ENTRY_TYPE = "change-working-dir";

/** The directory-selection state machine: current directory, journal persistence, and restore. */
export type Selection = {
  current: (ctx: ExtensionContext) => string;
  initialize: (ctx: ExtensionContext) => void;
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
  let context: ExtensionContext | undefined;
  let directory: string | undefined;
  let savedDirectory: string | undefined;
  let savedStateValid = true;
  let manager: ExtensionContext["sessionManager"] | undefined;

  const current = (ctx: ExtensionContext): string => directory ?? ctx.cwd;
  const updateStatus = (ctx: ExtensionContext): void => {
    if (ctx.hasUI) {
      // oxlint-disable-next-line no-useless-undefined -- QX-003: the host status API takes a required string | undefined slot value.
      ctx.ui.setStatus("cwd", directory === undefined ? undefined : `cwd: ${tildify(directory)}`);
    }
  };
  const record = registerCwdContext(pi, (ctx) => {
    initialize(ctx);
    return current(ctx);
  });

  const restore = (ctx: ExtensionContext): void => {
    const restored = restoreFromEntry(ctx);
    directory = restored.directory;
    savedDirectory = restored.saved;
    savedStateValid = restored.valid;
    if (restored.notice !== undefined && ctx.hasUI) {
      ctx.ui.notify(restored.notice, "warning");
    }
    updateStatus(ctx);
    record(ctx, current(ctx), { notice: restored.notice });
  };

  const change = (path: unknown, ctx: ExtensionContext, clear = false): string => {
    initialize(ctx);
    if (typeof path !== "string" || path === "") {
      throw new Error("Path is required");
    }
    const target = admittedTarget(path, current(ctx));
    const next = clear || target === ctx.cwd ? undefined : target;
    if (next !== directory || next !== savedDirectory || !savedStateValid) {
      directory = next;
      savedDirectory = next;
      savedStateValid = true;
      // Native appends are accepted in memory before journal I/O; never retry the append.
      try {
        pi.appendEntry(ENTRY_TYPE, { dir: next });
      } finally {
        updateStatus(ctx);
        record(ctx, current(ctx), { changed: true });
      }
    }
    return current(ctx);
  };

  function initialize(ctx: ExtensionContext): void {
    context = ctx;
    if (manager === ctx.sessionManager) {
      return;
    }
    manager = ctx.sessionManager;
    onSessionManagerChange(ctx);
  }

  function reset(): void {
    context = undefined;
    manager = undefined;
  }

  return { current, initialize, change, restore, updateStatus, context: () => context, reset };
}
