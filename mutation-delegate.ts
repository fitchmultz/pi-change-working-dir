import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type EditToolDetails,
  type EditToolInput,
  type ExtensionToolContext,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";
import { constants, statSync } from "node:fs";
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { fileTarget, isRecord, queueTarget } from "./native-paths.ts";

export type DelegatedExecution = {
  delegatedPath: string;
  execute: (
    id: string,
    params: object,
    signal: AbortSignal | undefined,
    ctx: ExtensionToolContext,
  ) => Promise<AgentToolResult<EditToolDetails | undefined>>;
};

function isTextPair(value: unknown): value is { oldText: string; newText: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "oldText" in value &&
    "newText" in value &&
    typeof value.oldText === "string" &&
    typeof value.newText === "string"
  );
}

function textPair(value: unknown): { oldText: string; newText: string } {
  if (!isTextPair(value)) {
    throw new Error("Expected edit pairs");
  }
  return value;
}

/** A required string argument of admitted tool arguments. */
function argumentString(params: object, key: string): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  const value: unknown = params[key];
  return typeof value === "string" ? value : undefined;
}

/** Write arguments for delegated execution, validated structurally before rebinding. */
function writeArguments(params: object): WriteToolInput {
  const path = argumentString(params, "path");
  const content = argumentString(params, "content");
  if (path === undefined || content === undefined) {
    throw new Error("Expected write arguments");
  }
  return { ...params, path, content };
}

/** Edit arguments for delegated execution, validated structurally before rebinding. */
function editArguments(params: object): EditToolInput {
  const path = argumentString(params, "path");
  const edits = argumentEdits(params);
  if (path === undefined || edits === undefined) {
    throw new Error("Expected edit arguments");
  }
  return { ...params, path, edits };
}

function argumentEdits(params: object): { oldText: string; newText: string }[] | undefined {
  if (!isRecord(params) || !Array.isArray(params.edits)) {
    return undefined;
  }
  return params.edits.map(textPair);
}

/** Build the write/edit delegate whose operations stay pinned to the captured directory. */
export function mutationDelegate(call: {
  name: string;
  cwd: string;
  path: string;
  showTarget: (shown?: string) => void;
  signal: AbortSignal | undefined;
}): DelegatedExecution {
  const { name, cwd, path, showTarget, signal } = call;
  // Factory execution registers its queue before any asynchronous preparation.
  const delegatedPath = pathToFileURL(queueTarget(path)).href;
  const publish = async (_absolutePath: string, content: string): Promise<void> => {
    signal?.throwIfAborted();
    const publishedTarget = fileTarget(path);
    showTarget(publishedTarget);
    await writeFile(publishedTarget, content, "utf8");
  };
  if (name === "write") {
    return writeDelegate({ cwd, path, delegatedPath, publish });
  }
  return editDelegate({ cwd, path, delegatedPath, publish, showTarget, signal });
}

function writeDelegate(call: {
  cwd: string;
  path: string;
  delegatedPath: string;
  publish: (absolutePath: string, content: string) => Promise<void>;
}): DelegatedExecution {
  const { cwd, path, delegatedPath, publish } = call;
  const definition = createWriteToolDefinition(cwd, {
    operations: {
      mkdir: async (_dir: string) => {
        await mkdir(dirname(path), { recursive: true });
      },
      writeFile: publish,
    },
  });
  return {
    delegatedPath,
    execute: async (id, params, delegateSignal, delegateCtx) => {
      const input = { ...writeArguments(params), path: delegatedPath };
      // The native write factory never invokes onUpdate; undefined occupies its mid-signature slot.
      return definition.execute(id, input, delegateSignal, undefined, delegateCtx);
    },
  };
}

function editDelegate(call: {
  cwd: string;
  path: string;
  delegatedPath: string;
  publish: (absolutePath: string, content: string) => Promise<void>;
  showTarget: (shown?: string) => void;
  signal: AbortSignal | undefined;
}): DelegatedExecution {
  const { cwd, path, delegatedPath, publish, showTarget, signal } = call;
  try {
    statSync(path);
    showTarget(fileTarget(path));
  } catch {
    // Missing previews wait for queued validation.
  }
  const definition = createEditToolDefinition(cwd, {
    operations: {
      access: async () => {
        await access(path, constants.R_OK | constants.W_OK);
        await stat(path);
        signal?.throwIfAborted();
        showTarget(await realpath(path));
      },
      readFile: async () => readFile(path),
      writeFile: publish,
    },
  });
  return {
    delegatedPath,
    execute: async (id, params, delegateSignal, delegateCtx) => {
      const input = { ...editArguments(params), path: delegatedPath };
      // The native edit factory never invokes onUpdate; undefined occupies its mid-signature slot.
      return definition.execute(id, input, delegateSignal, undefined, delegateCtx);
    },
  };
}
