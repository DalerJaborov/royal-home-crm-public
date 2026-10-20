import { describe, expect, it } from "vitest";
import { parseOnlineFollowers } from "../src/lib/instagramInsights.js";

/**
 * Разбор ответа Meta по метрике `online_followers` (lib/instagramInsights.ts).
 * Сеть здесь не нужна и не нужна база: весь риск в самом ответе — Meta кладёт
 * часы КЛЮЧАМИ-СТРОКАМИ внутрь `values[].value`, и ошибка разбора выглядела бы
 * как «прав нет», хотя права есть.
 */
describe("Статистика Instagram: часы онлайна", () => {
  it("разбирает ответ Meta в часы", () => {
    const body = { data: [{ values: [{ value: { "0": 5, "13": 120, "23": 40 } }] }] };
    expect(parseOnlineFollowers(body)).toEqual({ 0: 5, 13: 120, 23: 40 });
  });

  it("складывает несколько суток по одному часу, а не берёт последние", () => {
    const body = { data: [{ values: [{ value: { "13": 100 } }, { value: { "13": 20 } }] }] };
    expect(parseOnlineFollowers(body)).toEqual({ 13: 120 });
  });

  it("мусор и часы вне суток не попадают в карту", () => {
    const body = { data: [{ values: [{ value: { "13": 10, "24": 7, abc: 3, "5": "нет" } }] }] };
    expect(parseOnlineFollowers(body)).toEqual({ 13: 10 });
  });

  it("ответ без данных — пустая карта, а не падение", () => {
    expect(parseOnlineFollowers({})).toEqual({});
    expect(parseOnlineFollowers(null)).toEqual({});
    expect(parseOnlineFollowers({ data: [] })).toEqual({});
  });
});
