// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAuthStore } from "../../store/auth";
import { royalLookEnabled, royalLookOverride, useLookAttribute, useRoyalLookChoice } from "../useRoyalLook";

const at = (url: string) => ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[url]}>{children}</MemoryRouter>;

beforeEach(() => {
  window.localStorage.clear();
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
    expect(window.localStorage.getItem("rh-look:owner")).toBeNull();
  });

  it("личный выход запоминается на учётку и снимается обратно", () => {
    const off = renderHook(() => useRoyalLookChoice(true), { wrapper: at("/?look=legacy") });
    expect(off.result.current).toBe(false);
    expect(window.localStorage.getItem("rh-look:owner")).toBe("legacy");
    off.unmount();
    expect(renderHook(() => useRoyalLookChoice(true), { wrapper: at("/") }).result.current).toBe(false);
    expect(renderHook(() => useRoyalLookChoice(true), { wrapper: at("/?look=royal") }).result.current).toBe(true);
    expect(window.localStorage.getItem("rh-look:owner")).toBe("royal");
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
