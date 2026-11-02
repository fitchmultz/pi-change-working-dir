import {
  accessSync,
  constants,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Unicode space characters the hosts' read-path helper folds to plain spaces. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

export const expandTilde = (path: string): string => {
  if (path === "~") {
    return homedir();
  }
  const relative = path.startsWith("~/") || (sep === "\\" && path.startsWith("~\\"));
  return relative ? homedir() + sep + path.slice(2) : path;
};

export const tildify = (path: string): string => {
  const home = homedir();
  if (path === home) {
    return "~";
  }
  return path.startsWith(home + sep) ? "~" + path.slice(home.length) : path;
};

export const escapeControl = (path: string): string =>
  path.replace(/[\u0000-\u001f\u007f-\u009f]/g, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x7f
      ? JSON.stringify(char).slice(1, -1)
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });

/** A directory that exists, is traversable, and is the canonical target. */
export const accessibleDirectory = (path: string): string | undefined => {
  try {
    if (!statSync(path).isDirectory()) {
      return undefined;
    }
    const target = realpathSync.native(path);
    accessSync(target, constants.X_OK);
    return target;
  } catch {
    return undefined;
  }
};

export const assertAvailable = (cwd: string): void => {
  if (accessibleDirectory(cwd) === undefined) {
    throw new Error(
      `Working directory unavailable: ${escapeControl(cwd)}. Restore it or use change_dir to select another directory.`,
    );
  }
};

export const operationPath = (path: string, cwd: string): string => {
  const expanded = path.startsWith("file://") ? fileURLToPath(path) : expandTilde(path);
  // DOS paths normalize before lookup; POSIX traversal must reach the filesystem intact.
  if (sep === "\\" && !/^\\\\[?.]\\/.test(expanded)) {
    const target = resolve(cwd, expanded);
    return /[\\/]$/.test(expanded) && !target.endsWith(sep) ? target + sep : target;
  }
  return isAbsolute(expanded) ? expanded : `${cwd}${sep}${expanded}`;
};

/** Bind a raw tool path argument to the selected directory; other values pass through. */
export const bindPath = (path: unknown, cwd: string): unknown =>
  typeof path === "string" && path !== "" ? operationPath(path, cwd) : path;

// The hosts' read-path helper is private. Apply its ordered variants to the request
// before binding to cwd, then validate native traversal before canonicalization.
export async function readTarget(requested: string, cwd: string): Promise<string> {
  const path = requested.startsWith("file://") ? fileURLToPath(requested) : requested;
  const spaced = path.replace(UNICODE_SPACES, " ");
  const nfd = spaced.normalize("NFD");
  const variants = new Set([
    path,
    spaced,
    spaced.replace(/ (AM|PM)\./gi, "\u202f$1."),
    nfd,
    spaced.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ]);
  let failure: unknown;
  for (const variant of variants) {
    const candidate = operationPath(variant, cwd);
    try {
      await stat(candidate);
    } catch (error) {
      failure ??= error;
      continue;
    }
    return realpath(candidate);
  }
  throw firstFailure(failure, requested);
}

/** The first failing variant's error is the operator-meaningful one; preserve its identity. */
function firstFailure(failure: unknown, requested: string): Error {
  if (failure instanceof Error) {
    return failure;
  }
  return new Error(`No readable variant of: ${requested}`);
}

// Official Pi has no target resolver export. Keep its default publisher, but validate
// each native parent/link before handing a canonical file URL to either host.
export function fileTarget(path: string): string {
  const links = new Set<string>();
  let current = path;
  for (;;) {
    if (current.endsWith(sep) || current.endsWith("/")) {
      statSync(current);
      return realpathSync.native(current);
    }
    const parentPath = dirname(current);
    if (!statSync(parentPath).isDirectory()) {
      throw Object.assign(new Error(`Not a directory: ${parentPath}`), { code: "ENOTDIR" });
    }
    const parent = realpathSync.native(parentPath);
    const target = join(parent, basename(current));
    const info = readLinkInfo(target);
    if (info === undefined) {
      return target;
    }
    if (!info.isSymbolicLink()) {
      return realpathSync.native(target);
    }
    if (links.has(target)) {
      throw Object.assign(new Error(`Symlink cycle: ${target}`), { code: "ELOOP" });
    }
    links.add(target);
    const link = readlinkSync(target);
    current = isAbsolute(link) ? link : `${parent}${sep}${link}`;
  }
}

/** lstat for a prospective target; a missing target is an expected absent result. */
function readLinkInfo(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/** The string `code` property of a thrown value, when it has one. */
function errorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

// Discover queue identity without awaiting, creating parents, or admitting invalid I/O.
// Revisit symlinks after resolving absent components such as missing/../link.
export function queueTarget(path: string, links = new Set<string>()): string {
  try {
    return realpathSync.native(path);
  } catch {
    // Resolve prospective parents below.
  }
  const parentPath = dirname(path);
  if (parentPath === path) {
    return path;
  }
  const parent = queueTarget(parentPath, links);
  const target = join(parent, basename(path));
  try {
    if (lstatSync(target).isSymbolicLink()) {
      if (links.has(target)) {
        return target;
      }
      links.add(target);
      const link = readlinkSync(target);
      return queueTarget(isAbsolute(link) ? link : `${parent}${sep}${link}`, links);
    }
    return realpathSync.native(target);
  } catch {
    return target;
  }
}
