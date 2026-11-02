import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashToolDetails,
  EditToolDetails,
  ExtensionToolContext,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  ReadToolDetails,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";
import type { Static, TSchema } from "typebox";
import { mutationDelegate, type DelegatedExecution } from "./mutation-delegate.ts";
import { assertAvailable, bindPath, isRecord, operationPath, readTarget } from "./native-paths.ts";
import { realpath, stat } from "node:fs/promises";
import type { Selection } from "./selection.ts";

const DEFAULT_PATH_TOOLS = new Set(["ls", "grep", "find"]);
const PATH_TOOLS = new Set(["read", "write", "edit", ...DEFAULT_PATH_TOOLS]);

/** Shared per-row render state carried between wrapped render callbacks. */
export type RenderState = {
  callComponent?: { preview?: { error?: string | undefined } } | undefined;
  workingDirectory?: string | undefined;
  workingTarget?: string | undefined;
};

/** Receipt fields the wrapper adds to every result's details at runtime. */
export type WorkingDetails = {
  workingDirectory: string;
  workingPath?: string | undefined;
  workingTarget?: string | undefined;
};

/** The details types of every wrapped native tool, plus the wrapper's receipt. */
export type WrappedDetails =
  | BashToolDetails
  | EditToolDetails
  | FindToolDetails
  | GrepToolDetails
  | LsToolDetails
  | ReadToolDetails
  | WorkingDetails
  | undefined;

/** The captured directory and read fallback for one admitted tool invocation. */
export type Invocation = {
  cwd: string;
  readFallback: { bound: string; requested: string } | undefined;
};

type BaseRenderContext = Parameters<
  NonNullable<ToolDefinition<TSchema, unknown, RenderState>["renderCall"]>
>[2];

/** The render-context view the wrapper keeps for live target updates. */
export type RenderContext = Omit<BaseRenderContext, "args"> & { args: unknown };

type Delegation = { delegatedPath: string; target: string | undefined; mutation: boolean };

type Prepared = {
  delegatedPath: string | undefined;
  delegatedExecute: DelegatedExecution["execute"] | undefined;
};

export type ToolBinder = {
  wrap: <TParams extends TSchema, TDetails extends WrappedDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ) => ToolDefinition<TParams, TDetails | WorkingDetails, TState & RenderState>;
  bind: (name: string, input: object, cwd: string) => Invocation;
  dispose: () => void;
};

type BinderDeps = {
  selection: Selection;
  bind: (name: string, input: object, cwd: string) => Invocation;
  invocations: WeakMap<object, Invocation>;
  renderCalls: Map<string, RenderContext>;
};

/** The path argument of admitted tool arguments, when it is a string. */
function pathArgument(value: object): string | undefined {
  return "path" in value && typeof value.path === "string" ? value.path : undefined;
}

/** Admission rebinding for path-taking tools. */
function rebindPath(name: string, input: object, cwd: string): void {
  if (!PATH_TOOLS.has(name) || !isRecord(input)) {
    return;
  }
  const rawPath = input.path;
  // oxlint-disable-next-line no-param-reassign -- QX-001: admission rebinding mutates the admitted arguments object in place; the bound path must be visible to the native tool reading the same object.
  input.path =
    DEFAULT_PATH_TOOLS.has(name) && (rawPath === undefined || rawPath === "")
      ? cwd
      : bindPath(rawPath, cwd);
}

/** The original read spelling survives binding for the read tool's variant fallbacks. */
function readFallbackOf(
  name: string,
  rawPath: unknown,
  boundPath: unknown,
): { bound: string; requested: string } | undefined {
  if (name !== "read" || typeof rawPath !== "string" || typeof boundPath !== "string") {
    return undefined;
  }
  return { bound: boundPath, requested: rawPath };
}

/** The read request keeps the admitted spelling so filename fallbacks never rewrite the captured cwd. */
function readRequest(invocation: Invocation, requestedPath: string): string {
  const fallback = invocation.readFallback;
  return fallback !== undefined && fallback.bound === requestedPath
    ? fallback.requested
    : requestedPath;
}

/** Display spelling for delegated URLs in read hints: shell-quoted plain paths. */
function quotedDisplay(target: string): string {
  return `'${target.replaceAll("'", "'\\''")}'`;
}

/** Rebind render arguments to the resolved target; edit previews keep a file URL path. */
function withBoundArgs<T>(args: T, target: string, name: string): T {
  return {
    ...args,
    path: name === "edit" ? pathToFileURL(target).href : target,
    file_path: target,
  };
}

function isMutation(name: string): boolean {
  return name === "write" || name === "edit";
}

async function statThenRealpath(path: string): Promise<string> {
  await stat(path);
  return realpath(path);
}

/** A context whose cwd is the captured directory, for native tool execution. */
function executionDirectory(ctx: ExtensionToolContext, cwd: string): ExtensionToolContext {
  // oxlint-disable-next-line no-unsafe-type-assertion -- QX-004: prototype inheritance keeps live host getters; only Object.create expresses that view of the context.
  return Object.create(ctx, { cwd: { value: cwd, enumerable: true } }) as ExtensionToolContext;
}

/** The tracked working target plus the callback that publishes it to live renders. */
function targetDisplay(
  deps: BinderDeps,
  id: string,
  cwd: string,
): { cell: { current: string | undefined }; show: (shown?: string) => void } {
  const cell = { current: undefined as string | undefined };
  const show = (shown?: string): void => {
    cell.current = shown;
    const rendering = deps.renderCalls.get(id);
    if (rendering !== undefined) {
      rendering.state.workingDirectory = cwd;
      rendering.state.workingTarget = shown;
      rendering.invalidate();
    }
  };
  return { cell, show };
}

/** Rewrite delegated URLs out of edit preview errors before invalidating the row. */
function invalidatePreview(ctx: RenderContext, name: string): void {
  const target = ctx.state.workingTarget;
  const preview = ctx.state.callComponent?.preview;
  if (
    name === "edit" &&
    preview !== undefined &&
    typeof preview.error === "string" &&
    target !== undefined
  ) {
    preview.error = preview.error.replaceAll(pathToFileURL(target).href, () => target);
  }
}

/** The working-directory receipt of a result, when its details carry one. */
function workingFromDetails(
  details: unknown,
): { directory: string; target: string | undefined } | undefined {
  if (!isRecord(details) || typeof details.workingDirectory !== "string") {
    return undefined;
  }
  const target = details.workingTarget ?? details.workingPath;
  return {
    directory: details.workingDirectory,
    target: typeof target === "string" ? target : undefined,
  };
}

/** Register the invocation when the arguments were not admitted through tool_call. */
function admitInvocation(
  deps: BinderDeps,
  name: string,
  call: { value: object; ctx: ExtensionToolContext },
): {
  cwd: string;
  path: string | undefined;
  requestedPath: string | undefined;
  invocation: Invocation;
} {
  const { value, ctx } = call;
  if (!isRecord(value)) {
    throw new Error("Expected tool arguments");
  }
  deps.selection.initialize(ctx);
  const invocation =
    deps.invocations.get(value) ?? deps.bind(name, value, deps.selection.current(ctx));
  const requestedPath = PATH_TOOLS.has(name) ? pathArgument(value) : undefined;
  return {
    cwd: invocation.cwd,
    path: requestedPath === undefined ? undefined : operationPath(requestedPath, invocation.cwd),
    requestedPath,
    invocation,
  };
}

/** Resolve the target and delegate for an admitted call before native execution. */
async function prepareExecution(
  definition: { name: string },
  admitted: {
    cwd: string;
    path: string | undefined;
    requestedPath: string | undefined;
    invocation: Invocation;
  },
  showTarget: (shown?: string) => void,
  signal: AbortSignal | undefined,
): Promise<Prepared> {
  const { cwd, path, requestedPath, invocation } = admitted;
  if (path === undefined) {
    showTarget();
    return { delegatedPath: undefined, delegatedExecute: undefined };
  }
  if (isMutation(definition.name)) {
    const delegated = mutationDelegate({ name: definition.name, cwd, path, showTarget, signal });
    return { delegatedPath: delegated.delegatedPath, delegatedExecute: delegated.execute };
  }
  const request = requestedPath === undefined ? path : readRequest(invocation, requestedPath);
  const resolved =
    definition.name === "read" ? await readTarget(request, cwd) : await statThenRealpath(path);
  showTarget(resolved);
  return { delegatedPath: pathToFileURL(resolved).href, delegatedExecute: undefined };
}

/** Generated summaries and hints can carry delegated URLs; rewrite only those. */
function rewrittenBlock(
  block: AgentToolResult<unknown>["content"][number],
  delegatedPath: string,
  display: string,
): AgentToolResult<unknown>["content"][number] {
  if (block.type === "text") {
    return { ...block, text: block.text.replaceAll(delegatedPath, () => display) };
  }
  return block;
}

function truncationHint(details: unknown): boolean {
  return (
    isRecord(details) &&
    isRecord(details.truncation) &&
    details.truncation.firstLineExceedsLimit === true
  );
}

/** The receipt fields for result details, derived from the resolved target. */
function receipt(
  cwd: string,
  path: string | undefined,
  target: string | undefined,
): WorkingDetails {
  return {
    workingDirectory: cwd,
    ...(path !== undefined ? { workingPath: path, workingTarget: target } : {}),
  };
}

async function runWrapped<TParams extends TSchema, TDetails extends WrappedDetails>(
  deps: BinderDeps,
  definition: ToolDefinition<TParams, TDetails, never>,
  call: {
    id: string;
    value: Static<TParams>;
    signal: AbortSignal | undefined;
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined;
    ctx: ExtensionToolContext;
  },
): Promise<AgentToolResult<TDetails | WorkingDetails>> {
  const { id, signal, onUpdate, ctx } = call;
  const admitted = admitInvocation(deps, definition.name, call);
  const { cwd, path } = admitted;
  assertAvailable(cwd);
  const display = targetDisplay(deps, id, cwd);
  try {
    signal?.throwIfAborted();
    const prepared = await prepareExecution(definition, admitted, display.show, signal);
    const delegatedPath = prepared.delegatedPath;
    signal?.throwIfAborted();
    // File URLs bypass host Unicode-space rewriting as well as lexical traversal.
    const input = delegatedPath === undefined ? call.value : { ...call.value, path: delegatedPath };
    const executionContext = executionDirectory(ctx, cwd);
    let native: AgentToolResult<TDetails> | AgentToolResult<EditToolDetails | undefined>;
    try {
      native =
        prepared.delegatedExecute === undefined
          ? await definition.execute(id, input, signal, onUpdate, executionContext)
          : await prepared.delegatedExecute(id, call.value, signal, executionContext);
    } catch (error) {
      if (error instanceof Error && delegatedPath !== undefined && path !== undefined) {
        error.message = error.message.replaceAll(delegatedPath, () => display.cell.current ?? path);
      }
      throw error;
    }
    const delegation =
      delegatedPath === undefined
        ? undefined
        : { delegatedPath, target: display.cell.current, mutation: isMutation(definition.name) };
    return withWorkingDetails<TDetails>(
      native,
      receipt(cwd, path, display.cell.current),
      delegation,
    );
  } finally {
    deps.renderCalls.delete(id);
  }
}

/** Merge the working-directory receipt into a result, rewriting delegated URLs when resolved. */
function withWorkingDetails<TDetails extends WrappedDetails>(
  result: AgentToolResult<TDetails> | AgentToolResult<EditToolDetails | undefined>,
  working: WorkingDetails,
  delegation: Delegation | undefined,
): AgentToolResult<TDetails | WorkingDetails> {
  const details: unknown = result.details;
  const rewritten = delegatedRewrite(result, details, delegation);
  const base: Record<string, unknown> = isRecord(details) ? { ...details } : {};
  if (rewritten.patch !== undefined) {
    base.patch = rewritten.patch;
  }
  return {
    ...result,
    content: rewritten.content,
    details: { ...base, ...working },
  };
}

/** Rewrite delegated file URLs in generated text; file contents pass through untouched. */
function delegatedRewrite(
  result: AgentToolResult<unknown>,
  details: unknown,
  delegation: Delegation | undefined,
): { content: AgentToolResult<unknown>["content"]; patch: string | undefined } {
  if (
    delegation === undefined ||
    delegation.target === undefined ||
    (!delegation.mutation && !truncationHint(details))
  ) {
    return { content: result.content, patch: undefined };
  }
  const display = delegation.mutation ? delegation.target : quotedDisplay(delegation.target);
  const content = result.content.map((block) =>
    rewrittenBlock(block, delegation.delegatedPath, display),
  );
  const patch = isRecord(details) && typeof details.patch === "string" ? details.patch : undefined;
  const header = `--- ${delegation.delegatedPath}\n+++ ${delegation.delegatedPath}\n`;
  if (patch !== undefined && patch.startsWith(header)) {
    return {
      content,
      patch: `--- ${delegation.target}\n+++ ${delegation.target}\n${patch.slice(header.length)}`,
    };
  }
  return { content, patch: undefined };
}

/** Admit a tool invocation, rebinding path arguments to the captured directory. */
function bindInvocation(
  invocations: WeakMap<object, Invocation>,
  name: string,
  input: object,
  cwd: string,
): Invocation {
  assertAvailable(cwd);
  const rawPath = "path" in input ? input.path : undefined;
  rebindPath(name, input, cwd);
  const boundPath = "path" in input ? input.path : undefined;
  const invocation: Invocation = {
    cwd,
    readFallback: readFallbackOf(name, rawPath, boundPath),
  };
  invocations.set(input, invocation);
  return invocation;
}

export function createToolBinder(selection: Selection): ToolBinder {
  const invocations = new WeakMap<object, Invocation>();
  const renderCalls = new Map<string, RenderContext>();
  const bind = (name: string, input: object, cwd: string): Invocation =>
    bindInvocation(invocations, name, input, cwd);
  const deps: BinderDeps = { selection, bind, invocations, renderCalls };

  const wrap = <TParams extends TSchema, TDetails extends WrappedDetails, TState>(
    definition: ToolDefinition<TParams, TDetails, TState>,
  ): ToolDefinition<TParams, TDetails | WorkingDetails, TState & RenderState> => {
    // oxlint-disable-next-line no-unsafe-type-assertion -- QX-004: the native renderers read only their own details fields; the wrapper's receipt fields are additive and inert, but variance cannot express the widened details view.
    const native = definition as ToolDefinition<TParams, TDetails | WorkingDetails, TState>;
    const nativeCall = native.renderCall;
    const nativeResult = native.renderResult;
    return {
      ...native,
      // oxlint-disable-next-line max-params -- QX-002: the host tool execute signature fixes five positional parameters.
      async execute(id, value, signal, onUpdate, ctx) {
        return runWrapped<TParams, TDetails>(deps, definition, {
          id,
          value,
          signal,
          onUpdate,
          ctx,
        });
      },
      ...(nativeCall === undefined
        ? {}
        : {
            renderCall(args, theme, ctx) {
              if (ctx.state.workingDirectory === undefined) {
                renderCalls.set(ctx.toolCallId, ctx);
              }
              const target = ctx.state.workingTarget;
              const bound =
                target !== undefined && typeof args === "object" && args !== null
                  ? withBoundArgs(args, target, native.name)
                  : args;
              return nativeCall(bound, theme, {
                ...ctx,
                cwd: ctx.state.workingDirectory ?? ctx.cwd,
                invalidate() {
                  invalidatePreview(ctx, native.name);
                  ctx.invalidate();
                },
                // Argument completion precedes native preflight; don't preview the wrong file.
                argsComplete: ctx.argsComplete && Boolean(ctx.state.workingDirectory),
              });
            },
          }),
      ...(nativeResult === undefined
        ? {}
        : {
            renderResult(result, options, theme, ctx) {
              const working = workingFromDetails(result.details);
              if (working !== undefined) {
                // oxlint-disable-next-line no-param-reassign -- QX-001: the host render context carries shared per-row state that later renders read.
                ctx.state.workingDirectory = working.directory;
                // oxlint-disable-next-line no-param-reassign -- QX-001: the host render context carries shared per-row state that later renders read.
                ctx.state.workingTarget = working.target;
              }
              renderCalls.delete(ctx.toolCallId);
              const target = ctx.state.workingTarget;
              const bound =
                target !== undefined && typeof ctx.args === "object" && ctx.args !== null
                  ? withBoundArgs(ctx.args, target, native.name)
                  : ctx.args;
              return nativeResult(result, options, theme, {
                ...ctx,
                cwd: ctx.state.workingDirectory ?? ctx.cwd,
                args: bound,
              });
            },
          }),
    };
  };

  return { wrap, bind, dispose: () => renderCalls.clear() };
}
