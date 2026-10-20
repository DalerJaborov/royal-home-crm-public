import { describe, expect, it } from "vitest";
import {
  clientSpeechOf,
  normalizeForQuoteMatch,
  quoteIsInTranscript,
  withQuoteNotConfirmedNote,
} from "../src/ai/callQuoteCheck.js";
import { normalizePostShowingCallParse } from "../src/ai/postShowingCallParse.js";
import { normalizeSellerProbeParse } from "../src/ai/sellerProbeCallParse.js";

/**
 * ПРОВЕРКА «ДОСЛОВНОЙ» ЦИТАТЫ ПО РАСШИФРОВКЕ (аудит звонков робота 02.10.2026, А3).
 * Чистые функции, без базы: что считается найденной цитатой, а что — выдумкой.
 */

describe("quoteIsInTranscript", () => {
  const transcript = [
    "Бот: Здравствуйте! Как прошёл показ?",
    "Клиент: Да, ничего, но агент мне дал свой личный номер,",
    "Клиент: и сказал, звоните напрямую",
    "[звонящий молчит — бот переспросил, слышно ли его]",
  ];

  it("цитата из слов клиента находится — без учёта регистра, знаков и «ё»", () => {
    expect(quoteIsInTranscript("Агент мне дал свой личный номер", transcript)).toBe(true);
    expect(quoteIsInTranscript("«дал свой личный номер, и сказал: звоните напрямую»", transcript)).toBe(true);
    expect(normalizeForQuoteMatch("Ёлка, ёж!")).toBe("елка еж");
    expect(quoteIsInTranscript("Ёлка", ["Клиент: елка стоит"])).toBe(true);
  });

  it("реплики бота и служебные пометки цитатой клиента не считаются", () => {
    expect(quoteIsInTranscript("Как прошёл показ", transcript)).toBe(false);
    expect(quoteIsInTranscript("слышно ли его", transcript)).toBe(false);
    expect(clientSpeechOf(transcript)).not.toContain("Здравствуйте");
  });

  it("выдуманная фраза и пустая цитата — не найдены", () => {
    expect(quoteIsInTranscript("он грубил и опоздал на час", transcript)).toBe(false);
    expect(quoteIsInTranscript("", transcript)).toBe(false);
    expect(quoteIsInTranscript(null, transcript)).toBe(false);
    expect(quoteIsInTranscript("что угодно", [])).toBe(false);
  });

  it("многоточие делит цитату на куски, которые должны идти по порядку", () => {
    expect(quoteIsInTranscript("дал свой личный номер … звоните напрямую", transcript)).toBe(true);
    expect(quoteIsInTranscript("звоните напрямую ... дал свой личный номер", transcript)).toBe(false);
  });

  it("помета в сводке", () => {
    expect(withQuoteNotConfirmedNote(null)).toBe("[цитата не подтверждена расшифровкой]");
    expect(withQuoteNotConfirmedNote("Жалоба")).toBe("Жалоба [цитата не подтверждена расшифровкой]");
  });
});

describe("нормализация разбора с расшифровкой", () => {
  const transcript = ["Клиент: нормально всё, квартира маленькая"];

  it("опрос покупателя: красный исход с цитатой не из расшифровки понижается, цитата не сохраняется", () => {
    const r = normalizePostShowingCallParse(
      { outcome: "AGENT_COMPLAINT", confidence: 0.95, quote: "он мне грубил", summary: "Жалоба" },
      transcript
    );
    expect(r).toMatchObject({ outcome: "UNCLEAR", quote: null });
    expect(r.summary).toContain("цитата не подтверждена");
  });

  it("опрос покупателя: обычный исход остаётся, но выдуманная цитата не сохраняется", () => {
    const r = normalizePostShowingCallParse(
      { outcome: "NOT_SUITABLE", confidence: 0.9, quote: "кухня тесная", summary: "Маленькая" },
      transcript
    );
    expect(r).toMatchObject({ outcome: "NOT_SUITABLE", quote: null });
  });

  it("без расшифровки (старые вызовы) поведение прежнее", () => {
    expect(
      normalizePostShowingCallParse({ outcome: "BYPASS", confidence: 0.9, quote: "дал номер", summary: "x" }).outcome
    ).toBe("BYPASS");
  });

  it("проверка собственника: «продал» без подтверждённой цитаты — «непонятно»", () => {
    const r = normalizeSellerProbeParse(
      { outcome: "SOLD_ELSEWHERE", confidence: 0.99, quote: "я продал квартиру", summary: "Продал" },
      transcript
    );
    expect(r).toMatchObject({ outcome: "UNCLEAR", quote: null });
    expect(
      normalizeSellerProbeParse(
        { outcome: "STILL_SELLING", confidence: 0.9, quote: "я продал квартиру", summary: "В продаже" },
        transcript
      )
    ).toMatchObject({ outcome: "STILL_SELLING", quote: null });
  });
});
