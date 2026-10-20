import { describe, expect, it } from "vitest";
import { shouldRecordJobApplication } from "../src/ai/adTemplateOpener.js";

/**
 * ВОРОТА АНКЕТЫ (25.09.2026, аудит «кто вообще кандидат»).
 *
 * До правки анкета JobApplication писалась на ЛЮБОМ ходе, где модель вернула
 * поле jobApplication, независимо от намерения разговора — продавцы с рекламы
 * «приемка» попадали в кандидаты. Живые цифры аудита прод-базы: за 7 дней 72
 * анкеты, из них `leadDraft.intent` — job 29, sell 35, rent 3, other 4, buy 1.
 *
 * Чистая функция без базы: реальный ход с intent=sell и заполненным моделью
 * jobApplication проверяется через неё же — оба вызывающих места
 * (messengers/conversation.ts, telegram/bot.ts) зовут именно эту функцию, так
 * что тест здесь и есть проверка «ворот» на живом сценарии.
 */
describe("shouldRecordJobApplication — писать анкету только на разговоре о работе", () => {
  it("intent=job — пишем", () => {
    expect(shouldRecordJobApplication("job", null)).toBe(true);
  });

  it("adTopic=job (реклама вакансии) — пишем, даже если модель ещё не определилась с intent", () => {
    expect(shouldRecordJobApplication(null, "job")).toBe(true);
    expect(shouldRecordJobApplication(undefined, "job")).toBe(true);
  });

  it("живой случай аудита: intent=sell (продавец с рекламы «приемка»), jobApplication всё равно пришло — НЕ пишем", () => {
    expect(shouldRecordJobApplication("sell", null)).toBe(false);
    expect(shouldRecordJobApplication("sell", "property")).toBe(false);
    expect(shouldRecordJobApplication("sell", "seller")).toBe(false);
  });

  it("прочие намерения без рекламы вакансии — не пишем", () => {
    expect(shouldRecordJobApplication("buy", null)).toBe(false);
    expect(shouldRecordJobApplication("rent", null)).toBe(false);
    expect(shouldRecordJobApplication("other", null)).toBe(false);
    expect(shouldRecordJobApplication(null, null)).toBe(false);
    expect(shouldRecordJobApplication(undefined, undefined)).toBe(false);
  });
});
