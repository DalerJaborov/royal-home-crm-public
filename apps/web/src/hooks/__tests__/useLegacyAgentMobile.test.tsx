import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { useLegacyAgentMobile } from "../useLegacyAgentMobile";

const device = vi.hoisted(() => ({ narrow: true, role: "AGENT", clean: false }));
vi.mock("../useCleanShell", () => ({ useCleanShell: () => device.clean }));
vi.mock("../useNarrowScreen", () => ({ useNarrowScreen: () => device.narrow }));
vi.mock("../../store/auth", () => ({ useAuthStore: (select: (s: { agent: { role: string } }) => unknown) => select({ agent: { role: device.role } }) }));
function Screen() { return <span>{useLegacyAgentMobile() ? "legacy" : "current"}</span>; }

describe("legacy agent mobile boundary", () => {
  it.each([[true, "AGENT", "legacy"], [false, "AGENT", "current"], [true, "DIRECTOR", "current"], [true, "ADMIN", "current"], [true, "MANAGER", "current"]] as const)("narrow=%s role=%s selects %s", (narrow, role, expected) => {
    device.narrow = narrow;
    device.role = role;
    device.clean = false;
    expect(renderToStaticMarkup(<Screen />)).toBe("<span>" + expected + "</span>");
  });
  it("leaves legacy only after the shared local preview and server gate enable Clean", () => {
    device.narrow = true;
    device.role = "AGENT";
    device.clean = true;
    expect(renderToStaticMarkup(<Screen />)).toBe("<span>current</span>");
    device.clean = false;
    expect(renderToStaticMarkup(<Screen />)).toBe("<span>legacy</span>");
  });
});
