import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/query-core";
import { markConfirmedFormSource, markOptimisticFormSource, markRolledBackFormSource, ServerFormSyncState } from "../serverFormSync";

function setup() {
  const sync = new ServerFormSyncState<{ name: string; enabled: boolean }>();
  const saved = { name: "Saved", enabled: true };
  sync.refill(saved, saved, saved);
  return { sync, saved };
}

describe("settings rollback provenance", () => {
  it("preserves the submitted draft and rolls back an untouched optimistic field", () => {
    const { sync, saved } = setup();
    const local = { ...saved, name: "Draft" };
    const optimistic = { name: "Draft", enabled: false };
    markOptimisticFormSource(optimistic, saved);
    expect(sync.refill(optimistic, local, optimistic)).toEqual({ enabled: false });
    const restored = { ...saved };
    markRolledBackFormSource(restored, optimistic);
    expect(sync.refill(restored, { ...local, enabled: false }, restored)).toEqual({ enabled: true });
  });

  it("preserves a newer edit after failure", () => {
    const { sync, saved } = setup(), optimistic = { ...saved, name: "Submitted" };
    markOptimisticFormSource(optimistic, saved);
    sync.refill(optimistic, optimistic, optimistic);
    markRolledBackFormSource(saved, optimistic);
    expect(sync.refill(saved, { ...saved, name: "Newer" }, saved)).toEqual({});
  });

  it.each([false, true])("keeps canonical success and newer edits (newer=%s)", newer => {
    const { sync, saved } = setup(), optimistic = { ...saved, name: "Submitted" };
    markOptimisticFormSource(optimistic, saved);
    sync.refill(optimistic, optimistic, optimistic);
    const confirmed = { ...saved, name: "Canonical" };
    markConfirmedFormSource(confirmed);
    expect(sync.refill(confirmed, { ...saved, name: newer ? "Newer" : "Submitted" }, confirmed))
      .toEqual(newer ? {} : { name: "Canonical" });
  });

  it("does not confuse equal values from independent source identities with rollback", () => {
    const { sync, saved } = setup(), optimistic = { ...saved, name: "Draft" };
    markOptimisticFormSource(optimistic, saved);
    sync.refill(optimistic, optimistic, optimistic);
    const tagged = { ...saved };
    markRolledBackFormSource(tagged, optimistic);
    const independent = { ...tagged };
    expect(sync.refill(independent, optimistic, independent)).toEqual({ name: "Saved" });
  });

  it("uses actual structurally shared cache identities, including no-op and reused objects", () => {
    const client = new QueryClient(), { sync, saved } = setup();
    client.setQueryData(["settings"], saved);
    const previous = client.getQueryData<typeof saved>(["settings"])!;
    const unchanged = client.setQueryData<typeof saved>(["settings"], { ...saved })!;
    expect(unchanged).toBe(previous);
    expect(markOptimisticFormSource(unchanged, previous)).toBeUndefined();
    const optimistic = client.setQueryData<typeof saved>(["settings"], { ...saved, name: "Draft" })!;
    markOptimisticFormSource(optimistic, previous);
    sync.refill(optimistic, optimistic, optimistic);
    const restored = client.setQueryData<typeof saved>(["settings"], previous)!;
    markRolledBackFormSource(restored, optimistic);
    expect(sync.refill(restored, optimistic, restored)).toEqual({});
    // Reusing the exact restored identity for a later optimistic write clears rollback provenance.
    markOptimisticFormSource(restored, optimistic);
    sync.refill({ ...saved, name: "Second" }, { ...saved, name: "Second" }, restored);
    markConfirmedFormSource(restored);
    expect(sync.refill(saved, { ...saved, name: "Second" }, restored)).toEqual({ name: "Saved" });
    client.clear();
  });

  it("does not roll back a pristine field as though it were a submitted draft", () => {
    const { sync, saved } = setup(), optimistic = { ...saved, enabled: false };
    markOptimisticFormSource(optimistic, saved);
    expect(sync.refill(optimistic, saved, optimistic)).toEqual({ enabled: false });
    markRolledBackFormSource(saved, optimistic);
    expect(sync.refill(saved, optimistic, saved)).toEqual({ enabled: true });
  });
});
