/** Host-selection boundary shared by the contract tests.
 *
 * PI_PACKAGE_DIR optionally selects a fork installation for compatibility runs. Every test file
 * imports the host surface and the submodules it needs through this module, so the selection is
 * made exactly once and the swap boundary stays in one place. Each dynamic import below crosses
 * that boundary — its static type comes from the installed package via assertion (QX-005).
 */
import { findPackageJSON } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as AgentCoreModule from "@earendil-works/pi-agent-core";
import type * as AiModule from "@earendil-works/pi-ai";
import type * as AiProvidersAllModule from "@earendil-works/pi-ai/providers/all";
import type * as HostModule from "@earendil-works/pi-coding-agent";
import type * as AuthStorageModule from "./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import type * as LoaderModule from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import type * as MessagesModule from "./node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js";

/** The host package entry URL used for every cross-package import below. */
export const packageUrl: string =
  process.env.PI_PACKAGE_DIR !== undefined
    ? pathToFileURL(join(process.env.PI_PACKAGE_DIR, "dist/index.js")).href
    : import.meta.resolve("@earendil-works/pi-coding-agent");

export async function importModule<T>(url: string): Promise<T> {
  // The single assertion at the swap boundary: the import runs at a runtime URL, so the module
  // value arrives as `any`; every export below receives the installed package's static type here.
  // oxlint-disable-next-line no-unsafe-type-assertion -- QX-005: runtime-URL import arrives as any.
  return (await import(url)) as T;
}

export const host: typeof HostModule = await importModule<typeof HostModule>(packageUrl);

/** The host's dist directory, for submodule imports that the tests derive themselves. */
export const distDir: string = dirname(fileURLToPath(packageUrl));

function moduleUrl(specifier: string): string {
  const resolved = findPackageJSON(specifier, packageUrl);
  if (resolved === undefined) {
    throw new Error(`${specifier} was not found next to the host under test`);
  }
  return pathToFileURL(resolved).href;
}

const agentCoreUrl = moduleUrl("@earendil-works/pi-agent-core");
const aiUrl = moduleUrl("@earendil-works/pi-ai");

export const loader: typeof LoaderModule = await importModule<typeof LoaderModule>(
  new URL("./core/extensions/loader.js", packageUrl).href,
);

export const messages: typeof MessagesModule = await importModule<typeof MessagesModule>(
  new URL("./core/messages.js", packageUrl).href,
);

export const authStorage: typeof AuthStorageModule = await importModule<typeof AuthStorageModule>(
  new URL("./core/auth-storage.js", packageUrl).href,
);

export const agentCore: typeof AgentCoreModule = await importModule<typeof AgentCoreModule>(
  new URL("./dist/index.js", agentCoreUrl).href,
);

export const ai: typeof AiModule = await importModule<typeof AiModule>(
  new URL("./dist/index.js", aiUrl).href,
);
export const aiProvidersAll: typeof AiProvidersAllModule = await importModule<
  typeof AiProvidersAllModule
>(new URL("./dist/providers/all.js", aiUrl).href);
