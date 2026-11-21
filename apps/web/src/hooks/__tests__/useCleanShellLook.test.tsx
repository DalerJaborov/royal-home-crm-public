// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ api: 0 }));
vi.mock("../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/api")>(),
  api: async () => { calls.api += 1; throw new Error("no request expected"); },
}));

import { ROLES } from "@royal-home/shared";
import { useAuthStore } from "../../store/auth";
import { useCleanShellSelection } from "../useCleanShell";
import { legacyAgentMobileActive } from "../useLegacyAgentMobile";
import { forgetRetiredLookKeys } from "../royalLookChoice";

/**
 * НОВЫЙ ИНТЕРФЕЙС ДЛЯ ВСЕХ (владелец 21.11.2026). Сторож: любой роли и на любом
 * устройстве — чистая оболочка и «Новый вид» с первого кадра, без запроса на старте;
 * выйти можно только адресом `?look=legacy` (на вкладку) и вернуться `?look=royal`.
 */
function at(url: string) {
  return ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;
}

beforeEach(() => {
  calls.api = 0;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("новый интерфейс для всех", () => {
  it.each(ROLES)("%s: чистая оболочка и новый вид сразу, без ожидания и без запроса", (role) => {
    useAuthStore.setState({ agent: { id: `id-${role}`, fullName: "Тест", role } as never });
    const { result } = renderHook(() => useCleanShellSelection(true), { wrapper: at("/") });
    expect(result.current).toEqual({ clean: true, look: "royal", pending: false });
    expect(calls.api).toBe(0);
  });

  it("агент на телефоне больше не получает прежний телефонный интерфейс", () => {
    expect(legacyAgentMobileActive(true, "AGENT", true)).toBe(false);
  });

  it("старые сохранённые отказы (`rh-shell:*=legacy`, `rh-look:*=legacy`) ничего не решают и стираются", () => {
    useAuthStore.setState({ agent: { id: "a1", fullName: "Тест", role: "AGENT" } as never });
    window.localStorage.setItem("rh-shell:a1", "legacy");
    window.localStorage.setItem("rh-look:a1", "legacy");
    window.localStorage.setItem("rh-look-granted:a1", "1");
    window.localStorage.setItem("rh-theme", "dark");
    expect(renderHook(() => useCleanShellSelection(), { wrapper: at("/") }).result.current.clean).toBe(true);
    forgetRetiredLookKeys();
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("rh-")).sort()).toEqual(["rh-theme"]);
  });

  it("аварийный выход `?look=legacy` — прежний интерфейс на этой вкладке, `?look=royal` — обратно", () => {
    useAuthStore.setState({ agent: { id: "a2", fullName: "Тест", role: "AGENT" } as never });
    expect(renderHook(() => useCleanShellSelection(), { wrapper: at("/?look=legacy") }).result.current).toEqual({ clean: false, pending: false });
    // Переход внутри приложения теряет параметр — выбор держится на вкладке.
    expect(renderHook(() => useCleanShellSelection(), { wrapper: at("/clients") }).result.current.clean).toBe(false);
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("rh-"))).toEqual([]);
    expect(renderHook(() => useCleanShellSelection(), { wrapper: at("/?look=royal") }).result.current.clean).toBe(true);
    expect(renderHook(() => useCleanShellSelection(), { wrapper: at("/clients") }).result.current.clean).toBe(true);
  });

  it("без входа — прежнее поведение (оболочку решать не для кого)", () => {
    useAuthStore.setState({ agent: null } as never);
    expect(renderHook(() => useCleanShellSelection(), { wrapper: at("/") }).result.current.clean).toBe(false);
  });
});
