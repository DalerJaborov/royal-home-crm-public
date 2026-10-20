import { describe, expect, it } from "vitest";
import { groupMetaBySender } from "../src/routes/webhooks.js";

/**
 * ПАЧКА ВЕБХУКА META — ПО СОБЕСЕДНИКАМ (23.09.2026, аудит №26).
 *
 * Одно тело вебхука несёт сообщения разных людей. Обрабатывались строго по
 * очереди: ход бота ждёт окно склейки до 25 с и модель, и второй клиент ждал
 * первого, третий — второго. Теперь очереди по собеседнику идут параллельно,
 * а внутри одной очереди порядок прежний (эхо ответа — после сообщения).
 */
describe("groupMetaBySender", () => {
  it("разные собеседники — разные очереди, порядок внутри сохранён", () => {
    const batch = [
      { channel: "INSTAGRAM", senderId: "a", n: 1 },
      { channel: "INSTAGRAM", senderId: "b", n: 2 },
      { channel: "INSTAGRAM", senderId: "a", n: 3 },
      { channel: "WHATSAPP", senderId: "a", n: 4 },
    ];
    const groups = groupMetaBySender(batch);
    expect(groups.map((g) => g.map((m) => m.n))).toEqual([[1, 3], [2], [4]]);
  });

  it("пустая пачка — нет очередей", () => {
    expect(groupMetaBySender([])).toEqual([]);
  });
});
