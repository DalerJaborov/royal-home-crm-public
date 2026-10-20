import { describe, expect, it } from "vitest";
import { dropRepeatedBubbles } from "../src/ai/replyRepeatGuard.js";
import { isRepeatOfLastReply, normalizeReplyBubbles } from "../src/ai/leadQualifier.js";

/**
 * БОТ ПОВТОРИЛ СЕБЯ СЛОВО В СЛОВО (живая проверка владельца на проде 17.09.2026).
 *
 * На «Саломалекм» пришло дважды подряд, дословно:
 * «Здравствуйте! Я консультант Royal Home. Подскажите, как к Вам обращаться и из
 * какого Вы города?»
 *
 * Защита от дословного повтора в проекте есть с 30.08.2026 и НЕ СРАБОТАЛА. Причин
 * две, обе молчаливые.
 *
 * 1. ХОД БОТА ХРАНИТСЯ ОДНОЙ ЗАПИСЬЮ, А СРАВНИВАЕТСЯ ПУЗЫРЯМИ. Ответ уходит
 *    клиенту двумя сообщениями, а в историю ложится одной строкой через перевод
 *    строки. Каждый пузырь сравнивался с записью ЦЕЛИКОМ и, разумеется, никогда ей
 *    не был равен — на всех двухпузырных ответах защиты просто не было.
 * 2. Снимок истории берётся в начале хода, до окна дебаунса и вызова модели, и
 *    больше не перечитывается (починено в messengers/conversation.ts — там же
 *    разбор; здесь стеречь нечего без живого хода).
 */

const BUBBLE_1 = "Здравствуйте! Я консультант Royal Home.";
const BUBBLE_2 = "Подскажите, как к Вам обращаться и из какого Вы города?";
/** Как ход бота реально лежит в BotConversation.messages. */
const STORED_TURN = `${BUBBLE_1}\n${BUBBLE_2}`;

describe("повтор через склеенную запись хода", () => {
  it("оба пузыря прошлого хода узнаются как повтор", () => {
    expect(dropRepeatedBubbles([BUBBLE_1, BUBBLE_2], [STORED_TURN])).toEqual([]);
  });

  it("узнаётся и повтор одного пузыря из двух", () => {
    expect(dropRepeatedBubbles([BUBBLE_2], [STORED_TURN])).toEqual([]);
  });

  it("запись целиком по-прежнему узнаётся (прежнее поведение не сломано)", () => {
    expect(dropRepeatedBubbles([STORED_TURN], [STORED_TURN])).toEqual([]);
  });

  it("новая фраза проходит", () => {
    const fresh = "Раҳмат! Резюме доред ё не?";
    expect(dropRepeatedBubbles([fresh], [STORED_TURN])).toEqual([fresh]);
  });

  it("короткое согласие повтором не считается — вырезать его хуже", () => {
    expect(dropRepeatedBubbles(["Хуб"], ["Хуб"])).toEqual(["Хуб"]);
  });

  it("исключения (незакрытый вопрос темы) по-прежнему пропускаются", () => {
    expect(dropRepeatedBubbles([BUBBLE_2], [STORED_TURN], [BUBBLE_2])).toEqual([BUBBLE_2]);
  });
});

describe("isRepeatOfLastReply видит строки склеенной записи", () => {
  it("пузырь равен одной из строк прошлого хода", () => {
    expect(isRepeatOfLastReply(BUBBLE_2, STORED_TURN)).toBe(true);
    expect(isRepeatOfLastReply(BUBBLE_1, STORED_TURN)).toBe(true);
  });

  it("другой текст повтором не считается", () => {
    expect(isRepeatOfLastReply("Резюме доред?", STORED_TURN)).toBe(false);
  });

  it("истории нет — сравнивать не с чем", () => {
    expect(isRepeatOfLastReply(BUBBLE_1, "")).toBe(false);
  });
});

describe("normalizeReplyBubbles не выпускает повтор прошлого хода", () => {
  it("модель сочинила то же самое — до клиента это не доходит", () => {
    const bubbles = normalizeReplyBubbles(STORED_TURN, true, "Саломалекм", STORED_TURN);
    expect(bubbles).toEqual([]);
  });
});
