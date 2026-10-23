import { afterEach, expect, it, vi } from "vitest";
const artifact = vi.hoisted(() => ({ changed: "" }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(async (...args: Parameters<typeof actual.readFile>) => {
    const bytes = await actual.readFile(...args), location = String(args[0]).replace(/\\/g, "/");
    if (!artifact.changed || !(location.endsWith(`/${artifact.changed}.ts`) || location.endsWith(`/${artifact.changed}.js`))) return bytes;
    return typeof bytes === "string" ? `${bytes}\n// synthetic change\n` : Buffer.concat([bytes, Buffer.from("\n// synthetic change\n")]);
  }) };
});
// No database is touched; the stub also keeps tests/setup.ts from resetting one.
vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));
import { buildCurrentCustomerAgentManifest } from "../src/lib/customerAgentRegistration.js";
import { createCustomerAgentProviderSnapshot } from "../src/ai/customerAgentProviderConfig.js";
afterEach(() => { artifact.changed = ""; });

// Shared utilities other features edit must not invalidate the revision; agent logic must.
it.each(["privateFiles", "safeFetch", "ffmpeg", "workingHours", "intake", "attachments", "incomingSpam", "commentHate", "listingAd"])(
  "editing shared utility %s leaves the manifest unchanged", async name => {
    const snapshot = createCustomerAgentProviderSnapshot(), before = await buildCurrentCustomerAgentManifest(snapshot);
    artifact.changed = name;
    expect(await buildCurrentCustomerAgentManifest(snapshot)).toEqual(before);
  });
it.each(["customerAgentCore", "customerAgentRegistration", "customerPublicModerationPolicy", "customerDeliveryDispatcher"])(
  "editing agent file %s changes coreHash only", async name => {
    const snapshot = createCustomerAgentProviderSnapshot(), before = await buildCurrentCustomerAgentManifest(snapshot);
    artifact.changed = name;
    const after = await buildCurrentCustomerAgentManifest(snapshot);
    expect(after.coreHash).not.toBe(before.coreHash);
    expect({ ...after, coreHash: before.coreHash }).toEqual(before);
  });
