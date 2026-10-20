import { describe, expect, it } from "vitest";
import { transfersExhausted } from "../src/lib/leadTransfers.js";

/**
 * Предел передач лида между агентами.
 *
 * Отказной лид ходил по агентам и после третьего отказа просто зависал у
 * последнего: статус оставался «горячий», карточка считалась работой, но
 * заниматься ею уже никто не собирался.
 */

describe("Когда передачи исчерпаны", () => {
  it("до предела — можно передавать дальше", () => {
    expect(transfersExhausted(0, 3)).toBe(false);
    expect(transfersExhausted(2, 3)).toBe(false);
  });

  it("на пределе — карточка становится «Потерянной»", () => {
    expect(transfersExhausted(3, 3)).toBe(true);
    expect(transfersExhausted(4, 3)).toBe(true);
  });

  /** Ноль — осмысленный выбор владельца «передавать сколько угодно», а не ошибка
   *  ввода. Трактовать его как «предел исчерпан сразу» значило бы, что первый же
   *  отказ хоронит любого клиента. */
  it("ноль выключает правило совсем", () => {
    expect(transfersExhausted(0, 0)).toBe(false);
    expect(transfersExhausted(99, 0)).toBe(false);
  });

  it("отрицательное значение тоже не хоронит лиды", () => {
    expect(transfersExhausted(5, -1)).toBe(false);
  });
});
