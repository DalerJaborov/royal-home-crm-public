import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiShellRollout } from "@royal-home/shared";
import { readShellDraft, rebaseShellDraft, writeShellDraft } from "./uiShellDraft";

const baseline: UiShellRollout = { enabled: true, agentIds: ["director"], roles: [] };
const value: UiShellRollout = { ...baseline, agentIds: ["director", "agent-a"] };

describe("shell rollout draft across StepUpGate remounts", () => {
  beforeEach(() => {
    const rows = new Map<string, string>();
    vi.stubGlobal("sessionStorage", {
      get length() { return rows.size; },
      key: (index: number) => [...rows.keys()][index] ?? null,
      getItem: (key: string) => rows.get(key) ?? null,
      setItem: (key: string, data: string) => rows.set(key, data),
      removeItem: (key: string) => rows.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores edits from storage when the protected form is recreated", () => {
    writeShellDraft("director", 1, { baseline, value });
    expect(readShellDraft("director", 1)).toEqual({ baseline, value });
  });
  it("does not restore another account's or an earlier login's draft", () => {
    writeShellDraft("director", 1, { baseline, value });
    expect(readShellDraft("other-admin", 1)).toBeUndefined();
    expect(readShellDraft("director", 2)).toBeUndefined();
    writeShellDraft("other-admin", 2, { baseline, value });
    expect(readShellDraft("director", 1)).toBeUndefined();
  });
  it("clears stored edits after reset or successful save", () => {
    writeShellDraft("director", 1, { baseline, value });
    writeShellDraft("director", 1);
    expect(readShellDraft("director", 1)).toBeUndefined();
  });
  it("preserves a server kill switch and new memberships when local edits only added a person", () => {
    const current: UiShellRollout = { enabled: false, agentIds: ["director", "agent-b"], roles: ["ADMIN"] };
    expect(rebaseShellDraft({ baseline, value }, current)).toEqual({
      enabled: false, agentIds: ["director", "agent-b", "agent-a"], roles: ["ADMIN"],
    });
  });
  it("applies deliberate removals without restoring unrelated server removals", () => {
    const before: UiShellRollout = { enabled: false, agentIds: ["a", "b"], roles: ["AGENT"] };
    const edited: UiShellRollout = { enabled: true, agentIds: ["b"], roles: [] };
    expect(rebaseShellDraft({ baseline: before, value: edited }, { enabled: false, agentIds: ["a", "c"], roles: ["AGENT", "ADMIN"] })).toEqual({
      enabled: true, agentIds: ["c"], roles: ["ADMIN"],
    });
  });
  it("rejects malformed stored data and tolerates unavailable storage", () => {
    sessionStorage.setItem("rh-shell-rollout-draft:director:1", JSON.stringify({ baseline, value: { enabled: true, roles: ["UNKNOWN"] } }));
    expect(readShellDraft("director", 1)).toBeUndefined();
    vi.stubGlobal("sessionStorage", { getItem() { throw new Error("blocked"); }, get length() { throw new Error("blocked"); } });
    expect(readShellDraft("director", 1)).toBeUndefined();
    expect(() => writeShellDraft("director", 1, { baseline, value })).not.toThrow();
  });
});
