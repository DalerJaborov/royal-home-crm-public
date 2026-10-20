import { describe, expect, it } from "vitest";
import { guideOfferPromptRule, guideOfferSchemaField, parseGuideOffer } from "../src/ai/guideOffer.js";

/**
 * Гид покупателя зависит от канала (найдено 20.08.2026 при аудите промтов).
 *
 * sendBuyerGuide (lib/buyerGuide.ts) обслуживает только Meta-каналы — Telegram
 * файл не получает вовсе, telegram/bot.ts даже не вызывает функцию отправки.
 * Раньше промт и поле схемы были безусловными: бот в Telegram писал «отправил
 * файл» и не отправлял ничего. Тот же баг, что уже чинили для фотографий
 * (photoOffer.ts) — здесь та же защита: канал не умеет — поля нет вовсе, а
 * промт прямо запрещает писать про отправку.
 */

describe("поле схемы sendGuide зависит от канала", () => {
  it("канал умеет — поле есть", () => {
    expect(guideOfferSchemaField(true)).toHaveProperty("sendGuide");
  });

  it("канал не умеет — поля нет вовсе, а не просто «не заполняй»", () => {
    // Пустой объект, а не поле с пометкой «недоступно»: модель физически не может
    // передать sendGuide=true через инструмент, если поля нет в схеме.
    expect(guideOfferSchemaField(false)).toEqual({});
  });
});

describe("правило в промте зависит от канала", () => {
  it("канал умеет — модель может пообещать файл, будто уже отправила", () => {
    const rule = guideOfferPromptRule(true);
    expect(rule).toContain("sendGuide=true");
    expect(rule).toContain("Отправил, там всё подробно");
  });

  it("канал не умеет — прямой запрет писать про отправку файла", () => {
    const rule = guideOfferPromptRule(false);
    expect(rule).toContain("ОТПРАВИТЬ НЕЛЬЗЯ");
    expect(rule).toContain("НИКОГДА не пиши");
    expect(rule).toContain("отвечай СЛОВАМИ");
    // Поля sendGuide в этом канале нет — промт не должен намекать на его существование.
    expect(rule).not.toContain("sendGuide=true");
  });
});

describe("parseGuideOffer", () => {
  it("только буквальный true — решение бинарное", () => {
    expect(parseGuideOffer(true)).toBe(true);
    expect(parseGuideOffer(false)).toBe(false);
    expect(parseGuideOffer("true")).toBe(false);
    expect(parseGuideOffer(1)).toBe(false);
    expect(parseGuideOffer(undefined)).toBe(false);
  });
});

describe("модель написала «отправил», а файл не ушёл (CHANNEL-NEW-27)", () => {
  it("файл не ушёл: из ответа уходит предложение об отправке, суть остаётся", async () => {
    const { reconcileGuideClaim } = await import("../src/ai/guideOffer.js");
    const fixed = reconcileGuideClaim(
      { reply: "Смотрите на двор, электрику и воду. Отправил, там всё подробно.", reply2: undefined },
      { sendRequested: true, guideSent: false, alreadySentBefore: false, language: "ru" }
    );
    expect(fixed.reply).toBe("Смотрите на двор, электрику и воду.");
  });

  it("файл ушёл — текст без изменений", async () => {
    const { reconcileGuideClaim } = await import("../src/ai/guideOffer.js");
    const text = "Смотрите на двор. Отправил, там всё подробно.";
    const fixed = reconcileGuideClaim(
      { reply: text, reply2: "Фиристодам" },
      { sendRequested: true, guideSent: true, alreadySentBefore: false, language: "ru" }
    );
    expect(fixed).toEqual({ reply: text, reply2: "Фиристодам" });
  });

  it("файл не просили или он уходил раньше — текст без изменений", async () => {
    const { reconcileGuideClaim } = await import("../src/ai/guideOffer.js");
    const text = "Отправил, там всё подробно.";
    expect(
      reconcileGuideClaim({ reply: text }, { sendRequested: false, guideSent: false, alreadySentBefore: false, language: "ru" }).reply
    ).toBe(text);
    expect(
      reconcileGuideClaim({ reply: text }, { sendRequested: true, guideSent: false, alreadySentBefore: true, language: "ru" }).reply
    ).toBe(text);
  });

  it("остались одни слова об отправке: нейтральная фраза на языке клиента, а не обман и не пустота", async () => {
    const { reconcileGuideClaim } = await import("../src/ai/guideOffer.js");
    const ru = reconcileGuideClaim(
      { reply: "Отправил, там всё подробно." },
      { sendRequested: true, guideSent: false, alreadySentBefore: false, language: "ru" }
    );
    expect(ru.reply).not.toMatch(/отправил/i);
    expect(ru.reply?.length).toBeGreaterThan(10);
    const tg = reconcileGuideClaim(
      { reply: "Фиристодам, дар он ҳамааш нависта шудааст." },
      { sendRequested: true, guideSent: false, alreadySentBefore: false, language: "tg" }
    );
    expect(tg.reply).not.toMatch(/фиристод/i);
  });

  it("вторая реплика с обещанием тоже чистится", async () => {
    const { reconcileGuideClaim } = await import("../src/ai/guideOffer.js");
    const fixed = reconcileGuideClaim(
      { reply: "Документы собственника, нотариус, задаток.", reply2: "Файл уже отправил вам." },
      { sendRequested: true, guideSent: false, alreadySentBefore: false, language: "ru" }
    );
    expect(fixed.reply).toBe("Документы собственника, нотариус, задаток.");
    expect(fixed.reply2).toBeUndefined();
  });
});
