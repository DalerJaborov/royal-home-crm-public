import { describe, expect, it } from "vitest";
import {
  outsideAreaAcceptedText, serviceAreaBuyerOffer, serviceAreaIn, serviceAreaOnly, RUDAKI_ERA_SERVICE_AREA_LINES, SERVICE_AREA_RU,
} from "../src/lib/serviceArea.js";
import { OPERATOR_PHRASES } from "../src/ai/operator/phrases.js";

/**
 * Владелец 19.11.2026: «Не нужно говорить, что мы работаем по Душанбе и Рудаки. Надо просто говорить, что мы
 * работаем по Душанбе, и всё». Клиентская фраза о зоне не называет район Рудаки; сам приём объектов района — не тронут.
 * Кириллица без \w и \b (CLAUDE.md, ai/wordBoundary.ts): слово ищем по корню в любом регистре.
 */
const RUDAKI_WORD = /р[уӯ]да[кқ]/iu;

describe("клиентские фразы зоны не называют Рудаки", () => {
  it.each(["ru", "tg"] as const)("функции зоны (%s)", language => {
    const phrases = [
      serviceAreaIn("Душанбе", language), serviceAreaOnly(language), serviceAreaBuyerOffer(language), outsideAreaAcceptedText(language),
    ];
    for (const phrase of phrases) expect(phrase).not.toMatch(RUDAKI_WORD);
    expect(serviceAreaIn("Душанбе", language)).toBe(language === "tg" ? "дар Душанбе" : "в Душанбе");
  });

  it("зона одной фразой — только Душанбе", () => {
    expect(SERVICE_AREA_RU).toBe("Душанбе");
  });

  it("фразы оператора приёма заявок (режим «только заявки»): ни одна не называет Рудаки, «где работаем» — Душанбе", () => {
    for (const [key, phrase] of Object.entries(OPERATOR_PHRASES)) {
      for (const language of ["ru", "tg"] as const) {
        for (const variant of phrase[language]) expect(variant, `${key} ${language}`).not.toMatch(RUDAKI_WORD);
      }
    }
    for (const language of ["ru", "tg"] as const) {
      for (const variant of OPERATOR_PHRASES.where_work[language]) expect(variant).toContain("Душанбе");
    }
  });

  it("старые фразы «…и районе Рудаки» остаются только как память о прошлых чатах", () => {
    expect(RUDAKI_ERA_SERVICE_AREA_LINES.length).toBeGreaterThan(0);
    for (const line of RUDAKI_ERA_SERVICE_AREA_LINES) expect(line).toMatch(RUDAKI_WORD);
  });
});
