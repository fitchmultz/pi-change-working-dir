# pi-change-working-dir

Let Pi agents change their working directory mid-session — no quitting, no `cd` prefix on every command. Built for git worktrees and monorepos.

Pi's session cwd stays tied to the directory where the session started. This extension keeps a **virtual cwd** and routes tool calls there:

| Surface | Behavior |
|---|---|
| `bash` | Routes native Bash before directory checks; existing custom Bash tools keep their executor and receive a `cd <dir> \|\| exit 1` prefix |
| `read` / `write` / `edit` | Relative paths resolve against the virtual cwd |
| `ls` / `grep` / `find` | Relative + defaulted paths resolve against the virtual cwd |
| `ffgrep` / `fffind` | Path constraints follow the virtual cwd; see the search limitations below |
| `apply_edits` | `path` and `files[].path` resolve against the virtual cwd |
| `subagent` (pi-subagents) | Omitted or relative top-level `cwd` resolves against the virtual cwd |
| `!cmd` user bash | Runs in the virtual cwd |
| `pi.exec` / `spawn` | On Node-hosted Pi, session cwd or omitted cwd is rewritten to the virtual cwd |
| System prompt | Rewrites the active cwd so the model isn't misled by the baked-in one |
| Footer | Shows `cwd: <dir>` while an override is active |

The directory is validated, canonicalized, and persisted on each session branch, so it survives `/resume`, `/fork`, `/reload`, and `/tree` navigation. Directory names containing control characters are rejected before they can reach tool inputs.

## Requirements

Pi 0.84.0 or later. Native CLI Bash continues working after the original session directory is removed, provided the selected directory still exists. Shell settings are captured from the original session's user/project configuration and refreshed on `/reload`.

## Usage

**Agent:** calls the `change_dir` tool (`{ path: "../worktrees/feature-x" }`). Direct sibling tools then run in source order. Do not put `change_dir` in an explicit parallel batch.

**User:** `/cwd <path>` to change, `/cwd` to show, `/cwd -` to reset to the session's original directory.

## Install

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["git:github.com/fitchmultz/pi-change-working-dir"] }
```

Or for local development: `pi -e ./index.ts`

Restart Pi after updating extension code; `/reload` reinitializes the already loaded code.

## Limitations

- Custom tools other than `apply_edits`, `ffgrep`, `fffind`, and pi-subagents' `subagent` still receive Pi's original session cwd in their tool context. On Node-hosted Pi, `pi.exec` and other `child_process.spawn` calls that omit `cwd` or pass the session directory follow the virtual cwd. Explicit spawn `cwd` values other than the session directory are left alone. Bun-hosted Pi keeps its original ESM `spawn` binding, so `pi.exec` stays on the session directory there. `exec`, `execFile`, `spawnSync`, and `Bun.spawn` are not patched.
- FFF has unresolved search-scoping and result-path bugs after directory changes. Directory constraints can include files outside the virtual cwd, and searches across index roots can return paths that resolve to a different file in subsequent tools. Use the built-in search tools when reliable scoping is required. `/reload` clears FFF's auxiliary index cache but does not fix these bugs. FFF's interactive `@file` autocomplete also remains indexed from the original session cwd.
- FFF's query grammar cannot safely represent path constraints containing whitespace or a leading `!`; those calls are blocked with guidance to start Pi at the intended search root or use the built-in search tools. File-scoped `ffgrep` fuzzy fallbacks that would broaden beyond the requested file are also blocked. FFF treats whitespace and commas as separators inside every `exclude` value, including array items.
- Only the default `ffgrep` and `fffind` names receive FFF-specific scoping and result rebasing. `PI_FFF_MODE=override` and `multi_grep` are not supported.
- Explicit parallel wrappers can still race `change_dir`; Pi's native sibling calls are serialized because the tool declares sequential execution.
- Pi runs `tool_call` handlers in extension load order. Load this extension before path-policy extensions so they inspect rewritten paths. This extension is not a sandbox.
- On released Pi, `user_bash` is first-handler-wins. While a virtual cwd is active, this extension supplies a local executor using the configured `shellPath`. Put sandbox or remote-shell handlers before it to retain their executors; their cwd handling remains their responsibility. Existing custom Bash tools are also left intact and may still require the original directory. When Pi provides its optional native cwd hook, it is used instead.
- The native Bash fallback reads CLI file settings, respecting project trust. SDK-only shell settings and base-executor overrides are outside this fallback's scope.
- `/cwd` feedback uses Pi UI notifications; in print/JSON mode use the model-callable `change_dir` tool instead.
- An unavailable saved directory falls back to the session cwd without deleting the saved branch state; a later reload can restore it after the path returns.
- If the effective working directory is deleted or loses access, the listed file/search tools, `apply_edits`, and `subagent` are blocked until it is restored or an accessible directory is selected with `change_dir` or `/cwd`. This applies to absolute paths too: alternate spellings and host-specific normalization must not recreate a removed worktree.
- The footer `pwd` segment still shows the immutable session cwd; the `cwd:` status segment shows the override.
- Project trust, `.pi/extensions`, AGENTS.md, skill discovery, and other project-scoped extension state remain bound to the original session cwd.
- Windows is not currently tested.

## Native checkpoints

On Pi forks with `session_checkpoint`, the extension qualifies its existing branch-backed cwd only when cold restoration would select the same directory. Native dispatch already owns pending commands/tools/Bash; shutdown still detaches the spawn holder. No second cwd store is created. Retained FFF cursor routes block sleep because their memory is not restored; an unused FFF integration does not block or get disabled. Older Pi hosts ignore the additive hook.

## Test

```bash
npm ci --ignore-scripts
npm run check:compat
```

`check:compat` runs typechecking, the existing behavior suite, pack dry-run, and the
native Bash regression against the installed Pi development cohort (official
0.86.1 by default). The regression reports whether the official fallback or the
optional native cwd hook is in use; `PI_COMPAT_HOST=fork` requires the native hook.
The two paths intentionally retain different first-handler behavior for custom
user Bash operations.

Run just the native Bash regression against the installed dependency, or select a published Pi package or local build:

```bash
npm run test:bash
PI_PACKAGE_DIR=/absolute/path/to/pi/packages/coding-agent npm run test:bash
```
