/**
 * The recorded policy baseline for `npm run policy:check`. The normative configuration lives in the
 * adopted standard copy (`docs/quality/strict-oxlint-oxfmt-5.1.2.md`); this file records what the
 * repository itself decides: the source-profile mapping, the recorded allowances and directive
 * inventory, and the tool versions the configuration was qualified against. Evidence for each
 * recorded exception lives in `docs/quality/quality-exceptions.md` and is exercised by the
 * qualification controls in `test-quality.ts`.
 */

/** A recorded rule allowance (standard section 2), applied to a profile before comparison. */
export type RuleAllowance = { id: string; rule: string; options: unknown };

/** An authorized site directive with its exact per-file count (standard section 2.4). */
export type DirectiveEntry = { file: string; rule: string; id: string; count: number };

export type SourceProfiles = {
  readonly standard: string;
  /** Installed toolchain, verified current against the public registry on 2026-11-01 (section 5.1). */
  readonly toolFloors: Record<string, string>;
  /** Compiler options that must stay enabled project-wide (section 4.2). No allowJs/checkJs: the
   * repository contains no maintained JavaScript. */
  readonly requiredCompilerOptions: readonly string[];
  /** Source-profile mapping (standard section 1.2): genuine test code in this repository is the
   * `test*.ts` family at the root, alongside the standard's own naming patterns for future files. */
  readonly testProfileFiles: readonly string[];
  /** Repository inventory mapped to the standard's source profiles (section 4.1). A maintained
   * source that matches no profile fails `policy:check` until it is classified here. */
  readonly profiles: ReadonlyArray<{ profile: string; globs: readonly string[] }>;
  /** Recorded rule allowances applied to the standard's baseline before comparison (section 2).
   * Each entry must have a quality-exception record in `docs/quality/quality-exceptions.md`. */
  readonly ruleAllowances: ReadonlyArray<RuleAllowance>;
  /** Authorized site directives: file, rule, and exception id, with the exact authorized count per
   * file (standard section 2.4). Directives anywhere else — or any other directive form — fail
   * `policy:check`. Each id must have a quality-exception record. */
  readonly directiveInventory: ReadonlyArray<DirectiveEntry>;
};

export const sourceProfiles: SourceProfiles = {
  standard: "Strict Oxlint and Oxfmt Engineering Standard v5.1.2",
  toolFloors: {
    oxlint: "1.90.0",
    "oxlint-tsgolint": "7.0.2005",
    oxfmt: "0.75.0",
    "oxc-parser": "0.156.0",
  },
  requiredCompilerOptions: [
    "strict",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "noImplicitOverride",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noUncheckedSideEffectImports",
    "forceConsistentCasingInFileNames",
  ],
  testProfileFiles: [
    "test*.ts",
    "**/*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "**/*.spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
    "**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
  ],
  profiles: [
    {
      profile: "production",
      globs: [
        "index.ts",
        "cwd-context.ts",
        "native-paths.ts",
        "selection.ts",
        "tool-wrapper.ts",
        "mutation-delegate.ts",
        "scripts/**/*.ts",
      ],
    },
    {
      profile: "tests",
      globs: ["test*.ts"],
    },
  ],
  ruleAllowances: [],
  directiveInventory: [
    { file: "cwd-context.ts", rule: "no-param-reassign", id: "QX-001", count: 2 },
    { file: "index.ts", rule: "no-param-reassign", id: "QX-001", count: 1 },
    { file: "tool-wrapper.ts", rule: "no-param-reassign", id: "QX-001", count: 4 },
    { file: "index.ts", rule: "max-params", id: "QX-002", count: 1 },
    { file: "tool-wrapper.ts", rule: "max-params", id: "QX-002", count: 1 },
    { file: "index.ts", rule: "no-useless-undefined", id: "QX-003", count: 1 },
    { file: "selection.ts", rule: "no-useless-undefined", id: "QX-003", count: 1 },
    { file: "tool-wrapper.ts", rule: "no-unsafe-type-assertion", id: "QX-004", count: 2 },
  ],
};
