import { describe, expect, it } from "vitest";
import { resolvePermissions, type Role, type PermissionId } from "@royal-home/shared";
import { buildItems } from "./FabMenu";

const forRole = (role: Role, readOnly = false) => {
  const permissions = resolvePermissions(role);
  return buildItems(role, permission => permissions.has(permission), readOnly);
};

describe("mobile quick actions respect page capabilities", () => {
  it.each(["MARKETING", "EDITOR"] as Role[])("%s does not advertise the blocked client page", role => {
    const items = forRole(role);
    expect(items.some(item => item.to === "/clients?new=1")).toBe(false);
    expect(items.some(item => item.to === "/sources")).toBe(resolvePermissions(role).has("reports.view"));
    expect(items.some(item => item.to === "/properties/new")).toBe(true);
  });
  it("shareholders see read-only destinations instead of creation forms", () => {
    const items = forRole("SHAREHOLDER");
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(item => item.to === "/reports" || item.to === "/finance")).toBe(true);
    expect(items.some(item => item.action === "showing")).toBe(false);
  });
  it.each(["DIRECTOR", "ADMIN", "MANAGER", "AGENT", "HEAD_OF_SALES", "MARKETING", "EDITOR", "SECURITY", "SHAREHOLDER"] as Role[])("%s cannot advertise mutations when the profile is read-only", role => {
    const items = forRole(role, true);
    expect(items.every(item => item.to === "/reports" || item.to === "/finance")).toBe(true);
  });
  it("revoked manager and security permissions remove their quick destinations", () => {
    const none = (_permission: PermissionId) => false;
    expect(buildItems("MANAGER", none).map(item => item.to)).not.toContain("/telephony");
    expect(buildItems("MANAGER", none).map(item => item.to)).not.toContain("/other-inquiries");
    expect(buildItems("SECURITY", none)).toEqual([]);
  });
  it("director navigation labels do not promise a form or a weekly preset", () => {
    const items = forRole("DIRECTOR");
    expect(items.find(item => item.to === "/oversight")?.label).toBe("Контроль задач");
    expect(items.find(item => item.to === "/reports")?.label).toBe("Отчёты");
    expect(items.find(item => item.to === "/finance")?.label).toBe("Расходы");
  });
});
