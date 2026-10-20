import { describe, expect, it } from "vitest";
import {
  normalizePostShowingCallParse,
  POST_SHOWING_CALL_CONFIDENCE_MIN,
  POST_SHOWING_CALL_RED_OUTCOMES,
} from "../src/ai/postShowingCallParse.js";

/**
 * РАЗБОР РАЗГОВОРА ПОСЛЕ ПОКАЗА — правила понижения исхода.
 *
 * Сам вызов модели тестами не покрывается (сеть), а вот что система делает с
 * ЛЮБЫМ её ответом — покрывается целиком: именно здесь решается, дойдёт ли до
 * руководителя обвинение сотрудника и на каком основании.
 */

const ok = { confidence: 0.95, quote: "он сказал, давайте напрямую, без агентства", summary: "с." };

describe("порог уверенности", () => {
  it("уверенный обычный исход проходит как есть", () => {
    const r = normalizePostShowingCallParse({ outcome: "NOT_SUITABLE", confidence: 0.9, summary: "маленькая" });
    expect(r.outcome).toBe("NOT_SUITABLE");
  });

  it("ниже порога — «непонятно», а не догадка", () => {
    const r = normalizePostShowingCallParse({
      outcome: "NOT_SUITABLE",
      confidence: POST_SHOWING_CALL_CONFIDENCE_MIN - 0.01,
    });
    expect(r.outcome).toBe("UNCLEAR");
  });

  // Аудит 02.10.2026, №8: поле необязательное для модели, и раньше его пропуск
  // превращал «да, понравилось» в «ответ непонятен».
  it("уверенность не названа — обычный исход засчитывается как есть", () => {
    const r = normalizePostShowingCallParse({ outcome: "LIKED", summary: "понравилось" });
    expect(r.outcome).toBe("LIKED");
    expect(r.confidence).toBeNull();
  });

  it("уверенность не названа у обвинения — обвинения нет и так", () => {
    expect(normalizePostShowingCallParse({ outcome: "BYPASS", quote: ok.quote }).outcome).toBe("UNCLEAR");
  });

  it("уверенность негодная (вне 0..1) — обычный исход не засчитывается", () => {
    expect(normalizePostShowingCallParse({ outcome: "LIKED", confidence: 7 }).outcome).toBe("UNCLEAR");
  });
});

describe("красные исходы", () => {
  it("с цитатой и уверенностью — проходят", () => {
    for (const outcome of POST_SHOWING_CALL_RED_OUTCOMES) {
      expect(normalizePostShowingCallParse({ outcome, ...ok }).outcome).toBe(outcome);
    }
  });

  it("без дословной цитаты обвинения не будет", () => {
    for (const outcome of POST_SHOWING_CALL_RED_OUTCOMES) {
      const r = normalizePostShowingCallParse({ outcome, confidence: 0.99 });
      expect(r.outcome).toBe("UNCLEAR");
    }
  });

  it("цитата есть, а уверенности нет — тоже не обвиняем", () => {
    const r = normalizePostShowingCallParse({ outcome: "AGENT_COMPLAINT", confidence: 0.4, quote: "ну не знаю" });
    expect(r.outcome).toBe("UNCLEAR");
  });

  it("понижение исхода не стирает пометки и сводку — человек их прочитает", () => {
    const r = normalizePostShowingCallParse({
      outcome: "AGENT_COMPLAINT",
      confidence: 0.5,
      redFlags: ["опоздал"],
      summary: "жаловался, что ждал",
    });
    expect(r.outcome).toBe("UNCLEAR");
    expect(r.redFlags).toEqual(["опоздал"]);
    expect(r.summary).toBe("жаловался, что ждал");
  });
});

describe("мусор от модели", () => {
  it("незнакомый исход — «непонятно», а не падение", () => {
    expect(normalizePostShowingCallParse({ outcome: "ОЧЕНЬ_ПЛОХО", confidence: 0.9 }).outcome).toBe("UNCLEAR");
  });

  it("пустой ответ — «непонятно»", () => {
    expect(normalizePostShowingCallParse({}).outcome).toBe("UNCLEAR");
  });

  it("уверенность вне диапазона не засчитывается", () => {
    expect(normalizePostShowingCallParse({ outcome: "LIKED", confidence: 7 }).confidence).toBeNull();
  });

  it("пометки чистятся от пустых строк и не растут бесконечно", () => {
    const r = normalizePostShowingCallParse({
      outcome: "NOT_SUITABLE",
      confidence: 0.9,
      redFlags: ["опоздал", "  ", ...Array.from({ length: 15 }, (_, i) => `флаг ${i}`)],
    });
    expect(r.redFlags).not.toContain("  ");
    expect(r.redFlags.length).toBeLessThanOrEqual(10);
  });
});
