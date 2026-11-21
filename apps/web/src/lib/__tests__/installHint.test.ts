import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  INSTALL_HINT_SHOWN_KEY, INSTALL_HINT_VISITS_KEY, iosCanAddToHome, installHintShownBefore, installVisitCount,
  markInstallHintShown, resetInstallHintMemo, shouldOfferInstall, type InstallOfferInput,
} from "../installHint";

const ok: InstallOfferInput = { narrow: true, state: "available", iosCanAdd: false, visits: 3, dismissed: false, shownBefore: false };

describe("shouldOfferInstall: «Поставьте CRM на экран» — один раз и только когда можно (аудит К06.1)", () => {
  it("третий заход, телефон, системный диалог готов — предлагаем", () => {
    expect(shouldOfferInstall(ok)).toBe(true);
  });
  it("iPhone в Safari — предлагаем инструкцию", () => {
    expect(shouldOfferInstall({ ...ok, state: "ios", iosCanAdd: true })).toBe(true);
  });
  it("iPhone во встроенном просмотрщике (пункта «На экран Домой» там нет) — не предлагаем", () => {
    expect(shouldOfferInstall({ ...ok, state: "ios", iosCanAdd: false })).toBe(false);
  });
  it("установить нельзя или уже установлено — не предлагаем", () => {
    expect(shouldOfferInstall({ ...ok, state: "unavailable" })).toBe(false);
    expect(shouldOfferInstall({ ...ok, state: "installed" })).toBe(false);
  });
  it("широкий экран, «Не сейчас», показывалась раньше, ранние заходы — не предлагаем", () => {
    expect(shouldOfferInstall({ ...ok, narrow: false })).toBe(false);
    expect(shouldOfferInstall({ ...ok, dismissed: true })).toBe(false);
    expect(shouldOfferInstall({ ...ok, shownBefore: true })).toBe(false);
    expect(shouldOfferInstall({ ...ok, visits: 2 })).toBe(false);
  });
});

describe("iosCanAddToHome", () => {
  const SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1";
  const TELEGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
  const INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0 Safari/604.1";
  it("Safari и Chrome на iPhone — да; Telegram и Instagram внутри приложения — нет", () => {
    expect(iosCanAddToHome(SAFARI)).toBe(true);
    expect(iosCanAddToHome(CHROME)).toBe(true);
    expect(iosCanAddToHome(TELEGRAM)).toBe(false);
    expect(iosCanAddToHome(INSTAGRAM)).toBe(false);
  });
});

describe("память подсказки", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    resetInstallHintMemo();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
    });
  });

  it("заход считается один раз за загрузку, сколько бы раз ни монтировался компонент", () => {
    store.set(INSTALL_HINT_VISITS_KEY, "2");
    expect(installVisitCount()).toBe(3);
    expect(installVisitCount()).toBe(3);
    expect(store.get(INSTALL_HINT_VISITS_KEY)).toBe("3");
  });

  it("«показывалась раньше» читается один раз: в заходе, где подсказка показана, она остаётся на месте", () => {
    expect(installHintShownBefore()).toBe(false);
    markInstallHintShown();
    expect(store.get(INSTALL_HINT_SHOWN_KEY)).toBe("1");
    expect(installHintShownBefore()).toBe(false);
    resetInstallHintMemo(); // следующая загрузка
    expect(installHintShownBefore()).toBe(true);
  });

  it("нет хранилища (приватный режим) — не предлагаем, не падаем", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } });
    expect(installVisitCount()).toBe(0);
    expect(installHintShownBefore()).toBe(true);
    expect(() => markInstallHintShown()).not.toThrow();
  });
});
