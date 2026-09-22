/** Real native filesystem and host-factory comparisons; no provider calls. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep, toNamespacedPath } from "node:path";
import { pathToFileURL } from "node:url";

const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(process.env.PI_PACKAGE_DIR
  ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
  : "@earendil-works/pi-coding-agent") as typeof import("@earendil-works/pi-coding-agent");

const root = realpathSync(mkdtempSync(join(tmpdir(), "cwd-paths-")));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
mkdirSync(join(root, "actual/nested"), { recursive: true });
symlinkSync(join(root, "actual/nested"), join(root, "link"), process.platform === "win32" ? "junction" : "dir");
writeFileSync(join(root, "file.txt"), "LEXICAL\n");
writeFileSync(join(root, "actual/file.txt"), "PHYSICAL\n");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const settingsManager = SettingsManager.inMemory();
const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true,
  additionalExtensionPaths: [join(process.cwd(), "index.ts")], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd: root, agentDir, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(root) });

async function admit(name: string, input: Record<string, unknown>, id = name) {
  const blocked = await session.extensionRunner!.emitToolCall({ type: "tool_call", toolName: name, toolCallId: id, input });
  assert.ok(!blocked?.block, blocked?.reason);
  return input;
}
async function execute(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
  return session.getToolDefinition(name)!.execute(name, await admit(name, input), signal, undefined, session.extensionRunner!.createContext());
}
const text = (result: Awaited<ReturnType<typeof execute>>) => result.content.filter(b => b.type === "text").map(b => b.text).join("\n").trimEnd();
const addressed = (suffix: string) => `${root}${sep}${suffix}`;

try {
  await session.bindExtensions({ onError: error => assert.fail(error.error) });
  // The native OS is the oracle: DOS dot traversal differs from POSIX traversal.
  const traversal = `link${sep}..${sep}file.txt`;
  const physical = readFileSync(addressed(traversal), "utf8");
  assert.equal(text(await execute("read", { path: traversal })), physical.trimEnd());
  await execute("edit", { path: traversal, edits: [{ oldText: physical.trim(), newText: "EDITED" }] });
  assert.equal(readFileSync(addressed(traversal), "utf8"), "EDITED\n");
  await execute("write", { path: traversal, content: "WRITTEN\n" });
  assert.equal(readFileSync(addressed(traversal), "utf8"), "WRITTEN\n");
  const neighbor = process.platform === "win32" ? "actual/file.txt" : "file.txt";
  assert.equal(readFileSync(join(root, neighbor), "utf8"), process.platform === "win32" ? "PHYSICAL\n" : "LEXICAL\n");

  // Search tools receive the same physical root, including exact Unicode names.
  const searchPath = `link${sep}..`;
  const expectedDir = realpathSync.native(addressed(searchPath));
  writeFileSync(join(expectedDir, "selected.txt"), "SEARCH_MARKER\n");
  for (const [name, extra] of [
    ["ls", {}], ["find", { pattern: "selected.txt" }], ["grep", { pattern: "SEARCH_MARKER" }],
  ] as const) {
    assert.match(text(await execute(name, { path: searchPath, ...extra })), /selected\.txt/);
  }
  await execute("change_dir", { path: searchPath });
  assert.equal(text(await execute("read", { path: "selected.txt" })), "SEARCH_MARKER");
  await session.prompt(`/cwd ${root}`);
  await session.prompt(`/cwd ${searchPath}`);
  assert.equal(text(await execute("read", { path: "selected.txt" })), "SEARCH_MARKER");
  await execute("change_dir", { path: root });
  mkdirSync(join(root, "@literal"));
  await execute("change_dir", { path: "@literal" });
  await execute("write", { path: "inside.txt", content: "LITERAL" });
  assert.equal(readFileSync(join(root, "@literal/inside.txt"), "utf8"), "LITERAL");
  await execute("change_dir", { path: root });

  for (const name of ["space\u00a0name.txt", "space\u202fname.txt", "literal%23#.txt"]) {
    writeFileSync(join(root, name), "EXACT\n");
    writeFileSync(join(root, "space name.txt"), "NEIGHBOR\n");
    assert.equal(text(await execute("read", { path: name })), "EXACT");
    await execute("edit", { path: name, edits: [{ oldText: "EXACT", newText: "EDITED" }] });
    await execute("write", { path: name, content: "EXACT_UPDATED\n" });
    assert.equal(readFileSync(join(root, name), "utf8"), "EXACT_UPDATED\n");
    assert.equal(readFileSync(join(root, "space name.txt"), "utf8"), "NEIGHBOR\n");
  }
  if (process.platform === "win32") {
    const drive = parse(root).root.slice(0, 2);
    assert.equal(text(await execute("read", { path: `${drive}file.txt` })), readFileSync(join(root, "file.txt"), "utf8").trimEnd());
    const extended = `${toNamespacedPath(root)}\\extended\u00a0.`;
    writeFileSync(extended, "EXTENDED");
    assert.equal(text(await execute("read", { path: extended })), readFileSync(extended, "utf8"));
    await execute("write", { path: extended, content: "EXTENDED_UPDATED" });
    assert.equal(readFileSync(extended, "utf8"), "EXTENDED_UPDATED");
  }
  const unicodeDir = "search\u00a0directory";
  mkdirSync(join(root, unicodeDir)); mkdirSync(join(root, "search directory"));
  writeFileSync(join(root, unicodeDir, "selected.txt"), "SEARCH_MARKER\n");
  for (const [name, extra] of [
    ["ls", {}], ["find", { pattern: "selected.txt" }], ["grep", { pattern: "SEARCH_MARKER" }],
  ] as const) {
    assert.match(text(await execute(name, { path: unicodeDir, ...extra })), /selected\.txt/);
  }

  // Binding and a pre-aborted execution cannot create parents.
  const pending = { path: `missing${sep}..${sep}link${sep}..${sep}new${sep}nested${sep}file`, content: "NEW" };
  await admit("write", pending);
  assert.ok(!existsSync(join(root, "missing")));
  assert.ok(!existsSync(join(expectedDir, "new")));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => session.getToolDefinition("write")!.execute("write", pending, controller.signal, undefined, session.extensionRunner!.createContext()), /abort/i);
  assert.ok(!existsSync(join(root, "missing")));
  assert.ok(!existsSync(join(expectedDir, "new")));
  await session.getToolDefinition("write")!.execute("write", pending, undefined, undefined, session.extensionRunner!.createContext());
  assert.equal(readFileSync(join(expectedDir, "new/nested/file"), "utf8"), "NEW");
  assert.equal(existsSync(join(root, "missing")), process.platform !== "win32");

  // Compare invalid traversal against native stat rather than imposing POSIX errors on Windows.
  for (const suffix of [`absent${sep}..${sep}file.txt`, `file.txt${sep}..${sep}file.txt`, `file.txt${sep}`]) {
    let nativeError: unknown;
    try { statSync(addressed(suffix)); } catch (error) { nativeError = error; }
    for (const [name, extra] of [
      ["read", {}], ["edit", { edits: [{ oldText: "WRITTEN", newText: "WRITTEN" }] }],
      ["ls", {}], ["find", { pattern: "*" }], ["grep", { pattern: "." }],
    ] as const) {
      if (nativeError) await assert.rejects(() => execute(name, { path: suffix, ...extra }));
    }
    if (nativeError) await assert.rejects(() => execute("change_dir", { path: suffix }));
  }
  for (const [index, suffix] of [`file.txt${sep}`, `file.txt${sep}..${sep}file.txt`].entries()) {
    const native = join(root, `native-write-${index}`), adapted = join(root, `adapted-write-${index}`);
    for (const base of [native, adapted]) { mkdirSync(base); writeFileSync(join(base, "file.txt"), "ORIGINAL"); }
    let nativeError: unknown;
    try { writeFileSync(`${native}${sep}${suffix}`, "UPDATED"); } catch (error) { nativeError = error; }
    const operation = () => execute("write", { path: `${adapted}${sep}${suffix}`, content: "UPDATED" });
    if (nativeError) await assert.rejects(operation);
    else await operation();
    assert.equal(readFileSync(join(adapted, "file.txt"), "utf8"), readFileSync(join(native, "file.txt"), "utf8"));
  }
  if (process.platform !== "win32") {
    symlinkSync("actual/dangling.txt", join(root, "dangling"));
    await execute("write", { path: "dangling", content: "DANGLING" });
    assert.equal(readFileSync(join(root, "actual/dangling.txt"), "utf8"), "DANGLING");
    symlinkSync("absent-parent/dangling.txt", join(root, "bad-dangling"));
    await assert.rejects(() => execute("write", { path: "bad-dangling", content: "BAD" }));
    assert.ok(!existsSync(join(root, "absent-parent")));
    for (const [name, target] of [["trailing-link", "file.txt/"], ["invalid-link", "file.txt/../file.txt"], ["cycle", "cycle"]]) {
      symlinkSync(target!, join(root, name!));
      await assert.rejects(() => execute("write", { path: name, content: "BAD" }));
    }
  }
  assert.equal(readFileSync(addressed(traversal), "utf8"), "WRITTEN\n");
  console.log(`ok: native ${process.platform} traversal, all path tools/cwd, Unicode, non-mutating admission/cancellation, dangling links`);
} finally {
  session.dispose();
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
}
