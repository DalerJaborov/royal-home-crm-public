import { describe, expect, it } from "vitest";
import { isStalePause } from "../src/lib/conversationDelivery.js";

/**
 * БАГ 19.08.2026 (скриншоты владельца, агент Ноза): бот отвечал поверх агента,
 * который только что вручную ответил клиенту, потому что карточка клиента уже
 * была в LOST/ARCHIVED/INACTIVE с прошлого раза — и isClientLostOrAbandoned()
 * снимала ЛЮБУЮ паузу, включая только что поставленную «бессрочную».
 *
 * Фикс: isPaused в messengers/conversation.ts больше не снимает паузу статусом
 * LOST/ARCHIVED/INACTIVE, если пауза свежая (isStalePause === false) — см. эту
 * функцию и STALE_PAUSE_THRESHOLD_MS в lib/conversationDelivery.ts.
 */
describe("isStalePause — граница «протухшей» паузы для снятия статусом LOST/ARCHIVED/INACTIVE", () => {
  it("null/отсутствует — считаем протухшей (снимать можно)", () => {
    expect(isStalePause(null)).toBe(true);
    expect(isStalePause(undefined)).toBe(true);
  });

  it("свежая «бессрочная» пауза (10 лет вперёд) — НЕ протухшая, снимать нельзя", () => {
    const tenYears = new Date(Date.now() + 60 * 24 * 365 * 10 * 60 * 1000);
    expect(isStalePause(tenYears)).toBe(false);
  });

  it("короткая дефолтная пауза (10 минут, разовая помощь не от закреплённого агента) — протухшая: статус LOST/ARCHIVED/INACTIVE по-прежнему может её снять, как и раньше", () => {
    const tenMinutes = new Date(Date.now() + 10 * 60 * 1000);
    expect(isStalePause(tenMinutes)).toBe(true);
  });

  it("до истечения паузы осталось меньше недели — протухшая, статус может её снять", () => {
    const sixDaysLeft = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000);
    expect(isStalePause(sixDaysLeft)).toBe(true);
  });

  it("«бессрочная» пауза, поставленная больше недели назад и с тех пор не обновлявшаяся, — протухшая (23.09.2026, №25)", () => {
    const tenYears = new Date(Date.now() + 60 * 24 * 365 * 10 * 60 * 1000);
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(isStalePause(tenYears, monthAgo)).toBe(true);
  });

  it("«бессрочная» пауза, обновлённая вчерашним ответом агента, — свежая", () => {
    const tenYears = new Date(Date.now() + 60 * 24 * 365 * 10 * 60 * 1000);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    expect(isStalePause(tenYears, yesterday)).toBe(false);
  });
});
