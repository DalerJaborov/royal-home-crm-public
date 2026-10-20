import { describe, expect, it } from "vitest";
import { canAutomationChangeKind } from "../src/lib/kindChangePolicy.js";

/**
 * ТИП МЕНЯЕТ ЧЕЛОВЕК, ИИ ТОЛЬКО ПРЕДЛАГАЕТ (владелец 21.09.2026).
 *
 * Чистая функция, без базы — три писателя (newInquiryDetector.ts,
 * qualifyIncoming.ts, services/leads/intake.ts::kindChangeUpdate) спрашивают
 * ТОЛЬКО её, поэтому весь смысл правила проверяется здесь одним файлом.
 */
describe("canAutomationChangeKind", () => {
  it("не принятая карточка (acceptedAt=null) — автоматика вправе поправить тип", () => {
    expect(
      canAutomationChangeKind({ acceptedAt: null, currentKind: "SELLER", nextKind: "BUYER" })
    ).toBe(true);
  });

  it("принятая карточка — автоматика НЕ меняет тип сама (живой случай 18.09: продавец молча стал покупателем)", () => {
    expect(
      canAutomationChangeKind({ acceptedAt: new Date(), currentKind: "SELLER", nextKind: "BUYER" })
    ).toBe(false);
  });

  it("принятая карточка, обратное направление — тоже нельзя (симметрично)", () => {
    expect(
      canAutomationChangeKind({ acceptedAt: new Date(), currentKind: "BUYER", nextKind: "SELLER" })
    ).toBe(false);
  });

  it("принятая карточка, смена в OTHER — тоже нельзя: это не только BUYER↔SELLER", () => {
    expect(
      canAutomationChangeKind({ acceptedAt: new Date(), currentKind: "BUYER", nextKind: "OTHER" })
    ).toBe(false);
  });

  it("тот же самый kind — менять нечего, разрешено независимо от acceptedAt", () => {
    expect(
      canAutomationChangeKind({ acceptedAt: new Date(), currentKind: "BUYER", nextKind: "BUYER" })
    ).toBe(true);
    expect(
      canAutomationChangeKind({ acceptedAt: null, currentKind: "SELLER", nextKind: "SELLER" })
    ).toBe(true);
  });

  it("не принятая карточка — разрешено в любую сторону, включая OTHER", () => {
    expect(
      canAutomationChangeKind({ acceptedAt: null, currentKind: "OTHER", nextKind: "SELLER" })
    ).toBe(true);
    expect(
      canAutomationChangeKind({ acceptedAt: null, currentKind: "BUYER", nextKind: "OTHER" })
    ).toBe(true);
  });
});
