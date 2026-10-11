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

You can also ask Pi: “Switch to `../worktrees/feature-x` and inspect the changes.” It uses the extension's `change_dir` tool to make the switch.

Look for `cwd:` in the footer to see where you're working. Pi's project indicator still shows the original project.

## Where it applies

The default `read`, `write`, `edit`, `ls`, `grep`, and `find` tools use the selected directory for relative paths. Absolute file paths keep their explicit target. Default `bash` and `powershell` calls start in the selected directory too. An operation already in progress keeps the directory it started with.

Your `!` and `!!` shell commands follow the selection unless an earlier custom shell handler takes over. Editors, browsers, and subagents can follow it through the [integration interface](docs/reference.md#extension-integration). Custom tools and remote or sandbox executors need their own directory handling.

## Your original project stays attached

Switching directories leaves project settings, trust, `AGENTS.md`, skills, and loaded extensions in place. Session identity and storage also stay with the original project. Use Pi's session/project controls if you want to change those resources too.

If you use path-policy extensions, load this extension first so they see the addressed paths. Directory selection isn't a sandbox. The [reference](docs/reference.md#execution-coverage) covers policy ordering, custom shell handlers, and SDK hosts.

## If a directory disappears

Pi saves the selection on the session branch, so it's restored when you resume or fork that branch. Reload, tree navigation, and compaction preserve it too.

If a saved directory is missing when you resume, Pi uses the original directory and shows a notice. It keeps the saved selection; reload after the path returns to restore it.

If your working directory disappears during the session, file and shell operations fail until you restore it or select another accessible directory. This also applies to absolute file paths.

If Pi's `change_dir` call fails, later calls in that tool batch are skipped to protect files in the previous directory. The next turn can proceed normally.

## Update and learn more

```sh
pi update --extension git:github.com/fitchmultz/pi-change-working-dir --approve
```

On Pi 1.0, `/reload` refreshes extension code; restart after dependency changes. This project is distributed through Git/GitHub.

- [Reference](docs/reference.md): tool ordering, paths, integration, and model context.
- [Development](docs/development.md): local loading, tests, and compatibility coverage.
- [Changelog](CHANGELOG.md): release history.
- [Issues](https://github.com/fitchmultz/pi-change-working-dir/issues): report a problem or suggest an improvement.

## License

[MIT](LICENSE), by [Mitch Fultz](https://github.com/fitchmultz).
