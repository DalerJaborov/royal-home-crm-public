import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Dashboard } from "./Dashboard";
const state = vi.hoisted(() => ({ role: "AGENT", narrow: true, clean: false, cleanFactory: () => Promise.resolve({}) }));
vi.mock("../lib/cleanRouteChunks", () => ({ loadCleanPult: state.cleanFactory }));
vi.mock("../store/auth", () => ({ useAuthStore: (select: (s: { agent: { role: string } }) => unknown) => select({ agent: { role: state.role } }) }));
vi.mock("../hooks/useNarrowScreen", () => ({ useNarrowScreen: () => state.narrow }));
vi.mock("../hooks/useMobileUx", () => ({ useMobileUx: () => state.narrow }));
vi.mock("../hooks/useCleanShell", () => ({ useCleanShell: () => state.clean }));
vi.mock("../lib/lazyWithReload", () => ({ lazyWithReload: (factory: () => unknown) => {
  const source = factory.toString();
  const name = source.includes("MobileAgentHome") ? "legacy-agent-home" : source.includes("AgentHome") ? "desktop-agent-home" : factory === state.cleanFactory ? "clean-director-home" : "other-role-home";
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
});
