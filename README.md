# pi-change-working-dir

A [Pi](https://github.com/fitchmultz/pi) extension that lets you switch working directories without restarting your session. Move between Git worktrees or folders in a monorepo while keeping your conversation open.

![A directory change selects a worktree for subsequent file and shell tools, while the original project's settings, instructions, and session storage stay in place.](.github/readme/directory-flow.png)

*Choose a directory for your next operations; your original project and session stay attached.*

## Install and start

Requires **Pi 1.0.0 or later** and **Node.js 24.15 or later**. Install from GitHub:

```sh
pi install git:github.com/fitchmultz/pi-change-working-dir
pi
```

In Pi, select an existing directory:

```text
/cwd ../worktrees/feature-x
```

Your next file and shell operations use that directory. If Pi was already running when you installed the extension, restart it to load the package.

## Use it day to day

| Command | What it does |
|---|---|
| `/cwd <path>` | Switch to an accessible directory. |
| `/cwd` | Show the current working directory. |
| `/cwd -` | Return to this run's original directory. |

Paths can be absolute, relative to the current working directory, or start with `~`. Symlinks resolve to their real directory. Paths containing control characters are rejected.

You can also ask Pi to switch directories for you. The extension gives it a `change_dir` tool, so a request such as “Switch to `../worktrees/feature-x` and inspect the changes” can stay in the same conversation.

The footer's `cwd:` status shows a directory override. Pi's existing project indicator still refers to the original project.

## What follows the directory change?

| Surface | Behavior |
|---|---|
| Default file and search tools | Relative paths for `read`, `write`, `edit`, `ls`, `grep`, and `find` use the selected directory. Absolute file paths keep their explicit target. |
| Default shell tools | `bash` and `powershell` start in the directory captured for that call. |
| Your `!` and `!!` shell commands | Use the selected directory through Pi's local shell handler, unless an earlier custom handler takes ownership. |
| Cooperating extensions | Editors, browsers, and subagents can follow the selection through the [public integration interface](docs/reference.md#extension-integration). |

Already-running operations keep the directory they started with. Custom tools and remote or sandbox executors need their own integration; changing directories does not automatically redirect them.

**Your original project stays attached.** Project settings, trust, `AGENTS.md`, skills, loaded extensions, session identity, and session storage remain rooted there. Use Pi's session/project controls when you also want to change those resources.

If you use a path-policy extension, load this extension first so the policy sees the addressed paths. Directory selection provides no sandbox boundary. See [execution coverage and policy details](docs/reference.md#execution-coverage) for custom shell handlers and SDK hosts.

## Return, resume, and recover

The selected directory is saved on the session branch and restored after resume, fork, reload, tree navigation, and compaction. `/cwd -` returns to the current run's original directory.

- **A saved directory is missing when you resume:** Pi falls back to the original directory and shows a notice, while retaining the saved selection. Reload after the path returns to restore it.
- **The active directory disappears during work:** Covered operations fail until you restore it or choose another accessible directory. Absolute file paths also require this recovery.
- **Pi's `change_dir` call fails:** Later calls in that tool batch are skipped, protecting files in the previous directory. The next turn can proceed normally.

## Update and learn more

```sh
pi update --extension git:github.com/fitchmultz/pi-change-working-dir --approve
```

On Pi 1.0, `/reload` refreshes extension code; restart after dependency changes. This project is distributed through Git/GitHub.

- [Reference](docs/reference.md) — tool ordering, native path behavior, extension integration, restoration, and model context.
- [Development](docs/development.md) — local loading, test commands, and compatibility coverage.
- [Changelog](CHANGELOG.md) — release history.
- [Issues](https://github.com/fitchmultz/pi-change-working-dir/issues) — report a problem or suggest an improvement.

## License

[MIT](LICENSE), by [Mitch Fultz](https://github.com/fitchmultz).
