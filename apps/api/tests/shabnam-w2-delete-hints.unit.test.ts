import { describe, expect, it } from "vitest";
import { deleteSentAsk, deleteSentScope, isDeleteSentRequest } from "../src/telegram/assistantChatCommands.js";

/**
 * Повторное ревью волны 2 (22.11.2026): на неясное «удали…» Шабнам отвечает вопросом с подсказками
 * («удали последнее», «удали всё», «охиринро нест кун», «ҳамаашро нест кун»), а сами подсказки не
 * распознавались как просьба удалить — человек делал как сказано и уходил к модели.
 */
describe("подсказки вопроса «Что убрать?» понимаются как просьба удалить", () => {
  it.each([
    ["удали последнее", "last"],
    ["удали всё", "all"],
    ["охиринро нест кун", "last"],
    ["ҳамаашро нест кун", "all"],
    // без спецбукв, с вежливыми словами
    ["хамаашро нест кун", "all"],
    ["Шабнам, удали последнее, пожалуйста", "last"],
  ] as const)("«%s» → удалить (%s)", (text, scope) => {
    expect(isDeleteSentRequest(text)).toBe(true);
    expect(deleteSentScope(text)).toBe(scope);
  });

  it("каждая подсказка из самого вопроса распознаётся", () => {
    for (const lang of ["ru", "tg"] as const) {
      const hints = [...deleteSentAsk(lang).matchAll(/«([^»]+)»/gu)].map((m) => m[1]!);
      expect(hints).toHaveLength(2);
      for (const hint of hints) expect(isDeleteSentRequest(hint), hint).toBe(true);
    }
  });

  it.each([
    "убери всё лишнее из описания", "удали все задачи", "удали последний показ", "сотри всё и начни объявление заново",
    "всё", "последнее",
  ])("«%s» — не чистка чата", (text) => {
    expect(isDeleteSentRequest(text)).toBe(false);
  });
});
