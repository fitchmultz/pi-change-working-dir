/** Native preview and replay stay on the admitted file. No terminal or provider required. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = process.env.PI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const dist = dirname(fileURLToPath(entry));
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, withFileMutationQueue } = await import(entry) as typeof import("@earendil-works/pi-coding-agent");
const { ToolExecutionComponent } = await import(pathToFileURL(join(dist, "modes/interactive/components/tool-execution.js")).href);
const { initTheme } = await import(pathToFileURL(join(dist, "modes/interactive/theme/theme.js")).href);
const { stripAnsi } = await import(pathToFileURL(join(dist, "utils/ansi.js")).href);
const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-render-")));
const a = join(root, "a"), b = join(root, process.platform === "win32" ? "b" : "b\\literal\u00a0directory"), agentDir = join(root, "agent");
for (const path of [a, b, agentDir]) mkdirSync(path);
const beforeA = "A_ONLY_CONTEXT\nold text\nA_ONLY_TAIL\n";
const beforeB = "B_ONLY_CONTEXT\nold text\nB_ONLY_TAIL\n";
for (const [path, content] of [[a, beforeA], [b, beforeB]]) writeFileSync(join(path!, "same.txt"), content!);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd: a, agentDir, settingsManager, noExtensions: true,
  additionalExtensionPaths: [join(process.cwd(), "index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd: a, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(a) });
let release!: () => void;
try {
  await session.bindExtensions({ onError: error => assert.fail(error.error) });
  const ctx = session.extensionRunner!.createContext();
  await session.getToolDefinition("change_dir")!.execute("cwd", { path: b }, undefined, undefined, ctx);
  const definition = session.getToolDefinition("edit")!;
  initTheme("dark");
  const args = { path: "same.txt", edits: [{ oldText: "old text", newText: "new text" }] };
  const ui = { requestRender() {} };
  const component = new ToolExecutionComponent("edit", "edit-preview", args, {}, definition, ui, a);
  component.setArgsComplete();
  const render = (value: InstanceType<typeof ToolExecutionComponent>): string => stripAnsi(value.render(120).join("\n"));
  await delay(20);
  assert.doesNotMatch(render(component), /A_ONLY_CONTEXT/, "unadmitted arguments must not read the session-root file");

  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const lock = withFileMutationQueue(join(b, "same.txt"), async () => { locked(); await hold; });
  await ready;
  const input = structuredClone(args);
  await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "edit", toolCallId: "edit-preview", input });
  assert.equal(input.path, join(b, "same.txt"));
  component.markExecutionStarted();
  const executing = definition.execute("edit-preview", input, undefined, undefined, ctx);
  for (let attempt = 0; attempt < 200 && !render(component).includes("B_ONLY_CONTEXT"); attempt++) await delay(5);
  assert.match(render(component), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(component), /A_ONLY_CONTEXT/);
  release();
  await lock;
  const result = await executing;
  assert.equal(readFileSync(join(a, "same.txt"), "utf8"), beforeA);
  assert.equal(readFileSync(join(b, "same.txt"), "utf8"), beforeB.replace("old text", "new text"));
  component.updateResult({ ...result, isError: false });
  assert.match(render(component), /B_ONLY_CONTEXT/);
  const replay = new ToolExecutionComponent("edit", "edit-preview", args, {}, definition, ui, a);
  replay.updateResult({ ...result, isError: false });
  assert.match(render(replay), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(replay), /A_ONLY_CONTEXT/);
  console.log("ok: speculative previews wait for admitted paths; queued execution and replay use the same literal directory");
} finally {
  release?.();
  session.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
