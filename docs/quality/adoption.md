# Quality standard adoption record

This repository follows [Strict Oxlint and Oxfmt Engineering Standard v5.1.2](strict-oxlint-oxfmt-5.1.2.md).
The record below states what is installed, what runs, and what the current state is. Decisions that
depart from the standard's own values are recorded in [quality-exceptions.md](quality-exceptions.md).

## Repository and version

- Repository: `fitchmultz/pi-change-working-dir` (a Pi extension package; distribution is
  Git/GitHub only, not npm).
- Adopted standard: Strict Oxlint and Oxfmt Engineering Standard v5.1.2. The adopted copy in this
  repository is `docs/quality/strict-oxlint-oxfmt-5.1.2.md`; it is the version the tools and checks
  here were measured against.

## Runtimes and package manager

- Node.js 24.22.3 (24.x) or 26.13.1 and later (`package.json` engines); `package.json` pins `npm@12.2.0` as the package
  manager. Install uses the public npm registry only; `npm run check:lock` rejects a lockfile with
  private-registry URLs.
- Pi runtime targets: the official `pi-coding-agent` release declared in `devDependencies` and the
  fork release this repository is developed against; qualification swaps the installed host through
  `PI_PACKAGE_DIR` without changing the pinned declarations.

## Installed tool versions

| Tool            | Version  | Role                                            |
| --------------- | -------- | ----------------------------------------------- |
| oxlint          | 1.90.0   | Lint gate, type-aware through the checker below |
| oxlint-tsgolint | 7.0.2005 | Type-aware checker                              |
| oxfmt           | 0.75.0   | Formatter                                       |
| oxc-parser      | 0.156.0  | Parser used by the policy verifier              |
| typescript      | 7.0.2    | Compiler gate (`tsc`)                           |

`scripts/policy-baseline.ts` records these as the qualification floors the verifier checks against.

## Configuration and acceptance paths

- Lint configuration: `.oxlintrc.json` — the standard's Appendix A baseline with the repository's
  recorded source-profile mapping (test code is the `test*.ts` family at the root).
- Formatter configuration: `.oxfmtrc.json` — the standard's formatter block. oxfmt owns every
  supported file it is pointed at, including Markdown, JSON, and YAML; `format:check` proves
  idempotence.
- Acceptance entry points: `npm run check` and `npm run check:compat`, both implemented by
  `scripts/run-gates.ts`. Gates run independently — every one runs and every failure counts — and
  the aggregate exit status reports them all. Individual gates: `check:lock`, `policy:check`,
  `format:check`, `lint`, `lint:agent`, `lint:fix`, `format`, `typecheck`, `test`, `pack:check`.
- Policy verification: `npm run policy:check` (`scripts/check-policy.ts`) compares the effective
  configuration against the adopted standard's own normative blocks, enforces the recorded
  directive inventory exactly, and fails on any unclassified maintained source.

## Compiler projects and source profiles

- One TypeScript project (`tsconfig.json`) covers the root sources and `scripts/`, with the
  standard's required compiler options enabled. `skipLibCheck` stays enabled: the repository ships
  no handwritten declarations, so there is no declaration closure to check.
- No maintained JavaScript exists, so `allowJs`/`checkJs` are not required.
- Source profiles follow the standard: production sources are `index.ts`, `cwd-context.ts`, and
  `scripts/**`; test sources are the `test*.ts` family. `scripts/policy-baseline.ts` records the
  inventory; a maintained file matching no profile fails `policy:check` until it is classified.

## Formatter and generator ownership

- oxfmt owns every supported file in the repository; no other formatter is configured. Formatting
  is expected to be idempotent, and `format:check` proves it.
- No code generators produce maintained sources. Qualification-control fixtures are runtime scratch
  space created and removed by `test-quality.ts`.

## Migration status

Complete. The phased migration (standard section 9.2) finished with this change: the toolchain and
policy verification landed first, the production sources were decomposed into typed modules and
repaired to zero findings, and the test sources followed — every manual finding fixed in source,
the lint gate joined `check`/`check:compat`, and no finding budget or baseline filter was ever
introduced. Seven quality exceptions are recorded (one rule allowance, six directive families,
37 inventoried site directives), each with evidence in
[quality-exceptions.md](quality-exceptions.md).

## Integrated verification

| Host                             | Role                                                                      | Result                                      |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------- |
| macOS arm64 qualification host   | Full toolchain: format, lint (type-aware), typecheck, tests, pack, policy | All gates pass (`npm run check`)            |
| CI (ubuntu-latest, macos-latest) | Dual-host acceptance at the integrated revision                           | See the PR checks for the integrated commit |

Integrated revision: recorded in the PR head commit for this change; the qualification-host run above
is at that revision and CI reproduces it.
