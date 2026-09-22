import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const packageDir = process.env.PI_PACKAGE_DIR;
assert.ok(packageDir, "Fork PI_PACKAGE_DIR is required");
const { createAgentSession: createForkSession, DefaultResourceLoader: ForkResourceLoader,
  SessionManager: ForkSessionManager, SettingsManager: ForkSettingsManager } =
  await import(pathToFileURL(join(packageDir, "dist/index.js")).href) as typeof import("@earendil-works/pi-coding-agent");

const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-checkpoint-")));
const origin = join(root, "origin"), target = join(root, "target"), agentDir = join(root, "agent");
for (const path of [origin, target, agentDir]) mkdirSync(path);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
let session: Awaited<ReturnType<typeof createForkSession>>["session"] | undefined;

try {
  const settingsManager = ForkSettingsManager.inMemory();
  const loader = new ForkResourceLoader({
    cwd: origin, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(process.cwd(), "index.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createForkSession({
    cwd: origin, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: ForkSessionManager.inMemory(origin),
  }));
  await session.bindExtensions({ onError: (error) => assert.fail(error.error) });
  const runner = session.extensionRunner! as typeof session.extensionRunner & {
    prepareCheckpoint(event: { type: "session_checkpoint"; boundary: "settled"; signal: AbortSignal; invalidate(): void }): Promise<string[]>;
  };
  assert.equal(typeof runner.prepareCheckpoint, "function");
  const blockers = () => runner.prepareCheckpoint({
    type: "session_checkpoint", boundary: "settled", signal: new AbortController().signal, invalidate() {},
  });
  assert.deepEqual(await blockers(), []);

  const input = { path: target };
  const preflight = await runner.emitToolCall({ type: "tool_call", toolCallId: "checkpoint", toolName: "change_dir", input });
  assert.ok(!preflight?.block, preflight?.reason);
  await session.getToolDefinition("change_dir")!.execute("checkpoint", input, undefined, undefined, runner.createContext());
  assert.deepEqual(await blockers(), []);
  rmdirSync(target);
  assert.ok((await blockers()).some((reason) => reason.includes("Working directory differs from the selected branch restore")));
  console.log("ok: fork checkpoint accepts saved cwd and blocks unavailable cwd");
} finally {
  session?.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
