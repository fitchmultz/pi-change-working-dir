# pi-change-working-dir

Change the directory for subsequent work without restarting Pi. Built for git worktrees and monorepos, with branch-specific restoration and a small model-facing tool.

## Usage

- **Agent:** `change_dir({ path: "../worktrees/feature-x" })`, then relative paths and ordinary shell commands.
- **User:** `/cwd <path>` changes directory, `/cwd` shows it, and `/cwd -` returns to this run's original directory.

Absolute paths, `~`, and relative paths are supported. Targets must be accessible directories; symlinks are canonicalized and control-character names are rejected. Direct sibling tools run in source order. Do not place `change_dir` inside an explicit parallel wrapper.

Directory changes affect execution. Project settings, trust, AGENTS.md, skills, loaded extensions, session identity, and session storage remain attached to the original project. Use Pi's session/project controls when you intend to change those resources too.

## Install

```jsonc
// ~/.pi/agent/settings.json
{ "packages": ["git:github.com/fitchmultz/pi-change-working-dir"] }
```

Requires official Pi 0.87.0 or a compatible fork. Development and CI cover both official Pi and `fitchmultz/pi`.

```sh
pi update --extension git:github.com/fitchmultz/pi-change-working-dir --approve
```

Restart Pi after updating extension code. For local development: `pi -e ./index.ts`.

## Execution coverage

| Surface | Directory behavior |
|---|---|
| Default `read`, `write`, `edit`, `ls`, `grep`, `find` | Relative/default paths use the selected directory. Absolute targets remain explicit. |
| Default `bash`, `powershell` | Native shell execution uses the invocation's captured directory. |
| Cooperating editor, browser, and subagent extensions | Query the public interface below and capture their operation directory once. |
| User `!` / `!!` shell | Uses the fork's native Bash hook where available; otherwise a local native-executor fallback. |
| Model context | Structured directory updates preserve earlier messages and tool definitions. |
| Footer | The `cwd:` status shows the override; Pi's project segment retains its original meaning. |

Default-tool adapters preserve native schemas, renderers, cancellation, truncation, and file queues. Speculative edit previews wait until the target is admitted. Already-running calls retain their captured directory if another call changes the selection.

Custom tools, custom definitions under built-in names, and remote/sandbox executors are not replaced. They must integrate explicitly if they should follow directory changes. The extension does not patch `process.cwd()`, `child_process`, or `pi.exec`. An explicit subprocess directory always remains explicit.

### Policy and shell composition

Load this extension before path-policy extensions. Default native tool paths are bound in `tool_call`, so later policy handlers inspect the actual absolute targets. Cooperating tools can bind their own paths in `prepareArguments`, before all policy handlers. This extension is not a sandbox.

On official Pi, `user_bash` is first-handler-wins. An earlier custom handler retains its executor and owns its directory handling. On hook-capable forks, native Bash routing also supplies the selected directory to custom user-Bash operations. Explicit parallel wrappers and independent custom backends retain their own scheduling contracts.

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

The selected directory is stored on the session branch and survives resume, fork, reload, tree navigation, and compaction. Supported fork context windows preserve it too. `/cwd -` resets to the current run's original directory, including an explicit `--session-cwd` override.

An unavailable **saved** directory falls back to the original directory without deleting the saved selection. The model and UI receive the fallback notice. A later reload can restore the selection when the path returns.

If the **live** selected directory disappears or loses access, covered operations fail until it is restored or another accessible directory is selected. Absolute file targets do not silently bypass this recovery requirement. Validation does not promise an operating-system sandbox or atomic protection against external filesystem changes.

On forks with native checkpoints, the extension certifies its branch state only when cold restoration would select the same effective directory. No second execution-directory store is created.

## Model behavior

`change_dir` is an ordinary strict-schema, sequential tool. It does not require Astra-only APIs, asynchronous tool jobs, or tool discovery. Structured context updates preserve prompt prefixes on models/providers supporting mid-conversation system messages. Provider configuration and other extensions' whole-prompt overrides can affect caching; this package does not change them or promise a particular cache hit rate.

## Verification

```sh
npm ci --ignore-scripts
npm run check:compat
```

The checks exercise real Pi loading, directory restoration, policy-await snapshots, subprocess isolation, native edit rendering, structured prompt boundaries, and native Bash settings/output/cancellation. They use deterministic provider fixtures and do not send model requests.

```sh
PI_PACKAGE_DIR=/absolute/path/to/pi-coding-agent npm run check:compat
```

The compatibility matrix covers the latest qualified official/fork cohort on macOS and Linux. Windows is not currently qualified.
