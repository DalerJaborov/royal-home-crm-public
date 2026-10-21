import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { clientPrimaryState } from "../clientPrimaryState";
import { ClientStateBadge } from "../../components/ClientStateBadge";
import { showsInactiveLabel } from "../../components/InactiveLevelBadge";
import { clientAction } from "../clientAction";

const base = { kind: "BUYER" as const, status: "CONTACTED" as const, workStatus: "ACTIVE" as const,
  inactiveLevel: null, hiddenReason: null, pendingAcceptance: false, deletedAt: null, acceptedAt: null };

describe("one primary client state", () => {
  it.each(["LOST", "ARCHIVED", "DEAL_CLOSED"] as const)("%s wins over stale inactivity and acceptance", (status) => {
    const c = { ...base, status, workStatus: "INACTIVE" as const, inactiveLevel: "RED" as const, pendingAcceptance: true };
    expect(clientPrimaryState(c).id).toBe("hidden");
    expect(showsInactiveLabel(c)).toBe(false);
    expect(clientAction({ ...c, unread: true }, Date.now(), true)).toBeNull();
  });
  it.each(["GREEN", "YELLOW", "RED"] as const)("%s is rendered once, with its explanation", (inactiveLevel) => {
    const c = { ...base, status: "HOT" as const, workStatus: "INACTIVE" as const, inactiveLevel,
      hiddenReason: { kind: "inactive" as const, label: "Неактивен" } };
    const html = renderToStaticMarkup(<ClientStateBadge client={c} />);
    expect(html.replace(/<[^>]*>/g, "")).toBe("Неактивный");
    expect(html).not.toContain("Горячий");
    expect(html).not.toContain("Неактивен");
    expect(html).toContain("title=");
  });
  it("missing traffic data is neutral and never invents yellow history", () => {
    const state = clientPrimaryState({ ...base, workStatus: "INACTIVE" });
    expect(state.tone).toBe("mute");
    expect(state.title).toContain("ещё не рассчитан");
  });
  it("deferred clients do not look hot or wait for lead acceptance", () => {
    expect(clientPrimaryState({ ...base, status: "HOT", workStatus: "DEFERRED", pendingAcceptance: true }).id).toBe("deferred");
  });
  it("pending and other clients have their own states", () => {
    expect(clientPrimaryState({ ...base, pendingAcceptance: true }).id).toBe("pending");
    expect(clientPrimaryState({ ...base, kind: "OTHER", pendingAcceptance: true }).id).toBe("other");
    expect(clientPrimaryState({ ...base, kind: "OTHER", workStatus: "INACTIVE", inactiveLevel: "RED" }).id).toBe("other");
  });
  it("trash suppresses the old inactive label", () => {
    const c = { ...base, workStatus: "INACTIVE" as const, deletedAt: "2026-10-20T07:00:00Z" };
    expect(showsInactiveLabel(c)).toBe(false);
    expect(clientPrimaryState(c).id).toBe("trashed");
  });
});
