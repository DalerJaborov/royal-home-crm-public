/**
 * Живой тон под постом (Dan 02.10.2026: «сухо отвечает без смайлов, просто с
 * восклицательным знаком»). Смайлик в текстовом ответе больше не вырезается, «!»
 * не больше одного, тон дописывается и к своему промту из Настроек, а последние
 * ответы уходят модели, чтобы она их не повторяла.
 * Разбор — docs/journal/2026-10-02-kommentarii-zhivoy-ton.md.
 */
import { describe, expect, it } from "vitest";
import {
  buildCommentSystem,
  cleanPublicCommentReply,
  COMMENT_TONE_RULES,
  recentRepliesLine,
} from "../src/messengers/comments.js";

describe("публичный ответ под постом", () => {
  it("один смайлик остаётся, гирлянда — нет", () => {
    const out = cleanPublicCommentReply("Эта двушка в Сино — 68 000 $ 🏡🏡✨");
    expect([...out.matchAll(/\p{Extended_Pictographic}/gu)].length).toBe(1);
    expect(out).toContain("🏡");
  });
  it("восклицательный знак — не больше одного", () => {
    const out = cleanPublicCommentReply("Спасибо!! Рады, что понравилось! Вживую ещё лучше!");
    expect(out.match(/!/g)?.length).toBe(1);
  });
  it("ответ из одних смайликов не трогаем", () => {
    expect(cleanPublicCommentReply("🙌")).toBe("🙌");
  });
});

describe("промт комментариев", () => {
  const input = { text: "Цена?", authorName: "user", isThreadReply: false, answered: 0, channel: "INSTAGRAM" as const };
  const ctx = { caption: null, property: null, digest: null } as unknown as Parameters<typeof buildCommentSystem>[1];

  it("тон под постом есть и в стандартном, и в своём промте", () => {
    expect(buildCommentSystem(input, ctx)).toContain(COMMENT_TONE_RULES.trim());
    expect(buildCommentSystem(input, ctx, "Свой текст владельца")).toContain(COMMENT_TONE_RULES.trim());
  });
  it("смайлик больше не назван уместным только в ответ на «🔥»", () => {
    expect(buildCommentSystem(input, ctx)).not.toContain("единственное место, где смайлик уместен");
  });
  it("последние ответы уходят модели, чтобы не повторяться", () => {
    const system = buildCommentSystem({ ...input, recentReplies: ["Здравствуйте! Цена 50 000 $"] }, ctx);
    expect(system).toContain("НЕ повторяй их формулировки");
    expect(system).toContain("Здравствуйте! Цена 50 000 $");
    expect(recentRepliesLine([])).toBe("");
  });
});
