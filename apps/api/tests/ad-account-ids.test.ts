import { describe, expect, it } from "vitest";
import { parseAdAccountIds } from "../src/lib/ads/metaAdsApi.js";

/**
 * Разбор списка рекламных кабинетов из одного поля Настроек.
 *
 * Мелочь, у которой цена ошибки — молча пустой отчёт: Ads Manager показывает номер
 * кабинета без префикса («751587752930155»), в переписке его присылают с префиксом
 * («act_751587752930155»), а два кабинета владелец вставит так, как ему удобно —
 * через запятую, через пробел или с новой строки.
 */
describe("parseAdAccountIds", () => {
  it("принимает номер с префиксом и без, в любом разделителе", () => {
    expect(parseAdAccountIds("751587752930155")).toEqual(["act_751587752930155"]);
    expect(parseAdAccountIds("act_751587752930155")).toEqual(["act_751587752930155"]);
    expect(parseAdAccountIds("act_111, 222")).toEqual(["act_111", "act_222"]);
    expect(parseAdAccountIds("act_111\nact_222")).toEqual(["act_111", "act_222"]);
    expect(parseAdAccountIds("act_111; 222 333")).toEqual(["act_111", "act_222", "act_333"]);
  });

  it("схлопывает дубли и не пропускает мусор", () => {
    expect(parseAdAccountIds("act_111, 111")).toEqual(["act_111"]);
    expect(parseAdAccountIds("")).toEqual([]);
    expect(parseAdAccountIds(null)).toEqual([]);
    // Строка без единой цифры — не номер кабинета, а опечатка.
    expect(parseAdAccountIds("act_, ,;")).toEqual([]);
  });
});
