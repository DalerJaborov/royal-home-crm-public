import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canWriteAds } from "../adsView";

/**
 * Экран «Реклама» (глубокая проверка 02.10.2026, F10).
 * 1. «Сверить с кабинетом» была видна по finance.view, а сервер
 *    (routes/ads.ts, requireAdsWrite) пускает только MARKETING или finance.manage.
 * 2. При ошибке запроса шапка рисовала «потрачено 0,00 TJS · 0 обращений» —
 *    руководитель решал, что реклама стоит.
 */
describe("canWriteAds — как requireAdsWrite на сервере", () => {
  const perms = (list: string[]) => (p: string) => list.includes(p);
  it("маркетинг — да, без прав", () => expect(canWriteAds("MARKETING", perms([]))).toBe(true));
  it("finance.manage — да", () => expect(canWriteAds("DIRECTOR", perms(["finance.manage"]))).toBe(true));
  it("только finance.view — нет", () => expect(canWriteAds("MANAGER", perms(["finance.view"]))).toBe(false));
});

describe("шапка «Рекламы» при ошибке не рисует нули", () => {
  it("есть ветка board.isError с кнопкой «Повторить»", () => {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../pages/Ads.tsx");
    const text = fs.readFileSync(file, "utf8");
    expect(text).toMatch(/board\.isError/);
    expect(text).toMatch(/Повторить/);
  });
});
