import { afterEach, expect, it, vi } from "vitest";
const artifact = vi.hoisted(() => ({ changed: "", observed: new Set<string>() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    const bytes = await actual.readFile(...args), location = String(args[0]);
    if (/\/(customerOwnSiteIdentity|customerPropertyUrls|propertyMatch|customerActionProperty|ownerQuestionMutation)\.(ts|js)$/.test(location)) artifact.observed.add(location);
    if (!artifact.changed || !location.endsWith(`/${artifact.changed}.ts`) && !location.endsWith(`/${artifact.changed}.js`)) return bytes;
    return typeof bytes === "string" ? `${bytes}\n// synthetic artifact change\n`
      : Buffer.concat([bytes, Buffer.from("\n// synthetic artifact change\n")]);
  }) };
});
import { buildCurrentCustomerAgentManifest } from "../src/lib/customerAgentRegistration.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
afterEach(() => { artifact.changed = ""; artifact.observed.clear(); });
it.each(["customerOwnSiteIdentity", "customerPropertyUrls", "propertyMatch", "customerActionProperty", "ownerQuestionMutation"])("pins %s in coreHash without changing model, prompt or rights", async name => {
  const snapshot = createCustomerAgentProviderSnapshot(), before = await buildCurrentCustomerAgentManifest(snapshot);
  artifact.changed = name; const after = await buildCurrentCustomerAgentManifest(snapshot);
  expect(artifact.observed.size).toBe(5); expect(after.coreHash).not.toBe(before.coreHash);
  expect({ ...after, coreHash: before.coreHash }).toEqual(before);
});
