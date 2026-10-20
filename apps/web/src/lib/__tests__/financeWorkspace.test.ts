import { describe, expect, it } from "vitest";
import { financeWorkspace, financeWorkspaceSearch } from "../financeWorkspace";

describe("finance workspace URL state", () => {
  it("accepts known workspace URLs and defaults unsupported values safely", () => {
    expect(financeWorkspace("payouts")).toBe("payouts");
    expect(financeWorkspace("recurring")).toBe("recurring");
    expect(financeWorkspace("unknown")).toBe("expenses");
    expect(financeWorkspace(null)).toBe("expenses");
  });
  it("preserves shell and unrelated parameters without mutating previous history", () => {
    const previous = new URLSearchParams("shell=clean&workspace=overview&test=keep");
    const next = financeWorkspaceSearch(previous, "payouts");
    expect(next.get("shell")).toBe("clean");
    expect(next.get("test")).toBe("keep");
    expect(next.get("workspace")).toBe("payouts");
    expect(previous.get("workspace")).toBe("overview");
  });
  it("returns to the default expense URL without stripping other parameters", () => {
    const next = financeWorkspaceSearch(new URLSearchParams("shell=clean&workspace=recurring"), "expenses");
    expect(next.toString()).toBe("shell=clean");
    expect(financeWorkspace(next.get("workspace"))).toBe("expenses");
  });
});
