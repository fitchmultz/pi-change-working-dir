# pi-change-working-dir

Let Pi agents change their working directory mid-session — no quitting, no `cd` prefix on every command. Built for git worktrees and monorepos.

Pi bakes the session cwd into its built-in tools at session start ([`createBashToolDefinition(cwd)`](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/tools/bash.ts) closures — there is no built-in chdir). This extension keeps a **virtual cwd** and transparently rewrites tool inputs:

| Surface | Behavior |
|---|---|
| `bash` | Prepends `cd <dir> \|\| exit 1` to every command |
| `read` / `write` / `edit` | Relative paths resolve against the virtual cwd |
| `ls` / `grep` / `find` | Relative + defaulted paths resolve against the virtual cwd |
| `!cmd` user bash | Runs in the virtual cwd |
| System prompt | Rewrites the active cwd so the model isn't misled by the baked-in one |
| Footer | Shows `cwd: <dir>` while an override is active |

The directory persists on each session branch, so it survives `/resume`, `/fork`, and `/tree` navigation.

## Requirements

Pi 0.84.0 or later.

## Usage

**Agent:** calls the `change_dir` tool (`{ path: "../worktrees/feature-x" }`).

**User:** `/cwd <path>` to change, `/cwd` to show, `/cwd -` to reset to the session's original directory.

## Install

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["git:github.com/fitchmultz/pi-change-working-dir"] }
```

Or for local development: `pi -e ./index.ts`

## Limitations

- Custom tools from *other* extensions that take paths are not rewritten — they see the original session cwd. Exception: `apply_edits` (pi-apply-edits) is recognized and rewritten (`path`, `files[].path`).
- The footer `pwd` segment still shows the session cwd (pi renders it from the immutable `SessionManager`); the `cwd:` status segment shows the override.
- Project trust, `.pi/extensions`, AGENTS.md, and skill discovery remain bound to the original session cwd.

## Test

```bash
npm install
npm run check
```
