import { describe, expect, it } from "vitest";
import { clientIntents, clientCardCanWrite } from "@royal-home/shared";

describe("client card work capabilities", () => {
  it.each([
    ["BUYER", false, false, true], ["SELLER", false, true, false],
    ["BUYER", true, true, true], ["SELLER", true, true, true],
    ["OTHER", true, false, false], [undefined, false, false, false],
  ])("keeps both intentions for %s, dual=%s", (kind, dualIntent, sells, buys) => {
    expect(clientIntents({ kind, dualIntent })).toEqual({ sells, buys });
  });
  it("does not allow view-all to act on a foreign card", () => {
    expect(clientCardCanWrite({ viewerId: "security", assignedAgentId: "agent", canAssign: false, readOnly: false, pending: false })).toBe(false);
  });
  it.each(["readOnly", "pending", "deleted"] as const)("keeps %s closed even with assignment permission", flag => {
    expect(clientCardCanWrite({ viewerId: "admin", assignedAgentId: "agent", canAssign: true, readOnly: false, pending: false, [flag]: true })).toBe(false);
  });
  it("allows an accepted own card and an authorized supervisor", () => {
    expect(clientCardCanWrite({ viewerId: "agent", assignedAgentId: "agent", canAssign: false, readOnly: false, pending: false })).toBe(true);
    expect(clientCardCanWrite({ viewerId: "admin", assignedAgentId: "agent", canAssign: true, readOnly: false, pending: false })).toBe(true);
  });
});
