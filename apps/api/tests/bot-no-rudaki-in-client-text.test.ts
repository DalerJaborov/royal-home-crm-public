import { describe, expect, it } from "vitest";
import {
  outsideAreaAcceptedText, serviceAreaBuyerOffer, serviceAreaIn, serviceAreaOnly, RUDAKI_ERA_SERVICE_AREA_LINES, SERVICE_AREA_RU,
} from "../src/lib/serviceArea.js";
import { leadOnlyReply } from "../src/ai/leadOnlyMode.js";

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

  it("шаблоны режима «только заявки», где звучит зона (продавец, WhatsApp и чат без номера)", () => {
    const base = { sellerCommissionPercent: 2, when: { kind: "soon" as const } };
    const phones = [{ kind: "whatsapp" as const }, { kind: "ask" as const, asksSoFar: 0, maxAsks: 2, officeAlreadyOffered: false }];
    for (const language of ["ru", "tg"] as const) {
      for (const phone of phones) {
        const text = leadOnlyReply({ ...base, scenario: "seller", language, phone });
        expect(text).toContain(serviceAreaIn("Душанбе", language));
        expect(text).not.toMatch(RUDAKI_WORD);
      }
    }
  });

  it("старые фразы «…и районе Рудаки» остаются только как память о прошлых чатах", () => {
    expect(RUDAKI_ERA_SERVICE_AREA_LINES.length).toBeGreaterThan(0);
    for (const line of RUDAKI_ERA_SERVICE_AREA_LINES) expect(line).toMatch(RUDAKI_WORD);
  });
});
