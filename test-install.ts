import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "cwd-install-"));
const agentDir = join(root, "agent");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;

try {
  const { name } = JSON.parse(readFileSync("package.json", "utf8")) as { name: string };
  const [{ filename }] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", root], { encoding: "utf8" })) as Array<{ filename: string }>;
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  mkdirSync(agentDir);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, dependencies: { [name]: `file:${join(root, filename)}` } }));
  execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: consumer });

  const installed = join(consumer, "node_modules", name);
  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { pi?: { extensions?: string[] } };
  assert.deepEqual(manifest.pi?.extensions, ["./index.ts"]);
  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: consumer, agentDir, settingsManager, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(installed, manifest.pi.extensions[0])],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd: consumer, agentDir, settingsManager, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(consumer),
  }));
  await session.bindExtensions({ onError: (error) => assert.fail(error.error) });
  assert.ok(session.getToolDefinition("change_dir"));
  console.log("ok: packed consumer loads the extension and registers change_dir");
} finally {
  session?.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
