# Changelog

## 0.5.1 - 2026-09-22

- Preserve native filesystem traversal and exact Unicode filenames across default file/search tools, `change_dir`, and `/cwd` on official Pi and the fork.
- Keep admission and previews non-mutating, reject invalid traversal without changing file contents, and retain captured invocation paths in execution and replay.
- Preserve native mutation ordering, read filename fallbacks, path labels, and executable oversized-read hints.
- Add native path regressions and focused Windows filesystem comparisons.
- Qualify against official Pi 0.87.1 and compatible forks.

## 0.5.0 - 2026-09-22

- Expose one session-scoped execution-directory interface for cooperating extensions, including explicit child-directory initialization.
- Route default native file, search, Bash, and PowerShell tools through captured invocation directories while retaining native execution, cancellation, output, and file queues.
- Keep speculative edit previews and final results on the admitted file, including literal working-directory names.
- Preserve prompt prefixes with structured directory updates through commands, tool turns, branch restoration, compaction, and supported fresh-context boundaries.
- Enable strict JSON Schema for `change_dir` and initialize correctly for SDK prompts without an explicit extension bind.
- Remove process-global spawn interception, custom-tool argument rewriting, and unused FFF integration. Custom extensions resolve their own operation directory through the public interface; explicit process directories remain untouched.
- Preserve project settings, trust, instructions, session identity, reset behavior, and the existing distinction between unavailable saved directories and removed live directories.
- Qualify the portable implementation on official Pi 0.87.0 and the matching fork.

## 0.4.3 - 2026-09-19

- Keep native CLI Bash working on released Pi after the original directory is removed, preserving configured shell and command prefix through Pi's native Bash factory.
- Preserve existing custom Bash tools and user-Bash handler ordering; use the configured shell for the local user-Bash fallback.

## 0.4.2 - 2026-09-18

- Require an accessible working directory for filesystem, edit, and subagent calls, preventing writes from silently recreating a removed worktree without Git metadata. Absolute paths also require recovery with `change_dir` or restoration of the directory, covering path aliases and host-specific normalization.
- Document the unresolved FFF search-scoping and result-path bugs after directory changes.

## 0.4.1 - 2026-09-06

- Use Pi's optional native Bash cwd hook before directory checks, so Bash keeps working after the original session directory is removed.
- Preserve the configured shell and selected `user_bash` executor on hook-capable hosts. Older hosts retain legacy routing and still require the original session directory.
- Add a native integration regression covering removed directories, shell configuration, session environment, and custom user Bash operations.

## 0.4.0 - 2026-08-12

- Patch `child_process.spawn` so `pi.exec` and other session-cwd or cwd-less spawns follow the virtual working directory on Node-hosted Pi. Explicit spawn `cwd` values other than the session directory are unchanged. Bun-hosted Pi cannot rebind an already-imported ESM `spawn`.

## 0.3.0 - 2026-08-09

- Serialize native sibling tool calls around `change_dir`, preventing dependent calls from running in the previous directory.
- Route `ffgrep`, `fffind`, and pi-subagents' `subagent` through the virtual working directory, including result rebasing and safe pagination for session descendants.
- Canonicalize and validate accessible directories, reject control-character paths before they reach tools, support built-in `file://` paths, and avoid duplicate persistence entries.
- Preserve literal leading `@` names for custom tools such as `apply_edits`; only Pi's built-ins treat `@` as path syntax.
- Restore malformed session entries safely, clear stale footer state on shutdown, and rewrite Pi's authoritative final cwd prompt line.
- Add package metadata and a minimal npm payload so the GitHub release is ready for later npm publication.
- Document extension ordering, explicit parallel batches, FFF autocomplete, user-bash composition, and remaining project-scope limitations.

## 0.2.0 - 2026-08-06

- Require Pi 0.84.0 or later.
- Use Pi 0.84's direct `typebox` tool-schema import and required tool-result shape.
- Restore the branch-specific working directory after `/tree` navigation.
- Add type-checking and pin Pi 0.84.0 for development validation.

## 0.1.1 - 2026-08-05

- Show `~` instead of the full home directory in the footer status.

## 0.1.0 - 2026-08-02

- Initial release.
