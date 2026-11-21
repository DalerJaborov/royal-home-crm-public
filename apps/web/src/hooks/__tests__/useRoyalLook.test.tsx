// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAuthStore } from "../../store/auth";
import { DEVICE_LOOK_KEY, deviceLookRemembered, royalLookEnabled, royalLookOverride, useDeviceLookMemory, useLookAttribute, useRoyalLookChoice } from "../useRoyalLook";

const at = (url: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useAuthStore.setState({ agent: { id: "owner", fullName: "Тест Владелец", role: "ADMIN" } as never });
});
afterEach(() => { delete document.documentElement.dataset.uiLook; delete document.documentElement.dataset.look; });

describe("«Новый вид»: решение закрыто по умолчанию", () => {
  it("без разрешения сервера вид не включается ни адресом, ни сохранённым выбором", () => {
    expect(royalLookEnabled(false, true, true)).toBe(false);
    expect(royalLookEnabled(false, undefined, undefined)).toBe(false);
    expect(royalLookEnabled(true, undefined, undefined)).toBe(true);
    expect(royalLookEnabled(true, false, true)).toBe(false);
    expect(royalLookEnabled(true, undefined, false)).toBe(false);
  });

  it("читает только ?look=royal и ?look=legacy", () => {
    expect(royalLookOverride("?look=royal")).toBe(true);
    expect(royalLookOverride("?look=legacy")).toBe(false);
    expect(royalLookOverride("?look=dark")).toBeUndefined();
    expect(royalLookOverride("")).toBeUndefined();
  });

  it("?look=royal у сотрудника без разрешения ничего не включает и не запоминает", () => {
    const { result } = renderHook(() => useRoyalLookChoice(false), { wrapper: at("/?look=royal") });
    expect(result.current).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("личный аварийный выход держится на вкладке (sessionStorage), не навсегда, и снимается обратно", () => {
    const off = renderHook(() => useRoyalLookChoice(true), { wrapper: at("/?look=legacy") });
    expect(off.result.current).toBe(false);
    expect(window.sessionStorage.getItem("rh-look-optout:owner")).toBe("1");
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("rh-"))).toEqual([]);
    off.unmount();
    expect(renderHook(() => useRoyalLookChoice(true), { wrapper: at("/") }).result.current).toBe(false);
    expect(renderHook(() => useRoyalLookChoice(true), { wrapper: at("/?look=royal") }).result.current).toBe(true);
    expect(window.sessionStorage.getItem("rh-look-optout:owner")).toBeNull();
    expect(renderHook(() => useRoyalLookChoice(true), { wrapper: at("/") }).result.current).toBe(true);
  });
});

describe("атрибут data-ui-look на <html>", () => {
  it("без признака не ставится (data-look остаётся за настройкой «вид» uiPrefs), с признаком ставится и снимается при выключении и выходе", () => {
    // data-look занят личной настройкой «вид» (store/uiPrefs.ts) — его не трогаем никогда.
    document.documentElement.dataset.look = "classic";
    const hook = renderHook((royal: boolean) => useLookAttribute(royal), { initialProps: false });
    expect(document.documentElement.dataset.uiLook).toBeUndefined();
    hook.rerender(true);
    expect(document.documentElement.dataset.uiLook).toBe("royal");
    hook.rerender(false);
    expect(document.documentElement.dataset.uiLook).toBeUndefined();
    hook.rerender(true);
    hook.unmount();
    expect(document.documentElement.dataset.uiLook).toBeUndefined();
    expect(document.documentElement.dataset.look).toBe("classic");
  });
});

describe("флаг устройства для входа и страниц по ссылке (пачка records)", () => {
  it("ставится при новом виде, снимается, когда ответ сервера пришёл без вида; загрузка флаг не трогает", () => {
    const hook = renderHook(({ royal, pending }: { royal: boolean; pending: boolean }) => useDeviceLookMemory(royal, pending), { initialProps: { royal: false, pending: true } });
    expect(window.localStorage.getItem(DEVICE_LOOK_KEY)).toBeNull();
    hook.rerender({ royal: true, pending: false });
    expect(deviceLookRemembered()).toBe(true);
    // следующий заход: ответ ещё не пришёл — флаг остаётся
    hook.rerender({ royal: false, pending: true });
    expect(deviceLookRemembered()).toBe(true);
    // ответ без вида (выключили, отказ, ошибка) — флаг снят
    hook.rerender({ royal: false, pending: false });
    expect(window.localStorage.getItem(DEVICE_LOOK_KEY)).toBeNull();
    hook.unmount();
  });

  it("выход из учётки снимает флаг сразу", () => {
    const hook = renderHook(() => useDeviceLookMemory(true, false));
    expect(deviceLookRemembered()).toBe(true);
    useAuthStore.setState({ agent: null });
    expect(deviceLookRemembered()).toBe(false);
    hook.unmount();
  });

  it("закрытое хранилище — флага нет, без ошибки", () => {
    expect(deviceLookRemembered({ getItem: () => { throw new Error("SecurityError"); } })).toBe(false);
    expect(deviceLookRemembered(null)).toBe(false);
  });
});
