/**
 * Policy conformance verifier for the adopted standard (`docs/quality/strict-oxlint-oxfmt-5.1.2.md`).
 * It compares the effective lint and formatter configuration against the standard's own normative
 * blocks after the recorded source-profile mapping and rule allowances, requires compiler
 * membership for every maintained source, and enforces the authorized suppression-directive
 * inventory exactly: a directive that is copied, duplicated, unrecorded, or unused fails here.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseSync } from "oxc-parser";

import { sourceProfiles } from "./policy-baseline.ts";

const { directiveInventory, ruleAllowances } = sourceProfiles;
const repo = resolve(import.meta.dirname, "..");
const cliArgs = process.argv.slice(2);
const lintConfigPath = cliValue("--lint-config") ?? ".oxlintrc.json";
const formatConfigPath = cliValue("--format-config") ?? ".oxfmtrc.json";
const guidePath = join(repo, "docs/quality/strict-oxlint-oxfmt-5.1.2.md");
const problems: string[] = [];
const report: string[] = [];

const guide = readFileSync(guidePath, "utf8");
const guideLint = jsonBlocks(guide).find(isLintBlock);
const guideFormat = jsonBlocks(guide).find(isFormatBlock);
if (guideLint === undefined || guideFormat === undefined) {
  problems.push("the adopted standard copy is missing its normative configuration blocks");
}

const lintOk = checkLintConfig();
if (lintOk && guideFormat !== undefined && !same(readJson(formatConfigPath), guideFormat)) {
  problems.push(".oxfmtrc.json differs from the standard's formatter block");
}
report.push(
  `config digests: lint ${digest(readJson(lintConfigPath))} format ${digest(readJson(formatConfigPath))}`,
);

const devDependencies: unknown = readJson("package.json").devDependencies;
for (const [name, floor] of Object.entries(sourceProfiles.toolFloors)) {
  const raw = isRecord(devDependencies) ? devDependencies[name] : undefined;
  const declared = typeof raw === "string" ? raw : undefined;
  if (declared === undefined) {
    problems.push(`${name} is not a dev dependency`);
  } else if (compareVersions(declared.replace(/^[^0-9]*/, ""), floor) < 0) {
    problems.push(`${name} ${declared} is below the qualified version ${floor}`);
  }
}

checkCompilerOptions();
const maintainedSources = checkCoverage();
checkDirectives(maintainedSources);

console.log(`policy conformance (${sourceProfiles.standard})`);
for (const line of report) {
  console.log(`  ${line}`);
}
if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`  FAIL ${problem}`);
  }
  process.exit(1);
}
console.log(
  "  OK: configuration, mapping, allowances, tool floors, coverage, and directives conform.",
);

/** Compare the lint config against the standard's baseline plus the recorded repository mapping. */
function checkLintConfig(): boolean {
  if (guideLint === undefined) {
    return false;
  }
  const expected = structuredClone(guideLint);
  const overrides = isUnknownArray(expected.overrides) ? expected.overrides : [];
  const testProfile = overrides.find((entry) => isRecord(entry) && isTestProfile(entry));
  if (isRecord(testProfile) && Array.isArray(testProfile.files)) {
    testProfile.files = [...sourceProfiles.testProfileFiles];
  } else {
    problems.push("the standard's test-profile override is missing or unrecognized");
    return false;
  }
  for (const allowance of ruleAllowances) {
    if (isRecord(testProfile.rules)) {
      testProfile.rules[allowance.rule] = allowance.options;
    }
  }
  if (!same(readJson(lintConfigPath), expected)) {
    problems.push(".oxlintrc.json differs from the standard's baseline plus the recorded mapping");
    return false;
  }
  return true;
}

/** Section 4.2: the required compiler options must stay enabled in the single compiler project. */
function checkCompilerOptions(): void {
  const compilerOptions = readJson("tsconfig.json").compilerOptions;
  if (!isRecord(compilerOptions)) {
    problems.push("tsconfig.json has no compilerOptions object");
    return;
  }
  for (const option of sourceProfiles.requiredCompilerOptions) {
    if (compilerOptions[option] !== true) {
      problems.push(`compiler option ${option} must stay enabled`);
    }
  }
}

/** Section 4.1: every maintained source is classified and owned by the compiler project. */
function checkCoverage(): string[] {
  const includeJson: unknown = readJson("tsconfig.json").include;
  const include: string[] = isUnknownArray(includeJson) ? includeJson.map(String) : [];
  const globs = sourceProfiles.profiles.flatMap((profile) => profile.globs);
  const maintained: string[] = [];
  for (const file of walk(".")) {
    if (!globs.some((glob) => matches(glob, file))) {
      problems.push(
        `${file} is a maintained source with no profile; classify it in policy-baseline.ts`,
      );
      continue;
    }
    maintained.push(file);
    if (!include.some((entry) => matches(entry, file))) {
      problems.push(`${file} has no compiler project owner`);
    }
  }
  report.push(`maintained sources: ${maintained.length}`);
  return maintained;
}

/** Section 2.4: only recorded next-line directives exist, exactly as inventoried. */
function checkDirectives(sources: string[]): void {
  const found = new Map<string, Array<{ rule: string; id: string }>>();
  let directives = 0;
  for (const file of sources) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) {
      continue;
    }
    const text = readFileSync(join(repo, file), "utf8");
    const comments = parseSync(file, text, { sourceType: "module" }).comments;
    for (const comment of comments) {
      directives += checkDirectiveComment(file, text.slice(comment.start, comment.end), found);
    }
  }
  for (const entry of directiveInventory) {
    const actual = (found.get(entry.file) ?? []).filter(
      (directive) => directive.rule === entry.rule && directive.id === entry.id,
    );
    if (actual.length !== entry.count) {
      problems.push(
        `${entry.file}: ${entry.id} expects ${entry.count} ${entry.rule} directive(s), found ${actual.length}`,
      );
    }
  }
  report.push(`suppression directives: ${directives}`);
}

/** One comment: authorized form is a single-rule next-line directive with a recorded id. */
function checkDirectiveComment(
  file: string,
  body: string,
  found: Map<string, Array<{ rule: string; id: string }>>,
): number {
  if (!/(?:eslint|oxlint)-disable|@(?:ts-ignore|ts-expect-error|ts-nocheck|ts-check)/.test(body)) {
    return 0;
  }
  const authorized = /^\/\*?\/?\s*oxlint-disable-next-line\s+(\S+)\s+--\s+(QX-\d+)\b/.exec(body);
  if (authorized === null) {
    problems.push(`${file}: unauthorized suppression directive: ${body.trim()}`);
    return 1;
  }
  const [, rule, id] = authorized;
  if (rule === undefined || id === undefined) {
    problems.push(`${file}: malformed suppression directive: ${body.trim()}`);
    return 1;
  }
  const recorded = directiveInventory.some(
    (entry) => entry.file === file && entry.rule === rule && entry.id === id,
  );
  if (!recorded) {
    problems.push(`${file}: directive ${id} on ${rule} is not in the recorded inventory`);
    return 1;
  }
  const list = found.get(file) ?? [];
  list.push({ rule, id });
  found.set(file, list);
  return 1;
}

/** Optional override so the qualification harness can verify drift detection against a mutated copy. */
function cliValue(flag: string): string | undefined {
  const index = cliArgs.indexOf(flag);
  return index === -1 ? undefined : cliArgs[index + 1];
}

function jsonBlocks(markdown: string): unknown[] {
  const found: unknown[] = [];
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    found.push(JSON.parse(match[1] ?? ""));
  }
  return found;
}

/** The test-profile override is the one carrying the reduced structural limits. */
function isTestProfile(override: Record<string, unknown>): boolean {
  return JSON.stringify(override.rules ?? {}).includes('"max":15');
}

function isLintBlock(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && "plugins" in value && "categories" in value && "overrides" in value;
}

function isFormatBlock(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && "printWidth" in value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function readJson(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(repo, path), "utf8"));
  return isRecord(parsed) ? parsed : {};
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) {
      return l < r ? -1 : 1;
    }
  }
  return 0;
}

/** Repository source inventory, relative forward-slash paths, honoring .gitignore-level skips. */
function walk(dir: string): string[] {
  const found: string[] = [];
  const skipped = new Set([".git", "node_modules", ".pi"]);
  for (const name of readdirSync(join(repo, dir))) {
    const full = dir === "." ? name : `${dir}/${name}`;
    if (statSync(join(repo, full)).isDirectory()) {
      if (!skipped.has(name)) {
        found.push(...walk(full));
      }
    } else if (/\.[cm]?[jt]sx?$/.test(full)) {
      found.push(relative(repo, join(repo, full)).split(sep).join("/"));
    }
  }
  return found;
}

function matches(glob: string, file: string): boolean {
  const pattern = glob
    .replace(/\*\*\//g, "GLOBSTAR/")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/GLOBSTAR\//g, "(?:[^/]+/)*");
  return new RegExp(`^${pattern}$`).test(file);
}
