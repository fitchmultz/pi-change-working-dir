/**
 * Real policy and acceptance-gate verification against isolated temporary roots (no synthetic
 * compiler/AST/format probes and no live-repository mutations).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test as nodeTest } from "node:test";

const repo = import.meta.dirname;

function run(command: string, args: string[], cwd = repo): { code: number | null; output: string } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env,
    timeout: 120_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createIsolatedPolicyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cwd-policy-"));
  const files = [
    "package.json",
    "tsconfig.json",
    ".oxlintrc.json",
    ".oxfmtrc.json",
    "docs/quality/strict-oxlint-oxfmt-5.1.2.md",
    ...globSync(["*.ts", "scripts/**/*.ts"], { cwd: repo }),
  ];
  for (const rel of files) {
    const dest = join(root, rel);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(join(repo, rel), dest);
  }
  return root;
}

nodeTest(
  "policy verification rejects unclassified sources, unauthorized directives, and config downgrades",
  () => {
    const root = createIsolatedPolicyRoot();
    try {
      const clean = run(process.execPath, ["scripts/check-policy.ts", "--root", root]);
      assert.equal(clean.code, 0, clean.output);

      const unclassified = join(root, "tools", "unclassified.ts");
      mkdirSync(dirname(unclassified), { recursive: true });
      writeFileSync(unclassified, "export const value = 1;\n");
      const coverage = run(process.execPath, ["scripts/check-policy.ts", "--root", root]);
      assert.notEqual(coverage.code, 0, "unclassified maintained sources must fail policy");
      assert.match(coverage.output, /tools\/unclassified\.ts/);
      rmSync(join(root, "tools"), { recursive: true, force: true });

      const copied = join(root, "test-copied-directive.ts");
      writeFileSync(
        copied,
        "// oxlint-disable-next-line no-var -- QX-001: unauthorized directive copy.\nconst value = 1;\nconsole.log(value);\n",
      );
      const copiedCheck = run(process.execPath, ["scripts/check-policy.ts", "--root", root]);
      assert.notEqual(copiedCheck.code, 0, "directives outside the inventory must fail policy");
      assert.match(copiedCheck.output, /test-copied-directive\.ts/);
      rmSync(copied);

      const stray = join(root, "test-stray-directive.ts");
      writeFileSync(stray, "// eslint-disable-next-line no-console\nconsole.log(1);\n");
      const strayCheck = run(process.execPath, ["scripts/check-policy.ts", "--root", root]);
      assert.notEqual(strayCheck.code, 0, "unauthorized directive forms must fail policy");
      assert.match(strayCheck.output, /test-stray-directive\.ts/);
      rmSync(stray);

      const lintRaw: unknown = JSON.parse(readFileSync(join(repo, ".oxlintrc.json"), "utf8"));
      const downgradedLint = structuredClone(isRecord(lintRaw) ? lintRaw : {});
      if (isRecord(downgradedLint.rules)) {
        downgradedLint.rules["no-var"] = "off";
      }
      const lintPath = join(root, "downgraded-lint.json");
      writeFileSync(lintPath, JSON.stringify(downgradedLint));
      const lintCheck = run(process.execPath, [
        "scripts/check-policy.ts",
        "--root",
        root,
        "--lint-config",
        lintPath,
      ]);
      assert.notEqual(lintCheck.code, 0, "a downgraded lint configuration must fail policy");
      assert.match(lintCheck.output, /differs|baseline/);

      const formatRaw: unknown = JSON.parse(readFileSync(join(repo, ".oxfmtrc.json"), "utf8"));
      const downgradedFormat = structuredClone(isRecord(formatRaw) ? formatRaw : {});
      downgradedFormat.printWidth = 80;
      const formatPath = join(root, "downgraded-format.json");
      writeFileSync(formatPath, JSON.stringify(downgradedFormat));
      const formatCheck = run(process.execPath, [
        "scripts/check-policy.ts",
        "--root",
        root,
        "--format-config",
        formatPath,
      ]);
      assert.notEqual(formatCheck.code, 0, "a downgraded format configuration must fail policy");
      assert.match(formatCheck.output, /differs/);

      const pkgRaw: unknown = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
      const originalPkg = readFileSync(join(root, "package.json"), "utf8");
      const downgradedPkg = structuredClone(isRecord(pkgRaw) ? pkgRaw : {});
      if (isRecord(downgradedPkg.devDependencies)) {
        downgradedPkg.devDependencies.tsrs = "7.1.0-beta.tsrs1";
      }
      writeFileSync(join(root, "package.json"), JSON.stringify(downgradedPkg));
      const tsrsDowngrade = run(process.execPath, ["scripts/check-policy.ts", "--root", root]);
      assert.notEqual(tsrsDowngrade.code, 0, "a below-floor tsrs prerelease must fail policy");
      assert.match(tsrsDowngrade.output, /tsrs 7\.1\.0-beta\.tsrs1 is below/);

      const promotedPkg = structuredClone(isRecord(pkgRaw) ? pkgRaw : {});
      if (isRecord(promotedPkg.devDependencies)) {
        promotedPkg.devDependencies.tsrs = "7.1.0";
      }
      writeFileSync(join(root, "package.json"), JSON.stringify(promotedPkg));
      const tsrsStable = run(process.execPath, ["scripts/check-policy.ts", "--root", root]);
      assert.equal(tsrsStable.code, 0, tsrsStable.output);
      writeFileSync(join(root, "package.json"), originalPkg);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

nodeTest("acceptance aggregator runs gates independently and fails when any gate fails", () => {
  const pass = run(process.execPath, ["scripts/run-gates.ts", "check:lock", "policy:check"]);
  assert.equal(pass.code, 0, pass.output);
  assert.match(pass.output, /pass: check:lock/);
  assert.match(pass.output, /pass: policy:check/);

  const partial = run(process.execPath, ["scripts/run-gates.ts", "nonexistent-gate", "check:lock"]);
  assert.notEqual(partial.code, 0, "a failing gate must fail the aggregate");
  assert.match(partial.output, /fail \(\d+\): nonexistent-gate/);
  assert.match(partial.output, /pass: check:lock/);
});
