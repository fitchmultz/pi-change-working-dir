/** Native CLI Bash integration: PI_PACKAGE_DIR=/path/to/pi/packages/coding-agent node test-bash.ts */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { BashOperations, ExtensionFactory } from "@earendil-works/pi-coding-agent";

type OutputCallbacks = {
  onData: (data: Buffer, source: "stdout" | "stderr") => void;
  onEnd?: (source: "stdout" | "stderr") => void;
};

const host = await import(process.env.PI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
  : "@earendil-works/pi-coding-agent") as typeof import("@earendil-works/pi-coding-agent");
const {
  createAgentSession, createBashToolDefinition, createLocalBashOperations, defineTool, DefaultResourceLoader, SessionManager, SettingsManager,
} = host;
const backgroundFactory = (host as { createBackgroundCommandExtension?: () => ExtensionFactory }).createBackgroundCommandExtension;

const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-bash-")));
const origin = join(root, "origin");
const target = join(root, "worktree's directory");
const alternate = join(root, "alternate");
const agentDir = join(root, "agent");
for (const dir of [origin, target, alternate, agentDir]) mkdirSync(dir);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Bash integration tests must not make network requests"); };
const shellPath = join(root, "configured-shell");
writeFileSync(shellPath, '#!/bin/sh\nexport CWD_TEST_SHELL=kept\nexec /bin/bash "$@"\n', { mode: 0o700 });
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath, shellCommandPrefix: "export CWD_TEST_PREFIX=global" }));
mkdirSync(join(origin, ".pi"));
const projectSettings = join(origin, ".pi", "settings.json");
const savePrefix = (label: string) => writeFileSync(projectSettings, JSON.stringify({
  shellCommandPrefix: `export CWD_TEST_PREFIX="${label}:$(pwd -P)"`,
}));
savePrefix("project");
const settingsManager = SettingsManager.create(origin, agentDir);
let userOperations: BashOperations | undefined;
const loaderOptions = {
  cwd: origin, agentDir, settingsManager,
  additionalExtensionPaths: [join(process.cwd(), "index.ts")],
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
};
const loader = new DefaultResourceLoader({
  ...loaderOptions,
  extensionFactories: [(pi) => {
    pi.on("user_bash", () => userOperations ? { operations: userOperations } : undefined);
  }, ...(backgroundFactory ? [backgroundFactory()] : [])],
});

try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  console.log("Bash cwd routing: public native factory and user_bash operations");
  const sessionManager = SessionManager.create(origin, join(root, "sessions"));
  const { session } = await createAgentSession({
    cwd: origin, agentDir, settingsManager, sessionManager, resourceLoader: loader,
  });
  try {
    await session.bindExtensions({ onError: (error) => assert.fail(error.error) });
    const execute = async (toolName: string, input: Record<string, unknown>) => {
      const originalCommand = input.command;
      const result = await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "test", toolName, input });
      assert.ok(!result?.block, result?.reason);
      if (toolName === "bash") assert.equal(input.command, originalCommand, "native routing needs no cd prefix");
      const tool = session.agent.state.tools.find((tool) => tool.name === toolName);
      assert.ok(tool, `${toolName} is active`);
      const output = await tool.execute("test", input);
      return output.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    };
    const command = 'printf "%s\\n" "$PWD" "$CWD_TEST_SHELL" "$CWD_TEST_PREFIX" "$PI_SESSION_ID"';
    assert.equal(await execute("bash", { command }), `${origin}\nkept\nproject:${origin}\n${session.sessionId}`);
    await execute("change_dir", { path: target });
    assert.equal(await execute("bash", { command }), `${target}\nkept\nproject:${target}\n${session.sessionId}`);
    if (backgroundFactory) {
      const job = JSON.parse(await execute("background_command", { action: "start", command: "sleep 0.1; pwd -P", timeout: 5 })) as {
        id: string; cwd: string; status: string; logFile: string; exitCode?: number;
      };
      try {
        assert.equal(job.cwd, target, "the real background caller captures the selected directory");
        await execute("change_dir", { path: alternate });
        for (let attempt = 0; attempt < 100 && ["starting", "running"].includes(job.status); attempt++) {
          await delay(20);
          Object.assign(job, JSON.parse(await execute("background_command", { action: "status", id: job.id })));
        }
        assert.equal(job.status, "succeeded");
        assert.equal(job.exitCode, 0);
        assert.equal(readFileSync(job.logFile, "utf8").trim(), target, "the real child executes in the captured directory after selection changes");
      } finally {
        const cancelled = JSON.parse(await execute("background_command", { action: "cancel", id: job.id }));
        assert.ok(!["starting", "running"].includes(cancelled.status), "the owned job is terminal before fixture cleanup");
        await execute("change_dir", { path: target });
      }
      console.log("ok: real host background child captures selected cwd and completes without a leaked job");
    } else {
      console.log("Background selected-cwd proof unattempted: the selected host does not export its background_command factory.");
    }

    // Reload refreshes file settings and restores the branch's selected cwd.
    savePrefix("reloaded");
    await session.reload();
    assert.equal(await execute("bash", { command }), `${target}\nkept\nreloaded:${target}\n${session.sessionId}`);
    const definition = session.getToolDefinition("bash");
    const source = session.getAllTools().find((tool) => tool.name === "bash")!.sourceInfo;
    assert.equal(source.path, join(process.cwd(), "index.ts"), "default Bash uses a snapshot-aware native factory wrapper");
    rmSync(join(origin, ".pi"), { recursive: true });
    rmdirSync(origin);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await execute("change_dir", { path: target });
      assert.equal(await execute("bash", { command }), `${target}\nkept\nreloaded:${target}\n${session.sessionId}`);
    }
    assert.equal(session.getToolDefinition("bash"), definition);
    assert.equal(sessionManager.getCwd(), origin);
    assert.equal(existsSync(origin), false);

    // Native streaming/cancellation and exit errors still work after origin removal.
    const bash = session.agent.state.tools.find((tool) => tool.name === "bash")!;
    const controller = new AbortController();
    await assert.rejects(() => bash.execute("cancel", { command: "printf ready; sleep 30", timeout: 5 }, controller.signal, (update) => {
      if (update.content.some((block) => block.type === "text" && block.text.includes("ready"))) controller.abort();
    }), /ready[\s\S]*Command aborted/);
    const failed = await bash.execute("exit", { command: "printf stdout; printf stderr >&2; exit 7" });
    assert.equal(failed.isError, true);
    const failedText = failed.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    assert.match(failedText, /stdout/);
    assert.match(failedText, /stderr/);
    assert.match(failedText, /Command exited with code 7/);
    assert.partialDeepStrictEqual(failed.structuredContent, { exit_code: 7, truncated: false });

    // Public user_bash keeps first-handler ordering; later custom operations do not replace it.
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
    assert.equal(await runUserBash(), `${target}\nkept\nreloaded:${target}`);
    let customCalls = 0;
    const local = createLocalBashOperations({ shellPath });
    userOperations = {
      exec(command, cwd, options) {
        customCalls += 1;
        assert.equal(cwd, target);
        return local.exec(command, cwd, options);
      },
    };
    assert.equal(await runUserBash(), `${target}\nkept\nreloaded:${target}`);
    assert.equal(customCalls, 0);
    userOperations = undefined;

    // A missing effective cwd still fails; changing to an existing directory recovers.
    rmdirSync(target);
    await assert.rejects(() => execute("bash", { command: "pwd -P" }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(target), error.message);
      return true;
    });
    await assert.rejects(
      () => execute("write", { path: "result.txt", content: "must not recreate the worktree" }),
      /Working directory unavailable/,
    );
    assert.equal(existsSync(target), false);
    await execute("change_dir", { path: alternate });
    assert.equal(await execute("bash", { command }), `${alternate}\nkept\nreloaded:${alternate}\n${session.sessionId}`);
    assert.equal(await runUserBash(), `${alternate}\nkept\nreloaded:${alternate}`);

    console.log("ok: native CLI Bash preserves file settings/reload, deleted-origin routing, streaming/abort, user Bash and cwd recovery");
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }

  // Already configured extension and SDK customTools executors must never be replaced.
  for (const owner of ["extension", "sdk"] as const) {
    let calls = 0;
    const custom = defineTool(createBashToolDefinition(alternate, {
      operations: { async exec(command, _cwd, { onData, onEnd }: OutputCallbacks) {
        calls++;
        onData(Buffer.from(command), "stdout");
        onEnd?.("stdout");
        onEnd?.("stderr");
        return { exitCode: 0 };
      } },
    }));
    const customUser: BashOperations = {
      async exec(_command, cwd, { onData, onEnd }: OutputCallbacks) {
        assert.equal(cwd, alternate);
        onData(Buffer.from("custom-user"), "stdout");
        onEnd?.("stdout");
        onEnd?.("stderr");
        return { exitCode: 0 };
      },
    };
    const customLoader = new DefaultResourceLoader({
      ...loaderOptions, cwd: alternate,
      extensionFactories: [(pi) => {
        if (owner === "extension") pi.registerTool(custom);
        pi.on("user_bash", () => ({ operations: customUser }));
      }],
      // Put the custom executor first, before CWD's first-handler-wins user fallback.
      extensionsOverride: (loaded) => ({ ...loaded, extensions: [...loaded.extensions].reverse() }),
    });
    await customLoader.reload();
    assert.deepEqual(customLoader.getExtensions().errors, []);
    const { session } = await createAgentSession({
      cwd: alternate, agentDir, settingsManager, resourceLoader: customLoader,
      sessionManager: SessionManager.inMemory(alternate),
      customTools: owner === "sdk" ? [custom] : undefined,
    });
    try {
      await session.bindExtensions({ onError: (error) => assert.fail(error.error) });
      assert.equal(session.getToolDefinition("bash"), custom);
      await session.agent.state.tools.find((tool) => tool.name === "change_dir")!.execute("change", { path: root });
      const input = { command: "custom-owned" };
      await session.extensionRunner.emitToolCall({ type: "tool_call", toolCallId: "custom", toolName: "bash", input });
      assert.equal(input.command, "custom-owned", "custom executors own their operation-directory integration");
      const result = await session.agent.state.tools.find((tool) => tool.name === "bash")!.execute("custom", input);
      assert.equal(result.content[0]?.type === "text" && result.content[0].text, input.command);
      assert.equal(calls, 1);
      const selected = await session.extensionRunner.emitUserBash({ type: "user_bash", command: "custom-user", cwd: alternate, excludeFromContext: true });
      assert.equal(selected?.operations, customUser);
      assert.equal((await session.executeBash("custom-user", undefined, { operations: selected?.operations, excludeFromContext: true })).output, "custom-user");
      assert.equal(session.getToolDefinition("bash"), custom);
      console.log(`ok: ${owner}-owned Bash and earlier user executor retained`);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  }
  // Selecting another directory must not grant trust to either project's settings.
  const untrustedOrigin = join(root, "untrusted-origin");
  for (const directory of [untrustedOrigin, alternate]) mkdirSync(join(directory, ".pi"), { recursive: true });
  writeFileSync(join(untrustedOrigin, ".pi/settings.json"), JSON.stringify({ shellCommandPrefix: "export CWD_TEST_PREFIX=UNTRUSTED_ORIGIN" }));
  writeFileSync(join(alternate, ".pi/settings.json"), JSON.stringify({ shellCommandPrefix: "export CWD_TEST_PREFIX=SELECTED_PROJECT" }));
  const untrustedSettings = SettingsManager.create(untrustedOrigin, agentDir, { projectTrusted: false });
  const untrustedLoader = new DefaultResourceLoader({ ...loaderOptions, cwd: untrustedOrigin, settingsManager: untrustedSettings });
  await untrustedLoader.reload({ resolveProjectTrust: async () => false });
  assert.deepEqual(untrustedLoader.getExtensions().errors, []);
  const untrusted = await createAgentSession({ cwd: untrustedOrigin, agentDir, settingsManager: untrustedSettings,
    resourceLoader: untrustedLoader, sessionManager: SessionManager.inMemory(untrustedOrigin) });
  try {
    await untrusted.session.bindExtensions({ mode: "print", onError: error => assert.fail(error.error) });
    const context = untrusted.session.extensionRunner!.createToolContext("trust", undefined);
    await untrusted.session.getToolDefinition("change_dir")!.execute("select", { path: alternate }, undefined, undefined, context);
    const result = await untrusted.session.getToolDefinition("bash")!.execute("trust",
      { command: 'printf "%s\\n" "$PWD" "$CWD_TEST_PREFIX"' }, undefined, undefined, context);
    assert.equal(result.content[0]?.type === "text" && result.content[0].text.trim(), `${alternate}\nglobal`);
    assert.equal(context.isProjectTrusted(), false);
  } finally { untrusted.session.dispose(); }
} finally {
  globalThis.fetch = previousFetch;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
