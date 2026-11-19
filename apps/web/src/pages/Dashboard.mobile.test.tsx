import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard } from "./Dashboard";
const state = vi.hoisted(() => ({ role: "AGENT", narrow: true, clean: false, royal: false, cleanFactory: () => Promise.resolve({}) }));
vi.mock("../lib/cleanRouteChunks", () => ({ loadCleanPult: state.cleanFactory }));
vi.mock("../store/auth", () => ({ useAuthStore: (select: (s: { agent: { role: string } }) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock("../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => state.narrow }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.narrow }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => state.clean }));
vi.mock("../hooks/useRoyalLook", async (importOriginal) => ({ ...await importOriginal<typeof import("../hooks/useRoyalLook")>(), useRoyalLook: () => state.royal }));
vi.mock("../lib/lazyWithReload", () => ({ lazyWithReload: (factory: () => unknown) => {
  const source = factory.toString();
  const name = source.includes("look/home/registry") ? "royal-role-home" : source.includes("TodayRoyal") ? "royal-home" : source.includes("HeadOfSalesHome") ? "head-of-sales-home" : source.includes("MobileManagerHome") ? "mobile-manager-home" : source.includes("MobileAgentHome") ? "legacy-agent-home" : source.includes("AgentHome") ? "desktop-agent-home" : source.includes("ManagerHome") ? "manager-home" : factory === state.cleanFactory ? "clean-director-home" : "other-role-home";
  return () => <div>{name}</div>;
} }));
describe("actual Dashboard route selection", () => {
  it("returns the frozen agent mobile home even with a saved Clean preference", () => {
    // useCleanShell resolves an ordinary saved preference to false on AGENT phones.
    state.role = "AGENT"; state.narrow = true; state.clean = false;
    expect(renderToStaticMarkup(<Dashboard />)).toContain("legacy-agent-home");
  });
  it("preserves the current desktop agent home", () => {
    state.role = "AGENT"; state.narrow = false; state.clean = true;
    expect(renderToStaticMarkup(<Dashboard />)).toContain("desktop-agent-home");
  });
  it("preserves the clean director home on desktop", () => {
    state.role = "DIRECTOR"; state.narrow = false; state.clean = true;
    expect(renderToStaticMarkup(<Dashboard />)).toContain("clean-director-home");
  });
  it("routes HEAD_OF_SALES to its dedicated home on desktop and mobile", () => {
    state.role = "HEAD_OF_SALES"; state.clean = false;
    state.narrow = false;
    expect(renderToStaticMarkup(<Dashboard />)).toContain("head-of-sales-home");
    state.narrow = true;
    expect(renderToStaticMarkup(<Dashboard />)).toContain("head-of-sales-home");
  });
  it("keeps legacy MANAGER routing unchanged on desktop and mobile", () => {
    state.role = "MANAGER"; state.clean = false;
    state.narrow = false;
    expect(renderToStaticMarkup(<Dashboard />)).toContain("manager-home");
    state.narrow = true;
    expect(renderToStaticMarkup(<Dashboard />)).toContain("mobile-manager-home");
  });
  it("«Новый вид» меняет главную только тем ролям, для которых она нарисована", () => {
    state.royal = true; state.narrow = false; state.clean = true;
    for (const role of ["DIRECTOR", "ADMIN", "HEAD_OF_SALES", "AGENT"]) {
      state.role = role;
      expect(renderToStaticMarkup(<Dashboard />)).toContain("royal-home");
    }
    // Остальные роли — ядро главной на реестре блоков (пачка home, 20.11.2026), на ПК и телефоне.
    for (const role of ["EDITOR", "MARKETING", "SECURITY", "MANAGER", "SHAREHOLDER"]) {
      state.role = role;
      for (const narrow of [false, true]) {
        state.narrow = narrow;
        const html = renderToStaticMarkup(<Dashboard />);
        expect(html, `${role} narrow=${narrow}`).toContain("royal-role-home");
        expect(html).not.toContain("manager-home");
      }
    }
    state.narrow = false;
    // Без признака у тех же ролей — прежние главные.
    state.royal = false; state.role = "MANAGER";
    expect(renderToStaticMarkup(<Dashboard />)).toContain("manager-home");
    state.role = "DIRECTOR";
    expect(renderToStaticMarkup(<Dashboard />)).toContain("clean-director-home");
  });
});
