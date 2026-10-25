import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROLES, canViewInvestigations, clientCardCanWrite, normalizeOverrides, resolvePermissions } from "@royal-home/shared";
import { ClientStateBadge } from "../../components/ClientStateBadge";

describe("confidential investigation boundary", () => {
  it.each(ROLES)("%s cannot widen investigation access through a grant", role => {
    const allowed = role === "DIRECTOR" || role === "ADMIN";
    expect(canViewInvestigations(role)).toBe(allowed);
    expect(resolvePermissions(role, { granted: ["clients.securityReview"], revoked: [] }).has("clients.securityReview")).toBe(allowed);
    if (!allowed) expect(normalizeOverrides(role, { granted: ["clients.securityReview"], revoked: [] }).granted).not.toContain("clients.securityReview");
  });

  it("does not expose a historical investigation reason in a normal status badge", () => {
    const html = renderToStaticMarkup(<ClientStateBadge client={{ kind: "BUYER", status: "LOST", workStatus: "ACTIVE",
      hiddenReason: { kind: "securityReview", label: "Проверка СБ", detail: "Подозрение на обход компании" } }} />);
    expect(html).not.toMatch(/СБ|Подозрение|обход|Проверка/);
    expect(html).toContain("Потерян");
  });

  it("completed work is read-only even for an owner with assignment permission", () => {
    const owner = { viewerId: "agent", assignedAgentId: "agent", canAssign: true, readOnly: false, pending: false };
    expect(clientCardCanWrite({ ...owner, assignmentCompletedAt: "2026-10-23T12:00:00Z" })).toBe(false);
    expect(clientCardCanWrite({ ...owner, assignmentCompletedAt: "2026-10-23T12:00:00Z", canManageCompleted: true })).toBe(true);
    // Open-deal, second-role and deferred work is not marked completed by the server.
    expect(clientCardCanWrite({ ...owner, assignmentCompletedAt: null })).toBe(true);
    expect(clientCardCanWrite({ ...owner, assignedAgentId: "other", canAssign: false })).toBe(false);
  });
});
