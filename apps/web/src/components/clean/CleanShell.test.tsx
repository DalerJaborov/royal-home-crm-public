import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { House } from "lucide-react";
import type { NavItem } from "../../lib/navigation";
import type { ActionRowData } from "../pult/ActionRow";
import { cleanShellEnabled, cleanShellOverride } from "../../hooks/useCleanShell";

const state = vi.hoisted(() => ({ create: true, allowed: true, readOnly: false, aiEnabled: false, navigation: { main: [] as NavItem[], all: [] as NavItem[] } }));
vi.mock("../../lib/navigation", async (importOriginal) => ({ ...await importOriginal<typeof import("../../lib/navigation")>(), useNavigation: () => state.navigation }));
vi.mock("../../lib/permissions", () => ({ useCanCreateProperty: () => state.create, useCan: () => () => state.allowed, useIsReadOnly: () => state.readOnly }));
vi.mock("../../hooks/useSettings", () => ({ useSettings: () => ({ data: { aiAssistantEnabled: state.aiEnabled } }) }));
vi.mock("../../hooks/useMissionControl", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../hooks/useMissionControl")>(),
  useMissionControlLive: () => ({ data: undefined }),
}));
vi.mock("../Topbar", () => ({ Topbar: () => <div>Existing notifications and profile</div> }));
import { CleanShell, partitionCleanNavigation } from "./CleanShell";
import { CleanDecisionRow, runDecisionBatch } from "./CleanDecisionRow";

const row = (id: string, run: () => Promise<boolean>): ActionRowData => ({
  id, tone: "warn", avatar: { label: "Тест", tone: "sky" }, title: "Проверить объект",
  actions: [{ label: "Одобрить", endpoint: "/review", onRun: run, doneMessage: "Одобрено" }],
});
const render = (node: React.ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>);

describe("Royal Clean opt-in and permission boundaries", () => {
  it("не предлагает readonly-пользователю недоступную отправку ИИ-запроса", () => {
    state.aiEnabled = true;
    try {
      state.readOnly = true;
      expect(render(<CleanShell />)).not.toContain('aria-label="ИИ-помощник"');
      state.readOnly = false;
      expect(render(<CleanShell />)).toContain('aria-label="ИИ-помощник"');
    } finally { state.aiEnabled = false; state.readOnly = false; }
  });
  it("reads an exact stored choice, handles blocked storage and the explicit legacy escape hatch", () => {
    expect(cleanShellOverride("?shell=clean")).toBe(true);
    expect(cleanShellOverride("?shell=legacy")).toBe(false);
    expect(cleanShellOverride("?shell=unknown")).toBeUndefined();
  });
  it("preserves every role-filtered registry route exactly once, including overflow", () => {
    for (const count of [0, 4, 9, 28]) {
      const all = Array.from({ length: count }, (_, i) => ({ to: `/route-${i}`, label: `Раздел ${i}`, icon: House, group: "people" }) as NavItem);
      for (const capacity of [4, 5, 6]) {
        const { tabs, overflow } = partitionCleanNavigation(all.slice(0, 9), all, capacity);
        expect([...tabs, ...overflow].map((v) => v.to)).toEqual(all.map((v) => v.to));
        expect(tabs.length).toBeLessThanOrEqual(capacity);
      }
    }
  });
  it("does not inherit another person's shell on a shared computer", () => {
    const values: Record<string, string> = { "rh-shell": "clean", "rh-shell:director": "clean" };
    const storage = { getItem: (key: string) => values[key] ?? null };
  });
  it("prioritizes the approved desktop sections without granting absent routes", () => {
    const routes = ["/calendar", "/finance", "/messages", "/clients", "/properties", "/", "/deals", "/settings"];
    const all = routes.map((to) => ({ to, label: to, icon: House, group: "people" }) as NavItem);
    const { tabs, overflow } = partitionCleanNavigation(all, all);
    expect(tabs.map((item) => item.to)).toEqual(["/", "/clients", "/messages", "/properties", "/deals", "/finance"]);
    expect(tabs.at(-1)?.label).toBe("Деньги");
    expect(overflow.map((item) => item.to)).toEqual(["/calendar", "/settings"]);
    expect(partitionCleanNavigation([], all.filter((item) => item.to !== "/finance")).tabs.some((item) => item.to === "/finance")).toBe(false);
  });
  it("keeps unread overflow visible while the menu is closed and caps only the visual count", () => {
    state.navigation = { main: [], all: [
      { to: "/comments", label: "Комментарии", icon: House, group: "inbox", badge: 103 },
      { to: "/calls", label: "Звонки", icon: House, group: "inbox", badge: 4 },
      { to: "/vacancies", label: "Вакансии", icon: House, group: "people", badge: 9, badgeQuiet: true },
    ] };
    try {
      const html = render(<CleanShell />);
      expect(html).toContain('aria-label="Ещё — все разделы. Новых: 107"');
      expect(html).toContain('aria-hidden="true">99+</span>');
      expect(html.replace(/<!-- -->/g, "")).toContain("Новых: 103");
      expect(html).toContain('href="/comments"');
      expect(html).toContain('href="/calls"');
    } finally { state.navigation = { main: [], all: [] }; }
  });
  it("keeps mobile legacy even with an explicit clean choice", () => {
    expect(cleanShellEnabled(true, true, "agent", true)).toBe(false);
    expect(cleanShellEnabled(true, false, "agent", true)).toBe(true);
    expect(cleanShellEnabled(false, false, "director", true)).toBe(false);
    expect(cleanShellEnabled(true, false, undefined, true)).toBe(false);
    expect(cleanShellEnabled(true, false, "director", false)).toBe(false);
    expect(cleanShellEnabled(true, false, "director")).toBe(false);
  });
  it("hides property creation for roles that cannot create, retains existing topbar", () => {
    state.create = false;
    expect(render(<CleanShell />)).not.toContain('href="/properties/new"');
    state.create = true;
    expect(render(<CleanShell />)).toContain('href="/properties/new"');
    expect(render(<CleanShell />)).toContain("Existing notifications and profile");
  });
  it("does not expose a mutation without its permission", () => {
    state.allowed = false;
    expect(render(<CleanDecisionRow row={row("property-1", async () => true)} photos={new Map()} />)).not.toContain('data-endpoint="/review"');
    state.allowed = true;
    expect(render(<CleanDecisionRow row={row("property-1", async () => true)} photos={new Map()} />)).toContain('data-endpoint="/review"');
  });
  it("records only successful batch members; continues after an exception", async () => {
    const failed = vi.fn(async () => { throw new Error("offline"); });
    const last = vi.fn(async () => true);
    const onFailure = vi.fn();
    const result = await runDecisionBatch([row("a", failed), row("b", async () => false), row("c", last)], onFailure);
    expect(result.map((entry) => entry.id)).toEqual(["c"]);
    expect(onFailure).toHaveBeenCalledWith(new Error("offline"));
    expect(last).toHaveBeenCalledTimes(1);
  });
});
