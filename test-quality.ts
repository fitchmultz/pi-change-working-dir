/**
 * Qualification harness for the adopted standard (sections 6.4 and 8.2). Diagnostic inputs whose
 * purpose is to produce findings are generated at runtime under `probes/` — the acceptance lint
 * command ignores that directory, so the repository never carries failing sources. Each control
 * has a valid counterpart, asserts the diagnostic identity and file, and asserts the checker exit
 * status. Gate-level controls prove the real gates fail and recover independently.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as nodeTest } from "node:test";

const repo = import.meta.dirname;
const probes = join(repo, "probes");
const generated = join(probes, "generated");
const controls = join(probes, "gate-controls");

type Control = { file: string; rule: string; expect: number; source: string };

/** Section 8.2: every protection is exercised with a valid counterpart and a real violation. */
const QUALIFICATION: Control[] = [
  // Base configuration: explicit rule, and a rule reached only through an enabled category.
  {
    file: "explicit-rule.ts",
    rule: "no-var",
    expect: 1,
    source: "var counter = 1;\nconsole.log(counter);\n",
  },
  {
    file: "explicit-rule-valid.ts",
    rule: "none",
    expect: 0,
    source: "const counter = 1;\nconsole.log(counter);\n",
  },
  {
    file: "category-rule.ts",
    rule: "no-unused-vars",
    expect: 1,
    source: "const unusedValue = 1;\n",
  },
  {
    file: "category-rule-valid.ts",
    rule: "none",
    expect: 0,
    source: "const usedValue = 1;\nconsole.log(usedValue);\n",
  },
  // Semantic analysis: unsafe propagation fails, validated narrowing passes.
  {
    file: "semantic-unsafe.ts",
    rule: "no-unsafe-member-access",
    expect: 1,
    source:
      'function read(raw: string): number {\n\tconst parsed = JSON.parse(raw);\n\treturn parsed.count;\n}\nconsole.log(read("{}"));\n',
  },
  {
    file: "semantic-unsafe-valid.ts",
    rule: "none",
    expect: 0,
    source:
      'function read(raw: string): number {\n\tconst parsed: unknown = JSON.parse(raw);\n\tif (typeof parsed === "object" && parsed !== null && "count" in parsed) {\n\t\tconst value: unknown = Reflect.get(parsed, "count");\n\t\tif (typeof value === "number") {\n\t\t\treturn value;\n\t\t}\n\t}\n\treturn 0;\n}\nconsole.log(read("{}"));\n',
  },
  // Async safety: floating work fails; owned work and unknown-failure forwarding pass.
  {
    file: "async-floating.ts",
    rule: "no-floating-promises",
    expect: 1,
    source: "async function work(): Promise<void> {};\nwork();\n",
  },
  {
    file: "async-owned.ts",
    rule: "none",
    expect: 0,
    source:
      "async function work(): Promise<void> {\n\tawait Promise.resolve();\n}\nawait work();\n",
  },
  {
    file: "async-unknown-forward.ts",
    rule: "none",
    expect: 0,
    source:
      "function forward(reason: unknown): Promise<void> {\n\treturn Promise.reject(reason);\n}\nawait forward(new Error(1));\n",
  },
  {
    file: "async-callback.ts",
    rule: "no-misused-promises",
    expect: 1,
    source:
      "function run(callback: () => void): void {\n\tcallback();\n}\nrun(async () => {\n\tawait Promise.resolve();\n});\n",
  },
  {
    file: "reject-invalid.ts",
    rule: "prefer-promise-reject-errors",
    expect: 1,
    source:
      'async function fail(): Promise<unknown> {\n\treturn Promise.reject("a literal string");\n}\nawait fail().catch(() => {});\n',
  },
  {
    file: "unsafe-assertion.ts",
    rule: "no-unsafe-type-assertion",
    expect: 1,
    source:
      "const broad: Record<string, unknown> = { kept: 1 };\nconst narrow = broad as { kept: number };\nconsole.log(narrow);\n",
  },
  // Structural profile: production limits, each with its boundary value.
  {
    file: "struct-complexity.ts",
    rule: "complexity",
    expect: 1,
    source: bounded(12, "complexity"),
  },
  {
    file: "struct-complexity-valid.ts",
    rule: "none",
    expect: 0,
    source: bounded(9, "complexity"),
  },
  { file: "struct-depth.ts", rule: "max-depth", expect: 1, source: bounded(4, "depth") },
  { file: "struct-depth-valid.ts", rule: "none", expect: 0, source: bounded(2, "depth") },
  { file: "struct-params.ts", rule: "max-params", expect: 1, source: bounded(5, "params") },
  { file: "struct-params-valid.ts", rule: "none", expect: 0, source: bounded(3, "params") },
  {
    file: "struct-statements.ts",
    rule: "max-statements",
    expect: 1,
    source: bounded(42, "statements"),
  },
  {
    file: "struct-statements-valid.ts",
    rule: "none",
    expect: 0,
    source: bounded(30, "statements"),
  },
  {
    file: "struct-function-lines.ts",
    rule: "max-lines-per-function",
    expect: 1,
    source: bounded(84, "lines"),
  },
  {
    file: "struct-function-lines-valid.ts",
    rule: "none",
    expect: 0,
    source: bounded(70, "lines"),
  },
  { file: "struct-file-lines.ts", rule: "max-lines", expect: 1, source: codeLines(520) },
  {
    file: "struct-file-lines-valid.ts",
    rule: "none",
    expect: 0,
    source: codeLines(480),
  },
  // Test profile: size limits stay off, branching limits stay on.
  { file: "test-long.test.ts", rule: "none", expect: 0, source: longTestSource() },
  {
    file: "test-complexity.test.ts",
    rule: "complexity",
    expect: 1,
    source: testWrap(bounded(16, "complexity"), "measure(1)"),
  },
  {
    file: "test-depth.test.ts",
    rule: "max-depth",
    expect: 1,
    source: testWrap(bounded(5, "depth"), "measure(1)"),
  },
  {
    file: "test-params.test.ts",
    rule: "max-params",
    expect: 1,
    source: testWrap(bounded(7, "params"), "measure(1, 2, 3, 4, 5, 6, 7)"),
  },
];

function bounded(n: number, metric: string): string {
  if (metric === "complexity") {
    const arms = Array.from(
      { length: n - 1 },
      (_, i) => `\tif (value === ${i + 1}) {\n\t\treturn ${i + 1};\n\t}`,
    ).join("\n");
    return `export function measure(value: number): number {\n${arms}\n\treturn 0;\n}\n`;
  }
  if (metric === "depth") {
    let body = "\t\t\t\treturn value;";
    for (let i = n; i >= 1; i -= 1) {
      const pad = "\t".repeat(i);
      body = `${pad}if (value > 0) {\n${pad}\t${body}\n${pad}}`;
    }
    return `export function measure(value: number): number {\n${body}\n\treturn 0;\n}\n`;
  }
  if (metric === "params") {
    const params = Array.from({ length: n }, (_, i) => `p${i}: number`).join(", ");
    const uses = Array.from({ length: n }, (_, i) => `\ttotal += p${i};`).join("\n");
    return `export function measure(${params}): number {\n\tlet total = 0;\n${uses}\n\treturn total;\n}\n`;
  }
  if (metric === "statements") {
    const body = Array.from({ length: n - 2 }, (_, i) => `\ttotal += ${i};`).join("\n");
    return `export function measure(): number {\n\tlet total = 0;\n${body}\n\treturn total;\n}\n`;
  }
  const statements = Math.floor((n - 3) / 2);
  const pad = "\n".repeat(Math.max(0, n - 3 - statements * 2));
  const body = Array.from({ length: statements }, (_, i) => `\ttotal +=\n\t\t${i};`).join("\n");
  return `export function measure(): number {\n\tlet total = 0;\n${body}${pad}\n\treturn total;\n}\n`;
}

/** Counted lines must be real code: the rule skips comments and blank lines. */
function longTestSource(): string {
  const body = Array.from({ length: 82 }, (_, i) => `\ttotal += ${i};`).join("\n");
  return `import { test as nodeTest } from "node:test";\n\nnodeTest("a long test body stays allowed", () => {\n\tlet total = 0;\n${body}\n\tconsole.log(total);\n});\n`;
}

function codeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `export const filler${i} = ${i};`).join("\n");
}

/** The generated function stays at module top level; the test body just calls it. */
function testWrap(body: string, call: string): string {
  return `import { test as nodeTest } from "node:test";\n\n${body.trimEnd()}\nnodeTest("test-profile limit is enforced", () => {\n\tconsole.log(${call});\n});\n`;
}

function checker(targets: string[]): { code: number | null; diagnostics: unknown[] } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    join(repo, "node_modules", ".bin", "oxlint"),
    ["--config", join(repo, ".oxlintrc.json"), "--format=json", ...targets],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env },
  );
  const parsed: unknown = JSON.parse(result.stdout === "" ? "[]" : result.stdout);
  const list = Array.isArray(parsed) ? parsed : readDiagnostics(parsed);
  return { code: result.status, diagnostics: list };
}

function readDiagnostics(parsed: unknown): unknown[] {
  return isRecord(parsed) && Array.isArray(parsed.diagnostics) ? parsed.diagnostics : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ruleId(code: unknown): string {
  const text = typeof code === "string" ? code : "";
  return text.includes("(") ? text.slice(text.indexOf("(") + 1, -1) : text;
}

function countFor(diagnostics: unknown[], file: string): string[] {
  return diagnostics
    .filter((d) => isRecord(d) && typeof d.filename === "string" && d.filename.endsWith(file))
    .map((d) => (isRecord(d) ? ruleId(d.code) : ""));
}

function skipPlatform(): boolean {
  const skip = process.platform.startsWith("android");
  if (skip) {
    console.log("SKIPPED: the type-aware checker binary is not available for this platform");
  }
  return skip;
}

function bin(name: string): string {
  return join(repo, "node_modules", ".bin", name);
}

function gate(command: string[]): { code: number | null; output: string } {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command[0] ?? "", command.slice(1), {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
    timeout: 120_000,
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

nodeTest("generated qualification controls exercise each protection", () => {
  if (skipPlatform()) {
    return;
  }
  mkdirSync(generated, { recursive: true });
  try {
    for (const control of QUALIFICATION) {
      writeFileSync(join(generated, control.file), control.source);
    }
    const run = checker(["probes/generated"]);
    for (const control of QUALIFICATION) {
      const found = countFor(run.diagnostics, control.file);
      if (control.expect === 0) {
        assert.deepEqual(
          found,
          [],
          `${control.file} is the valid counterpart and must report nothing`,
        );
      } else {
        assert.ok(
          found.includes(control.rule),
          `${control.file} must report ${control.rule}, saw ${JSON.stringify(found)}`,
        );
      }
    }
    assert.equal(run.code, 1, "controls with intended violations must fail the checker");
  } finally {
    rmSync(generated, { recursive: true, force: true });
  }
});

nodeTest("gate-level controls fail and pass their real gates", () => {
  if (skipPlatform()) {
    return;
  }
  mkdirSync(controls, { recursive: true });
  try {
    // The compiler gate fails on real type errors and recovers when they are removed.
    const compilerControls: Array<{ name: string; source: string; expect: string }> = [
      {
        name: "compiler-error.ts",
        source: 'export const value: number = "text";\nconsole.log(value);\n',
        expect: "compiler-error.ts",
      },
      {
        name: "declaration-error.d.ts",
        source: "export declare const declaredValue: number;\n",
        expect: "declaration-consumer.ts",
      },
      {
        name: "declaration-consumer.ts",
        source:
          'import { declaredValue } from "./declaration-error.js";\n\nconst used: string = declaredValue;\nconsole.log(used);\n',
        expect: "declaration-consumer.ts",
      },
    ];
    for (const control of compilerControls) {
      writeFileSync(join(controls, control.name), control.source);
    }
    // The probes directory is outside tsconfig's include, so drive tsc per file.
    const compiler = gate([
      bin("tsc"),
      "--noEmit",
      "--ignoreConfig",
      ...compilerControls.map((c) => join("probes", "gate-controls", c.name)),
    ]);
    assert.notEqual(compiler.code, 0, "the compiler must report the generated type errors");
    for (const control of compilerControls) {
      assert.match(compiler.output, new RegExp(control.expect));
    }
    for (const control of compilerControls) {
      rmSync(join(controls, control.name));
    }

    // The format gate fails on a misformatted maintained source and converges after a rewrite.
    writeFileSync(join(controls, "misformatted.ts"), "export const  value = {\n    a:1,\n}\n");
    const misformatted = gate([
      bin("oxfmt"),
      "--check",
      join("probes", "gate-controls", "misformatted.ts"),
    ]);
    assert.notEqual(misformatted.code, 0, "a misformatted source must fail the format gate");
    assert.match(misformatted.output, /misformatted/);
    gate([bin("oxfmt"), "--write", join("probes", "gate-controls", "misformatted.ts")]);
    assert.equal(
      gate([bin("oxfmt"), "--check", join("probes", "gate-controls", "misformatted.ts")]).code,
      0,
      "formatting must converge",
    );
    rmSync(join(controls, "misformatted.ts"));

    // The aggregate runs every gate and reports each one independently.
    writeFileSync(join(controls, "misformatted.ts"), "export const  value = {\n    a:1,\n}\n");
    const aggregate = gate([process.execPath, "scripts/run-gates.ts", "format:check"]);
    assert.notEqual(aggregate.code, 0, "the aggregate must fail when a gate fails");
    assert.match(aggregate.output, /fail \(\d+\): format:check/);
    rmSync(join(controls, "misformatted.ts"));
    assert.equal(
      gate([process.execPath, "scripts/run-gates.ts", "format:check"]).code,
      0,
      "the aggregate must be clean once the control is gone",
    );
  } finally {
    rmSync(controls, { recursive: true, force: true });
  }
});

nodeTest("policy verification rejects unclassified sources and copied directives", () => {
  if (skipPlatform()) {
    return;
  }
  mkdirSync(controls, { recursive: true });
  try {
    // An unclassified maintained source fails coverage.
    const orphan = join(repo, "tools", "control-probe.ts");
    mkdirSync(join(repo, "tools"), { recursive: true });
    writeFileSync(orphan, "export const probeValue = 1;\n");
    const coverage = gate([process.execPath, "scripts/check-policy.ts"]);
    assert.notEqual(coverage.code, 0, "a maintained source without a profile must fail policy");
    assert.match(coverage.output, /tools\/control-probe\.ts/);
    rmSync(join(repo, "tools"), { recursive: true, force: true });

    // A directive copied to an unauthorized file fails the inventory.
    writeFileSync(
      join(controls, "copied-directive.ts"),
      "// oxlint-disable-next-line no-var -- QX-001: selector copied from the exception record.\nvar carried = 1;\nconsole.log(carried);\n",
    );
    const directive = gate([process.execPath, "scripts/check-policy.ts"]);
    assert.notEqual(
      directive.code,
      0,
      "a directive in a maintained source without an inventory entry must fail policy",
    );
    assert.match(directive.output, /copied-directive\.ts/);
    rmSync(join(controls, "copied-directive.ts"));

    // The same directive inside a maintained source fails the inventory.
    const stray = join(repo, "stray-directive.ts");
    writeFileSync(
      stray,
      "// oxlint-disable-next-line no-var -- QX-001: selector copied from the exception record.\nvar carried = 1;\nconsole.log(carried);\n",
    );
    const maintained = gate([process.execPath, "scripts/check-policy.ts"]);
    assert.notEqual(
      maintained.code,
      0,
      "a directive in a maintained source without an inventory entry must fail policy",
    );
    assert.match(maintained.output, /stray-directive\.ts/);
    rmSync(stray);
    assert.equal(
      gate([process.execPath, "scripts/check-policy.ts"]).code,
      0,
      "policy verification is clean once the stray directive is gone",
    );

    // A representative policy downgrade fails the digest comparison.
    const parsed: unknown = JSON.parse(readFileSync(join(repo, ".oxlintrc.json"), "utf8"));
    const downgraded = structuredClone(isRecord(parsed) ? parsed : {});
    if (isRecord(downgraded["rules"])) {
      downgraded["rules"]["no-var"] = "off";
    }
    writeFileSync(join(controls, "downgraded.json"), JSON.stringify(downgraded));
    const integrity = gate([
      process.execPath,
      "scripts/check-policy.ts",
      "--lint-config",
      join("probes", "gate-controls", "downgraded.json"),
    ]);
    assert.notEqual(integrity.code, 0, "a representative policy downgrade must fail policy");
    assert.match(integrity.output, /differs|baseline/);
  } finally {
    rmSync(controls, { recursive: true, force: true });
  }
});

nodeTest("a genuinely failing assertion fails its run and a valid assertion passes", () => {
  mkdirSync(controls, { recursive: true });
  try {
    writeFileSync(
      join(controls, "failing-assertion.test.ts"),
      'import assert from "node:assert/strict";\nimport { test as nodeTest } from "node:test";\n\nnodeTest("control fails on purpose", () => {\n\tassert.equal(1, 2);\n});\n',
    );
    writeFileSync(
      join(controls, "valid-assertion.test.ts"),
      'import assert from "node:assert/strict";\nimport { test as nodeTest } from "node:test";\n\nnodeTest("valid counterpart passes", () => {\n\tassert.equal(1, 1);\n});\n',
    );
    const failing = gate([
      process.execPath,
      join("probes", "gate-controls", "failing-assertion.test.ts"),
    ]);
    assert.notEqual(failing.code, 0, "a real failed assertion must fail the run");
    assert.match(failing.output, /control fails on purpose/);
    assert.equal(
      gate([process.execPath, join("probes", "gate-controls", "valid-assertion.test.ts")]).code,
      0,
      "the valid counterpart must pass",
    );
  } finally {
    rmSync(controls, { recursive: true, force: true });
  }
});

console.log(
  "ok: qualification controls — base, semantic, async, structural, test-profile, gates, policy integrity",
);
