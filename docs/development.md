# Development and compatibility

For installation and everyday use, see the [README](../README.md). The [reference](reference.md) documents execution details and extension integration.

## Local development

Requires Node.js 24.15 or later and Pi 1.0.0 or later. Development dependencies currently use official Pi 1.0.0 and TypeBox 1.3.34; [`package.json`](../package.json) is the source of truth for the exact versions. Distribution is Git/GitHub only, not npm.

```sh
npm ci --ignore-scripts
pi -e ./index.ts
```

On Pi 1.0, `/reload` refreshes extension code; restart after dependency changes.

## Verification

```sh
npm ci --ignore-scripts
npm run check
```

The checks exercise real Pi loading, native path traversal and Unicode targets, non-mutating admission/previews, directory restoration, policy-await snapshots, subprocess isolation, native edit rendering, structured prompt boundaries, and native Bash settings/output/cancellation. They use deterministic provider fixtures and do not send model requests. `check` also rejects a lockfile containing private-registry URLs; regenerate through your registry, then point `resolved` URLs back at `https://registry.npmjs.org/`.

To test against another Pi installation:

```sh
PI_PACKAGE_DIR=/absolute/path/to/pi-coding-agent PI_COMPAT_HOST=fork npm test
```

## Compatibility coverage

CI qualifies official Pi and current [`fitchmultz/pi`](https://github.com/fitchmultz/pi) `main` on Linux (Node 24.15, the minimum) and macOS (latest Node 24) with the shared `fitchmultz/.github` qualifier: package contracts, a fresh Git install, and the real bundled Pi CLI. Dropped host APIs are not qualification requirements.

The Bash fixture loads the real `background_command` extension through the selected SDK's optional factory when available, verifies the detached child's saved output and captured directory across a later selection change, and closes the owned job. Official SDKs without this factory report only that optional path unattempted; this is not a background pass. Background owners must capture the public directory-query result before awaiting spawn.

Read-json behavior beyond complete native schema inheritance still requires its own host-artifact qualification. Native Windows filesystem comparisons have been verified separately; Windows is not part of CI or full-extension qualification.

The qualification workflow is [`.github/workflows/pi-compatibility.yml`](../.github/workflows/pi-compatibility.yml). See the [changelog](../CHANGELOG.md) for historical compatibility changes.
