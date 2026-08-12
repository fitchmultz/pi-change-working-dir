# Changelog

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
