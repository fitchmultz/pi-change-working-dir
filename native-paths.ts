import {
  accessSync,
  constants,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
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

/** The canonical target of a path, validated by native traversal before canonicalization. */
async function existingTarget(path: string): Promise<string> {
  const [, resolved] = await Promise.all([stat(path), realpath(path)]);
  return resolved;
}

/**
 * The target of a path whose lookup failed because a part of it does not exist: the canonical
 * directory that exists, then the missing names below it. The hosts normalize a path lexically
 * before they open it; this form is the one that means the same to them and to the filesystem.
 * Undefined for any other failure, and when a dot segment follows a missing name: that path has
 * no such form.
 */
async function missingTarget(path: string, failure: unknown): Promise<string | undefined> {
  if (errorCode(failure) !== "ENOENT") {
    return undefined;
  }
  const names: string[] = [];
  let prefix = path;
  for (;;) {
    const name = basename(prefix);
    const parent = dirname(prefix);
    if (name === "." || name === ".." || parent === prefix) {
      return undefined;
    }
    names.unshift(name);
    try {
      return join(await existingTarget(parent), ...names);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        return undefined;
      }
      prefix = parent;
    }
  }
}

/**
 * The target to hand the host for a search path: canonical when it exists. A target with a
 * missing part also goes to the host, so that the host's own tool reports it. Every other
 * failure throws as the operating system reported it.
 */
export async function searchTarget(path: string): Promise<string> {
  try {
    return await existingTarget(path);
  } catch (error) {
    const missing = await missingTarget(path, error);
    if (missing === undefined) {
      throw error;
    }
    return missing;
  }
}

/** The spellings the hosts' private read-path helper tries for one path, in its order. */
function readVariants(path: string): string[] {
  const nfd = path.normalize("NFD");
  return [
    path,
    path.replace(/ (AM|PM)\./gi, "\u202f$1."),
    nfd,
    path.replace(/'/g, "\u2019"),
    nfd.replace(/'/g, "\u2019"),
  ];
}

/** Whether the host would read an existing file of another spelling in place of a missing target. */
async function readsAnotherFile(missing: string): Promise<boolean> {
  const others = readVariants(missing).filter((variant) => variant !== missing);
  const found = await Promise.all(
    others.map(async (variant) =>
      access(variant).then(
        () => true,
        () => false,
      ),
    ),
  );
  return found.includes(true);
}

// The hosts' read-path helper is private. Apply its ordered variants to the request
// before binding to cwd, then validate native traversal before canonicalization.
// When no variant exists, the missing target goes to the host as a search target does,
// unless the host's variants of the whole path would then read a file outside the request.
export async function readTarget(requested: string, cwd: string): Promise<string> {
  const path = requested.startsWith("file://") ? fileURLToPath(requested) : requested;
  const variants = new Set([path, ...readVariants(path.replace(UNICODE_SPACES, " "))]);
  let failure: unknown;
  for (const variant of variants) {
    try {
      return await existingTarget(operationPath(variant, cwd));
    } catch (error) {
      failure ??= error;
      continue;
    }
  }
  const missing = await missingTarget(operationPath(path, cwd), failure);
  if (missing === undefined || (await readsAnotherFile(missing))) {
    throw firstFailure(failure, requested);
  }
  return missing;
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
