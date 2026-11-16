import { describe, expect, it } from "vitest";
import {
  aiEstimateNote, aiLogVendor, autoExpenseOverlapText, findAutoExpenseOverlap, founderContributionTotals, founderOfContributionText,
  manualExpenseVendor, splitAiEstimate, vendorOfText,
} from "@royal-home/shared";

/**
 * Подписки с поставщиком и взносы учредителей (17.11.2026). Владелец 14.11: «добавить это всё
 * автоматически, все подписки, включая синюю галочку… Взнос от учредителей… Баходур. Илхом. Мирсаид».
 * Случай октября 2026: оценка ИИ ≈ 33 $ Gemini + счёт «ОПЛАТА ИИ» 2 000 с. — Gemini учтён дважды.
 */

const RATE = 9.24;

describe("поставщик по словам строки", () => {
  it("узнаёт подписки, которые есть у компании", () => {
    expect(vendorOfText("Оплата Gemini за ноябрь")).toBe("GEMINI");
    expect(vendorOfText("джемини")).toBe("GEMINI");
    expect(vendorOfText("Синяя галочка Instagram")).toBe("META_VERIFIED");
    expect(vendorOfText("Meta Verified")).toBe("META_VERIFIED");
    expect(vendorOfText("ElevenLabs Creator")).toBe("ELEVENLABS");
    expect(vendorOfText("ChatGPT Plus")).toBe("OPENAI");
    expect(vendorOfText("Claude Max")).toBe("ANTHROPIC");
    expect(vendorOfText("Сервер Hetzner")).toBe("SERVER");
  });

  it("«ОПЛАТА ИИ» без названия сервиса поставщиком не считается (непонятно, чей счёт)", () => {
    expect(vendorOfText("ОПЛАТА ИИ")).toBeNull();
    expect(manualExpenseVendor({ note: "ОПЛАТА ИИ", counterparty: null })).toBeNull();
    expect(vendorOfText("Вода для кулера")).toBeNull();
  });

  it("в ручную строку по словам пишется только поставщик ИИ; выбранный человеком — любой", () => {
    expect(manualExpenseVendor({ note: "Оплата Gemini", counterparty: null })).toBe("GEMINI");
    expect(manualExpenseVendor({ note: "Сервер", counterparty: null })).toBeNull();
    expect(manualExpenseVendor({ vendor: "SERVER", note: "Сервер", counterparty: null })).toBe("SERVER");
  });

  it("поставщик обращения в журнале ИИ — по provider или по модели для старых записей", () => {
    expect(aiLogVendor("google", null)).toBe("GEMINI");
    expect(aiLogVendor(null, "gemini-3.5-flash")).toBe("GEMINI");
    expect(aiLogVendor(null, "gpt-image-1")).toBe("OPENAI");
    expect(aiLogVendor(null, "claude-sonnet-4")).toBe("ANTHROPIC");
    expect(aiLogVendor("elevenlabs", "eleven_v3")).toBe("ELEVENLABS");
    expect(aiLogVendor(null, "deepseek-chat")).toBe("DEEPSEEK");
    expect(aiLogVendor(null, "unknown-model")).toBeNull();
  });
});

describe("счёт поставщика сильнее оценки ИИ", () => {
  const october = [
    { provider: "google", model: "gemini-3.5-flash", costUsd: 30.1 },
    { provider: null, model: "gemini-2.5-flash", costUsd: 3.3 },
    { provider: "openai", model: "gpt-image-1", costUsd: 11.8 },
    { provider: null, model: "unknown", costUsd: 0.05 },
  ];

  it("без счетов оценка считается целиком, как раньше", () => {
    const split = splitAiEstimate(october, []);
    expect(split.countedCents).toBe(4525);
    expect(split.coveredCents).toBe(0);
    expect(aiEstimateNote(split)).not.toContain("Не считаем");
  });

  it("есть счёт Gemini — Gemini в оценку не идёт, OpenAI и неизвестное остаются", () => {
    const split = splitAiEstimate(october, ["GEMINI"]);
    expect(split.coveredVendors).toEqual(["GEMINI"]);
    expect(split.coveredCents).toBe(3340);
    expect(split.countedCents).toBe(1185);
    const note = aiEstimateNote(split);
    expect(note).toContain("Gemini");
    expect(note).toContain("33.40 $");
    expect(note).not.toContain("—");
  });

  it("счёт не-ИИ поставщика оценку не трогает", () => {
    expect(splitAiEstimate(october, ["META_VERIFIED"]).countedCents).toBe(4525);
  });
});

describe("подписка с поставщиком против ручной строки", () => {
  const gemini = { autoKey: "rec:tpl-g:2026-11-05", category: "OTHER", amount: 20, currency: "USD", exchangeRate: 10.9, agentId: null, source: null, vendor: "GEMINI" };
  const verified = { autoKey: "rec:tpl-v:2026-11-01", category: "OTHER", amount: 160, currency: "TJS", exchangeRate: 1, agentId: null, source: null, vendor: "META_VERIFIED" };
  const aiEstimate = { autoKey: "ai:2026-11", category: "OTHER", amount: 12, currency: "USD", exchangeRate: null, agentId: null, source: null };

  it("ручная «Оплата Gemini» при подписке Gemini — «уже учтено» при любой сумме", () => {
    const overlap = findAutoExpenseOverlap({ category: "OTHER", note: "Оплата Gemini", amount: 2000, currency: "TJS" }, [gemini, verified, aiEstimate], RATE);
    expect(overlap).toMatchObject({ kind: "subscription", autoKey: gemini.autoKey, vendor: "GEMINI" });
    const text = autoExpenseOverlapText(overlap!, "2026-11");
    expect(text).toContain("Gemini");
    expect(text).toContain("ноябрь 2026");
    expect(text).not.toContain("—");
  });

  it("«синяя галочка» находит подписку Meta Verified, а не рекламу", () => {
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "Синяя галочка", amount: 160, currency: "TJS" }, [gemini, verified], RATE)?.vendor).toBe("META_VERIFIED");
  });

  it("счёт Gemini без подписки не спорит с оценкой ИИ (оценка снимется сама); «Оплата ИИ» — спорит", () => {
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "Оплата Gemini", amount: 2000, currency: "TJS" }, [aiEstimate], RATE)).toBeNull();
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "ОПЛАТА ИИ", amount: 2000, currency: "TJS" }, [aiEstimate], RATE)?.kind).toBe("ai");
  });

  it("другой сервис при подписке Gemini — не повтор", () => {
    expect(findAutoExpenseOverlap({ category: "OTHER", note: "Вода для кулера", amount: 60, currency: "TJS" }, [gemini, verified], RATE)).toBeNull();
  });
});

describe("взносы учредителей", () => {
  const founders = [
    { id: "b", name: "Баходур", sortOrder: 1, deleted: false },
    { id: "i", name: "Илхом", sortOrder: 2, deleted: false },
    { id: "m", name: "Мирсаид", sortOrder: 3, deleted: false },
    { id: "x", name: "Старый", sortOrder: 4, deleted: true },
    { id: "y", name: "Удалённый без истории", sortOrder: 5, deleted: true },
  ];

  it("итоги за месяц и за всё время по каждому; удалённый с историей остаётся, без истории — нет", () => {
    const totals = founderContributionTotals(founders, [
      { founderId: "b", amount: 5000, currency: "TJS", exchangeRate: 1, month: "2026-11" },
      { founderId: "b", amount: 100, currency: "USD", exchangeRate: 10, month: "2026-10" },
      { founderId: "i", amount: 3000, currency: "TJS", exchangeRate: 1, month: "2026-11" },
      { founderId: "x", amount: 700, currency: "TJS", exchangeRate: 1, month: "2026-09" },
      { founderId: "m", amount: 50, currency: "USD", exchangeRate: null, month: "2026-11" },
    ], "2026-11", RATE);
    expect(totals.founders.map((f) => f.name)).toEqual(["Баходур", "Илхом", "Мирсаид", "Старый"]);
    expect(totals.founders[0]).toMatchObject({ monthTjs: 5000, allTimeTjs: 6000, monthCount: 1, allTimeCount: 2 });
    expect(totals.founders[2]).toMatchObject({ monthTjs: 462, allTimeTjs: 462 });
    expect(totals.founders[3]).toMatchObject({ deleted: true, monthTjs: 0, allTimeTjs: 700 });
    expect(totals.monthTjs).toBe(8462);
    expect(totals.allTimeTjs).toBe(9162);
  });

  it("строка отчёта «взнос Баходура» — взнос; имя без слова «взнос» — нет", () => {
    expect(founderOfContributionText("Взнос от Баходура", founders)?.id).toBe("b");
    expect(founderOfContributionText("вклад Илхом", founders)?.id).toBe("i");
    expect(founderOfContributionText("Мирсаид вложил", founders)?.id).toBe("m");
    expect(founderOfContributionText("такси Илхому", founders)).toBeNull();
    expect(founderOfContributionText("взнос Старый", founders)).toBeNull();
  });
});
