/** Native Bash integration: PI_PACKAGE_DIR=/path/to/pi/packages/coding-agent npm run test:bash */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";

const {
  createAgentSession, createLocalBashOperations, DefaultResourceLoader, SessionManager, SettingsManager,
} = await import(process.env.PI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
  : "@earendil-works/pi-coding-agent") as typeof import("@earendil-works/pi-coding-agent");

const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-bash-")));
const origin = join(root, "origin");
const target = join(root, "worktree's directory");
const alternate = join(root, "alternate");
const agentDir = join(root, "agent");
for (const dir of [origin, target, alternate, agentDir]) mkdirSync(dir);
const shellPath = join(root, "configured-shell");
writeFileSync(shellPath, '#!/bin/sh\nexport CWD_TEST_SHELL=kept\nexec /bin/bash "$@"\n', { mode: 0o700 });
const settingsManager = SettingsManager.inMemory({
  shellPath,
  shellCommandPrefix: 'export CWD_TEST_PREFIX="$(pwd -P)"',
});
let userOperations: BashOperations | undefined;
const loader = new DefaultResourceLoader({
  cwd: origin,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [join(process.cwd(), "index.ts")],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [(pi) => {
    pi.on("user_bash", () => userOperations ? { operations: userOperations } : undefined);
  }],
});

try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const sessionManager = SessionManager.inMemory(origin);
  const { session } = await createAgentSession({
    cwd: origin, agentDir, settingsManager, sessionManager, resourceLoader: loader,
  });
  try {
    await session.bindExtensions({});
    const definition = session.getToolDefinition("bash");
    const execute = async (toolName: string, input: Record<string, unknown>) => {
      const result = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "test", toolName, input });
      assert.ok(!result?.block, result?.reason);
      const tool = session.agent.state.tools.find((tool) => tool.name === toolName);
      assert.ok(tool, `${toolName} is active`);
      const output = await tool.execute("test", input);
      return output.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    };
    const command = 'printf "%s\\n" "$PWD" "$CWD_TEST_SHELL" "$CWD_TEST_PREFIX" "$PI_SESSION_ID"';
    assert.equal(await execute("bash", { command }), `${origin}\nkept\n${origin}\n${session.sessionId}`);
    await execute("change_dir", { path: target });
    rmdirSync(origin);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await execute("change_dir", { path: target });
      assert.equal(await execute("bash", { command }), `${target}\nkept\n${target}\n${session.sessionId}`);
    }
    assert.equal(session.getToolDefinition("bash"), definition);
    assert.equal(session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source, "builtin");
    assert.equal(sessionManager.getCwd(), origin);

    // Native user Bash retains the configured shell and any selected custom operations.
    const userCommand = 'printf "%s\\n" "$PWD" "$CWD_TEST_SHELL" "$CWD_TEST_PREFIX"';
    const runUserBash = async () => {
      const selected = await session.extensionRunner.emitUserBash({
        type: "user_bash", command: userCommand, cwd: origin, excludeFromContext: true,
      });
      assert.ok(!selected?.result);
      return (await session.executeBash(userCommand, undefined, {
        excludeFromContext: true, operations: selected?.operations,
      })).output.trim();
    };
    assert.equal(await runUserBash(), `${target}\nkept\n${target}`);
    let customCalls = 0;
    const local = createLocalBashOperations({ shellPath });
    userOperations = {
      exec(command, cwd, options) {
        customCalls += 1;
        assert.equal(cwd, target);
        return local.exec(command, cwd, options);
      },
    };
    assert.equal(await runUserBash(), `${target}\nkept\n${target}`);
    assert.equal(customCalls, 1);
    userOperations = undefined;

    // A missing effective cwd still fails; changing to another existing directory recovers.
    rmdirSync(target);
    await assert.rejects(() => execute("bash", { command: "pwd -P" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(target), error.message);
      return true;
    });
    await execute("change_dir", { path: alternate });
    assert.equal(await execute("bash", { command }), `${alternate}\nkept\n${alternate}\n${session.sessionId}`);
    assert.equal(await runUserBash(), `${alternate}\nkept\n${alternate}`);
    console.log("ok: native Bash survives deleted origin; shell, prefix, environment, user operations, and missing-cwd checks preserved");
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
