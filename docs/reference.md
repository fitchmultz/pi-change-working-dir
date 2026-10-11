# Working-directory reference

This page covers execution details and the public interface for extension authors. For installation and everyday commands, see the [README](../README.md).

## Usage

- **Agent:** `change_dir({ path: "../worktrees/feature-x" })`, then relative paths and ordinary shell commands.
- **User:** `/cwd <path>` changes directory, `/cwd` shows it, and `/cwd -` returns to this run's original directory.

Absolute paths, `~`, and relative paths are supported. Targets must be accessible directories; symlinks are canonicalized and control-character names are rejected. Direct sibling tools run in source order. Do not place `change_dir` inside an explicit parallel wrapper.

Directory changes affect execution. Project settings, trust, AGENTS.md, skills, loaded extensions, session identity, and session storage remain attached to the original project. Use Pi's session/project controls when you intend to change those resources too.

If `change_dir` fails, later tool calls in the same batch are skipped rather than running in the previous directory. The next turn can proceed normally.

## Execution coverage

| Surface | Directory behavior |
|---|---|
| Default `read`, `write`, `edit`, `ls`, `grep`, `find` | Relative/default paths use the selected directory. Absolute targets remain explicit. |
| Default `bash`, `powershell` | Native shell execution uses the invocation's captured directory. |
| Cooperating editor, browser, and subagent extensions | Query the public interface below and capture their operation directory once. |
| User `!` / `!!` shell | Uses local native `user_bash` operations with first-handler-wins ordering. |
| Model context | Structured directory updates preserve earlier messages and tool definitions. |
| Footer | The `cwd:` status shows the override; Pi's project segment retains its original meaning. |

Default-tool adapters inherit native schemas (including the maintained Pi host's Read-json), renderers, cancellation, truncation, and file queues. Read-json is not implemented or copied here; its actual host artifact must be qualified separately. Speculative edit previews wait until the target is admitted. Already-running calls retain their captured directory if another call changes the selection.

Paths follow native filesystem traversal, including symlinks, `..`, trailing separators, and exact Unicode names. Native read filename fallbacks remain available. Admission and previews never create directories. Mutation validation and write-parent creation run inside Pi's existing file queue, so queued edits can follow queued file creation. Both 1.0 targets use the public local publisher (`writeFile`) inside the native queue. This is not the stronger transaction/metadata contract of `pi-apply-edits`.

Custom tools, custom definitions under built-in names, and remote/sandbox executors are not replaced. They must integrate explicitly if they should follow directory changes. The extension does not patch `process.cwd()`, `child_process`, or `pi.exec`. An explicit subprocess directory always remains explicit.

### Policy and shell composition

Load this extension before path-policy extensions. Default native tool paths are bound in `tool_call`, so later policy handlers inspect absolute addressed paths. POSIX traversal components remain intact; policies must not lexically collapse symlink traversal when identifying a target. Cooperating tools can bind their own paths in `prepareArguments`, before all policy handlers. This extension is not a sandbox.

On both 1.0 targets, `user_bash` is first-handler-wins. An earlier custom handler retains its executor and owns its directory handling. Explicit parallel wrappers and independent custom backends retain their own scheduling contracts.

Default adapters read the original project's CLI file settings, respecting project trust, and refresh them on reload. SDK-only in-memory shell/image settings and custom base executors are outside these file-setting adapters. A direct official SDK `session.executeBash()` call bypasses extension `user_bash`; SDK hosts should pass their own directory-aware operations or invoke the registered tool.

## Extension integration

The active owner answers synchronous requests on Pi's public event bus. It remains the only owner of directory selection and restoration; consumers must not read its private journal entries.

### Resolve an operation directory

Channel: `pi-change-working-dir:resolve-execution-cwd`

```ts
type DirectoryRequest = {
  sessionManager: ExtensionContext["sessionManager"];
  result?: { cwd: string; error?: string };
};

const request: DirectoryRequest = { sessionManager: ctx.sessionManager };
pi.events.emit("pi-change-working-dir:resolve-execution-cwd", request);
```

- A reply identifies the canonical absolute execution directory. Propagate `error`; never replace an error with a fallback directory.
- With no active directory owner, use `ctx.cwd`.
- With an identifiable older `pi-change-working-dir` installation but no reply, require an update and restart. Use public tool **and command** `sourceInfo` plus package provenance; excluding `change_dir` does not remove `/cwd`. An unrelated tool with the same name is not this owner.
- Resolve once before policy, queuing, or other awaited preparation. Preserve that value through execution. Preserve explicit operation directories and saved child/retry targets.
- Keep project/configuration, browser identity, recordings already in progress, and session-owned storage on their appropriate original roots.

The owner initializes through session lifecycle events, normal `before_agent_start`, and its own tool/command entrypoints. Bare SDK `createAgentSession()` followed by `prompt()` is supported. Concurrent sessions require separate native resource-loader/runtime instances.

### Initialize an explicit child directory

Channel: `pi-change-working-dir:set-execution-cwd`. Add `path: string` to the same request shape. The owner uses the same validation and branch persistence as `change_dir` and returns the same result shape.

Use this after owner initialization and before the first operation of a **new** context-forked child whose explicit launch directory must override inherited parent selection. The change belongs to the child's branch. Do not repeat it on continuation or erase a child's later directory choices. Initialization failure must stop wrong-directory work.

The interface is available starting with **0.5.0**. Update cooperating editor, browser, and subagent packages together, then restart Pi. Older consumers do not automatically inherit the selected directory, and a newer consumer with an older active owner is not a supported pair.

## Restoration and unavailable paths

The selected directory is stored on the session branch and survives resume, fork, reload, tree navigation, and compaction. `/cwd -` resets to the current run's original directory.

An unavailable **saved** directory falls back to the original directory without deleting the saved selection. The model and UI receive the fallback notice. A later reload can restore the selection when the path returns.

If the **live** selected directory disappears or loses access, covered operations fail until it is restored or another accessible directory is selected. Absolute file targets do not silently bypass this recovery requirement. Validation does not promise an operating-system sandbox or atomic protection against external filesystem changes.

The maintained Pi 1.0 host drops the old checkpoint, Bash-cwd-hook, and file-publisher exports. Branch recovery remains supported through native journal restoration; no second execution-directory store is created.

## Model behavior

`change_dir` is an ordinary strict-schema, sequential tool. It does not require Astra-only APIs, asynchronous tool jobs, or tool discovery. Structured context updates become native system deltas without mutating the journal. Baseline restoration inspects only newly appended ancestry on ordinary requests; full branch reconstruction occurs after compaction, branch changes, or restore. Legacy saved presentation snapshots remain readable. Structured updates preserve prompt prefixes on models/providers supporting mid-conversation system messages. Provider configuration and other extensions' whole-prompt overrides can affect caching; this package does not change them or promise a particular cache hit rate.
