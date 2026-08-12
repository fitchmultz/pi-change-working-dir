# pi-change-working-dir

Let Pi agents change their working directory mid-session — no quitting, no `cd` prefix on every command. Built for git worktrees and monorepos.

Pi bakes the session cwd into its built-in tools at session start ([`createBashToolDefinition(cwd)`](https://github.com/earendil-works/pi/blob/v0.84.0/packages/coding-agent/src/core/tools/bash.ts) closures — there is no built-in chdir). This extension keeps a **virtual cwd** and transparently rewrites tool inputs:

| Surface | Behavior |
|---|---|
| `bash` | Prepends `cd <dir> \|\| exit 1` to every command |
| `read` / `write` / `edit` | Relative paths resolve against the virtual cwd |
| `ls` / `grep` / `find` | Relative + defaulted paths resolve against the virtual cwd |
| `ffgrep` / `fffind` | Searches are rooted in the virtual cwd |
| `apply_edits` | `path` and `files[].path` resolve against the virtual cwd |
| `subagent` (pi-subagents) | Omitted or relative top-level `cwd` resolves against the virtual cwd |
| `!cmd` user bash | Runs in the virtual cwd |
| `pi.exec` / `spawn` | Session cwd or omitted cwd is rewritten to the virtual cwd |
| System prompt | Rewrites the active cwd so the model isn't misled by the baked-in one |
| Footer | Shows `cwd: <dir>` while an override is active |

The directory is validated, canonicalized, and persisted on each session branch, so it survives `/resume`, `/fork`, `/reload`, and `/tree` navigation. Directory names containing control characters are rejected before they can reach tool inputs.

## Requirements

Pi 0.84.0 or later.

## Usage

**Agent:** calls the `change_dir` tool (`{ path: "../worktrees/feature-x" }`). Direct sibling tools then run in source order. Do not put `change_dir` in an explicit parallel batch.

**User:** `/cwd <path>` to change, `/cwd` to show, `/cwd -` to reset to the session's original directory.

## Install

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["git:github.com/fitchmultz/pi-change-working-dir"] }
```

Or for local development: `pi -e ./index.ts`

## Limitations

- Custom tools other than `apply_edits`, `ffgrep`, `fffind`, and pi-subagents' `subagent` still receive Pi's original session cwd in their tool context. `pi.exec` and other `child_process.spawn` calls that omit `cwd` or pass the session directory follow the virtual cwd. Explicit spawn `cwd` values other than the session directory are left alone. `exec`, `execFile`, and `Bun.spawn` are not patched.
- FFF tool calls follow the virtual cwd, but FFF's interactive `@file` autocomplete remains indexed from the original session cwd. Outside that tree, FFF can reuse a cached broader auxiliary index after moving deeper, broadening search scope and returning broader-root-relative paths; `/reload` clears that cache.
- FFF's query grammar cannot safely represent path constraints containing whitespace or a leading `!`; those calls are blocked with guidance to start Pi at the intended search root or use the built-in search tools. File-scoped `ffgrep` fuzzy fallbacks that would broaden beyond the requested file are also blocked. FFF treats whitespace and commas as separators inside every `exclude` value, including array items.
- Only the default `ffgrep` and `fffind` names receive FFF-specific scoping and result rebasing. `PI_FFF_MODE=override` and `multi_grep` are not supported.
- Explicit parallel wrappers can still race `change_dir`; Pi's native sibling calls are serialized because the tool declares sequential execution.
- Pi runs `tool_call` handlers in extension load order. Load this extension before path-policy extensions so they inspect rewritten paths. This extension is not a sandbox.
- Pi's `user_bash` hook is first-result-wins. While a virtual cwd is active, this extension supplies the `!cmd` executor, so order it deliberately relative to sandbox or remote-shell extensions. That executor uses Pi's default detected Bash because extension context does not expose a configured `shellPath`.
- `/cwd` feedback uses Pi UI notifications; in print/JSON mode use the model-callable `change_dir` tool instead.
- An unavailable saved directory falls back to the session cwd without deleting the saved branch state; a later reload can restore it after the path returns.
- If an active directory is later deleted or loses access, tool calls fail closed until it is restored or reset with `/cwd -`.
- The footer `pwd` segment still shows the immutable session cwd; the `cwd:` status segment shows the override.
- Project trust, `.pi/extensions`, AGENTS.md, skill discovery, and other project-scoped extension state remain bound to the original session cwd.
- Windows is not currently tested.

## Test

```bash
npm install
npm run check
```
