/** Native preview and replay stay on the admitted file. No terminal or provider required. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
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
mkdirSync(join(b, "actual/nested"), { recursive: true });
symlinkSync(join(b, "actual/nested"), join(b, "link"), process.platform === "win32" ? "junction" : "dir");
const requested = `link${sep}..${sep}same\u00a0.txt`;
const addressed = `${b}${sep}${requested}`;
const physicalFile = join(realpathSync.native(`${b}${sep}link${sep}..`), "same\u00a0.txt");
mkdirSync(join(a, "link"));
writeFileSync(join(a, "same .txt"), beforeA);
writeFileSync(join(a, "same\u00a0.txt"), beforeA);
writeFileSync(join(b, "same\u00a0.txt"), beforeA);
writeFileSync(join(b, "actual/same .txt"), beforeA);
writeFileSync(physicalFile, beforeB);
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
  const args = { path: requested, edits: [{ oldText: "old text", newText: "new text" }] };
  const ui = { requestRender() {} };
  const component = new ToolExecutionComponent("edit", "edit-preview", args, {}, definition, ui, a);
  component.setArgsComplete();
  const render = (value: InstanceType<typeof ToolExecutionComponent>): string => stripAnsi(value.render(120).join("\n"));
  await delay(20);
  assert.doesNotMatch(render(component), /A_ONLY_CONTEXT/, "unadmitted arguments must not read the session-root file");

  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const lock = withFileMutationQueue(physicalFile, async () => { locked(); await hold; });
  await ready;
  const input = structuredClone(args);
  await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "edit", toolCallId: "edit-preview", input });
  assert.equal(input.path, process.platform === "win32" ? join(b, requested) : addressed);
  component.markExecutionStarted();
  const executing = definition.execute("edit-preview", input, undefined, undefined, ctx);
  for (let attempt = 0; attempt < 200 && !render(component).includes("B_ONLY_CONTEXT"); attempt++) await delay(5);
  assert.match(render(component), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(component), /A_ONLY_CONTEXT/);
  assert.doesNotMatch(render(component), /file:\/\//, "render native path labels rather than delegated URLs");
  release();
  await lock;
  const result = await executing;
  assert.equal(readFileSync(join(a, "same.txt"), "utf8"), beforeA);
  assert.equal(readFileSync(physicalFile, "utf8"), beforeB.replace("old text", "new text"));
  assert.equal(readFileSync(join(b, "actual/same .txt"), "utf8"), beforeA);
  assert.equal((result.details as { workingPath: string }).workingPath, input.path, "invocation metadata retains the addressed path");
  component.updateResult({ ...result, isError: false });
  assert.match(render(component), /B_ONLY_CONTEXT/);
  const replay = new ToolExecutionComponent("edit", "edit-preview", args, {}, definition, ui, a);
  replay.updateResult({ ...result, isError: false });
  assert.match(render(replay), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(replay), /A_ONLY_CONTEXT/);
  const legacy = new ToolExecutionComponent("edit", "legacy-replay", args, {}, definition, ui, a);
  legacy.updateResult({ ...result, details: { ...result.details as object, workingTarget: undefined, workingPath: physicalFile }, isError: false });
  assert.match(render(legacy), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(legacy), /A_ONLY_CONTEXT/);
  writeFileSync(physicalFile, "repeat\nrepeat\n");
  for (const oldText of ["missing", "repeat"]) {
    const failedArgs = { path: requested, edits: [{ oldText, newText: "new" }] };
    const failed = new ToolExecutionComponent("edit", `failed-${oldText}`, failedArgs, {}, definition, ui, a);
    failed.setArgsComplete();
    const input = structuredClone(failedArgs);
    await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "edit", toolCallId: `failed-${oldText}`, input });
    failed.markExecutionStarted();
    await assert.rejects(() => definition.execute(`failed-${oldText}`, input, undefined, undefined, ctx), error => {
      assert.ok(error instanceof Error);
      failed.updateResult({ content: [{ type: "text", text: error.message }], details: undefined, isError: true });
      return true;
    });
    for (let attempt = 0; attempt < 200 && !failed.rendererState.callComponent?.preview?.error; attempt++) await delay(5);
    assert.ok(failed.rendererState.callComponent?.preview?.error, "native failed preview completed");
    const output = render(failed);
    assert.doesNotMatch(output, /file:\/\//);
    assert.equal((output.match(/Could not find the exact text|Found 2 occurrences/g) ?? []).length, 1,
      "native preview/result error deduplication remains intact");
  }
  const writeArgs = { path: "preview-only/new.txt", content: "NEW" };
  const writeComponent = new ToolExecutionComponent("write", "write-preview", writeArgs, {}, session.getToolDefinition("write")!, ui, a);
  writeComponent.setArgsComplete();
  await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: "write-preview", input: structuredClone(writeArgs) });
  render(writeComponent);
  await delay(20);
  assert.ok(!existsSync(join(b, "preview-only")), "admission/rendering never create write parents");
  console.log("ok: native traversal/Unicode previews, queued execution, replay metadata and non-mutating write rendering");
} finally {
  release?.();
  session.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
