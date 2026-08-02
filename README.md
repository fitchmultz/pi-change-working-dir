# pi-change-working-dir

Let Pi agents change their working directory mid-session — no quitting, no `cd` prefix on every command. Built for git worktrees and monorepos.

Pi bakes the session cwd into its built-in tools at session start ([`createBashToolDefinition(cwd)`](https://github.com/badlogic/pi-mono) closures — there is no built-in chdir). This extension keeps a **virtual cwd** and transparently rewrites tool inputs:

| Surface | Behavior |
|---|---|
| `bash` | Prepends `cd <dir> \|\| exit 1` to every command |
| `read` / `write` / `edit` | Relative paths resolve against the virtual cwd |
| `ls` / `grep` / `find` | Relative + defaulted paths resolve against the virtual cwd |
| `!cmd` user bash | Runs in the virtual cwd |
| System prompt | Appends the active cwd so the model isn't misled by the baked-in one |
| Footer | Shows `cwd: <dir>` while an override is active |

The directory persists in the session file, so it survives `/resume` and `/fork`.

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

- Custom tools from *other* extensions that take paths are not rewritten — they see the original session cwd.
- The footer `pwd` segment still shows the session cwd (pi renders it from the immutable `SessionManager`); the `cwd:` status segment shows the override.
- Project trust, `.pi/extensions`, AGENTS.md, and skill discovery remain bound to the original session cwd.

## Test

```bash
npm test
```
