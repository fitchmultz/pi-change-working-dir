/** Native preview and replay stay on the admitted file. No terminal or provider required. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { host, distDir, importModule } from "./test-host.ts";
import type * as AnsiModule from "./node_modules/@earendil-works/pi-coding-agent/dist/utils/ansi.js";
import type * as ThemeModule from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type * as ToolExecutionModule from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  withFileMutationQueue,
} = host;
const { ToolExecutionComponent } = await importModule<typeof ToolExecutionModule>(
  pathToFileURL(join(distDir, "modes/interactive/components/tool-execution.js")).href,
);
const { initTheme } = await importModule<typeof ThemeModule>(
  pathToFileURL(join(distDir, "modes/interactive/theme/theme.js")).href,
);
const { stripAnsi } = await importModule<typeof AnsiModule>(
  pathToFileURL(join(distDir, "utils/ansi.js")).href,
);
const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-render-")));
const a = join(root, "a"),
  b = join(root, process.platform === "win32" ? "b" : "b\\literal\u00a0directory"),
  agentDir = join(root, "agent");
for (const path of [a, b, agentDir]) {
  mkdirSync(path);
}
const beforeA = "A_ONLY_CONTEXT\nold text\nA_ONLY_TAIL\n";
const beforeB = "B_ONLY_CONTEXT\nold text\nB_ONLY_TAIL\n";
const seedFiles: ReadonlyArray<[path: string, content: string]> = [
  [a, beforeA],
  [b, beforeB],
];
for (const [path, content] of seedFiles) {
  writeFileSync(join(path, "same.txt"), content);
}
mkdirSync(join(b, "actual/nested"), { recursive: true });
symlinkSync(
  join(b, "actual/nested"),
  join(b, "link"),
  process.platform === "win32" ? "junction" : "dir",
);
const fileName = "same\u00a0$$$&$'$`.txt";
const asciiName = fileName.replace("\u00a0", " ");
const requested = `link${sep}..${sep}${fileName}`;
const addressed = `${b}${sep}${requested}`;
const physicalFile = join(realpathSync.native(`${b}${sep}link${sep}..`), fileName);
mkdirSync(join(a, "link"));
writeFileSync(join(a, asciiName), beforeA);
writeFileSync(join(a, fileName), beforeA);
writeFileSync(join(b, fileName), beforeA);
writeFileSync(join(b, "actual", asciiName), beforeA);
writeFileSync(physicalFile, beforeB);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({
  cwd: a,
  agentDir,
  settingsManager,
  noExtensions: true,
  additionalExtensionPaths: [join(process.cwd(), "index.ts")],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({
  cwd: a,
  agentDir,
  settingsManager,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(a),
});
let release: (() => void) | undefined;
/** White-box view of the component's private preview pipeline; no public accessor exists. */
type PreviewPipeline = { rendererState: { callComponent?: { preview?: { error?: string } } } };
const previewError = (
  component: InstanceType<typeof ToolExecutionComponent>,
): string | undefined => {
  // oxlint-disable-next-line no-unsafe-type-assertion -- QX-005: the preview pipeline is private.
  const state = component as unknown as PreviewPipeline;
  return state.rendererState.callComponent?.preview?.error;
};
try {
  await session.bindExtensions({ onError: (error) => assert.fail(error.error) });
  // oxlint-disable-next-line no-useless-undefined -- QX-003: signal is a required `AbortSignal | undefined` parameter.
  const ctx = session.extensionRunner.createToolContext("test", undefined);
  const changeDirDef = session.getToolDefinition("change_dir");
  assert.ok(changeDirDef, "change_dir is registered");
  await changeDirDef.execute("cwd", { path: b }, undefined, undefined, ctx);
  const definition = session.getToolDefinition("edit");
  assert.ok(definition, "edit is registered");
  initTheme("dark");
  const args = { path: requested, edits: [{ oldText: "old text", newText: "new text" }] };
  type Ui = ConstructorParameters<typeof ToolExecutionComponent>[5];
  const uiStub = {
    // oxlint-disable-next-line no-empty-function -- QX-006: the component only needs the hook to exist.
    requestRender() {},
  };
  // oxlint-disable-next-line no-unsafe-type-assertion -- QX-005: rendering-only stub of the wide TUI parameter.
  const ui: Ui = uiStub as Ui;
  const component = new ToolExecutionComponent("edit", "edit-preview", args, {}, definition, ui, a);
  component.setArgsComplete();
  const render = (value: InstanceType<typeof ToolExecutionComponent>): string =>
    stripAnsi(value.render(120).join("\n"));
  await delay(20);
  assert.doesNotMatch(
    render(component),
    /A_ONLY_CONTEXT/,
    "unadmitted arguments must not read the session-root file",
  );

  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lock = withFileMutationQueue(physicalFile, async () => {
    locked();
    await hold;
  });
  await ready;
  const input = structuredClone(args);
  await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "edit",
    toolCallId: "edit-preview",
    input,
  });
  assert.equal(input.path, process.platform === "win32" ? join(b, requested) : addressed);
  component.markExecutionStarted();
  const executing = definition.execute("edit-preview", input, undefined, undefined, ctx);
  for (let attempt = 0; attempt < 200 && !render(component).includes("B_ONLY_CONTEXT"); attempt++) {
    await delay(5);
  }
  assert.match(render(component), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(component), /A_ONLY_CONTEXT/);
  assert.doesNotMatch(
    render(component),
    /file:\/\//,
    "render native path labels rather than delegated URLs",
  );
  assert.ok(release !== undefined, "the lock release exists");
  release();
  await lock;
  const result = await executing;
  assert.equal(readFileSync(join(a, "same.txt"), "utf8"), beforeA);
  assert.equal(readFileSync(physicalFile, "utf8"), beforeB.replace("old text", "new text"));
  assert.equal(readFileSync(join(b, "actual", asciiName), "utf8"), beforeA);
  const invocationDetails = result.details;
  if (
    typeof invocationDetails !== "object" ||
    invocationDetails === null ||
    !("workingPath" in invocationDetails) ||
    typeof invocationDetails.workingPath !== "string"
  ) {
    assert.fail("edit details carry workingPath");
  }
  assert.equal(
    invocationDetails.workingPath,
    input.path,
    "invocation metadata retains the addressed path",
  );
  component.updateResult({ ...result, isError: false });
  assert.match(render(component), /B_ONLY_CONTEXT/);
  const replay = new ToolExecutionComponent("edit", "edit-preview", args, {}, definition, ui, a);
  replay.updateResult({ ...result, isError: false });
  assert.match(render(replay), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(replay), /A_ONLY_CONTEXT/);
  const legacy = new ToolExecutionComponent("edit", "legacy-replay", args, {}, definition, ui, a);
  legacy.updateResult({
    ...result,
    details: { ...invocationDetails, workingTarget: undefined, workingPath: physicalFile },
    isError: false,
  });
  assert.match(render(legacy), /B_ONLY_CONTEXT/);
  assert.doesNotMatch(render(legacy), /A_ONLY_CONTEXT/);
  writeFileSync(physicalFile, "repeat\nrepeat\n");
  for (const oldText of ["missing", "repeat"]) {
    const failedArgs = { path: requested, edits: [{ oldText, newText: "new" }] };
    const failed = new ToolExecutionComponent(
      "edit",
      `failed-${oldText}`,
      failedArgs,
      {},
      definition,
      ui,
      a,
    );
    failed.setArgsComplete();
    const failedInput = structuredClone(failedArgs);
    await session.extensionRunner.emitToolCall({
      type: "tool_call",
      toolName: "edit",
      toolCallId: `failed-${oldText}`,
      input: failedInput,
    });
    failed.markExecutionStarted();
    await assert.rejects(
      () => definition.execute(`failed-${oldText}`, failedInput, undefined, undefined, ctx),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(physicalFile), error.message);
        failed.updateResult({
          content: [{ type: "text", text: error.message }],
          details: undefined,
          isError: true,
        });
        return true;
      },
    );
    for (let attempt = 0; attempt < 200 && previewError(failed) === undefined; attempt++) {
      await delay(5);
    }
    const preview = previewError(failed);
    assert.ok(preview !== undefined, "native failed preview completed");
    assert.ok(preview.includes(physicalFile), preview);
    const output = render(failed);
    assert.doesNotMatch(output, /file:\/\//);
    assert.equal(
      (output.match(/Could not find the exact text|Found 2 occurrences/g) ?? []).length,
      1,
      "native preview/result error deduplication remains intact",
    );
  }
  const writeArgs = { path: "preview-only/new.txt", content: "NEW" };
  const writeDef = session.getToolDefinition("write");
  assert.ok(writeDef, "write is registered");
  const writeComponent = new ToolExecutionComponent(
    "write",
    "write-preview",
    writeArgs,
    {},
    writeDef,
    ui,
    a,
  );
  writeComponent.setArgsComplete();
  await session.extensionRunner.emitToolCall({
    type: "tool_call",
    toolName: "write",
    toolCallId: "write-preview",
    input: structuredClone(writeArgs),
  });
  render(writeComponent);
  await delay(20);
  assert.ok(!existsSync(join(b, "preview-only")), "admission/rendering never create write parents");
  console.log(
    "ok: native traversal/Unicode previews, queued execution, replay metadata and non-mutating write rendering",
  );
} finally {
  release?.();
  session.dispose();
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  rmSync(root, { recursive: true, force: true });
}
