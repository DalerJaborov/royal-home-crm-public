import { describe, expect, it } from "vitest";
import { isSuburbanProperty, propertyOutsideServiceArea, textMentionsSuburb } from "../src/lib/suburbanProperty.js";

/**
 * «N КМ» И ПРИГОРОДЫ В ОПИСАНИИ ГОРОДСКОЙ КВАРТИРЫ (ревью ab0b597c, Ф-3а, 16.11.2026).
 *
 * После решения владельца 16.11 («Загород не берём, только Душанбе») объект «вне зоны» не предлагает ни один бот и
 * робот. Описание квартиры с городским районом рассказывает об округе — «остановка в 2 км», «вид на дачи», «до Вахдата
 * 20 минут» — и не должно выкидывать её из выдачи. Место объекта — заголовок, адрес, ориентир: там «9 км» и «Вахдат»
 * по-прежнему решают (аудит P0-4: агенты пишут дом в Вахдате в ближайший городской район).
 */
describe("описание городской квартиры не делает её загородной", () => {
  it.each([
    "Остановка в 2 км",
    "школа в 1 км",
    "рынок 1,5 км",
    "до центра города 3 км",
    "62 км/ч",
    "вид на дачи",
    "до Вахдата 20 минут",
    "ЖК Вахдат",
    "магазин 3 км пешком",
    "бывшая дача переделана в дом",
    "Чорбог рядом",
  ])("%s — город (район Сино)", (description) => {
    const p = { title: "2-комн квартира", description, district: { name: "Сино" } };
    expect(isSuburbanProperty(p)).toBe(false);
    expect(propertyOutsideServiceArea(p)).toBe(false);
  });

  it("то же с районом Фирдавси", () => {
    expect(propertyOutsideServiceArea({ description: "Остановка в 2 км, до Вахдата 20 минут", district: { name: "Фирдавси" } })).toBe(false);
  });
});

describe("место объекта за городом по-прежнему вне зоны", () => {
  it("«дом в Вахдате» с районом Шохмансур (тест «30 запросов» №13) — вне зоны", () => {
    expect(propertyOutsideServiceArea({ title: "Дом", description: "Продаётся дом в городе Вахдат", district: { name: "Шохмансур" } })).toBe(true);
    expect(propertyOutsideServiceArea({ title: "Ҳавлӣ", description: "Ҳавлӣ дар Ваҳдат", district: { name: "Шохмансур" } })).toBe(true);
  });

  it("«9 км» и «Вахдат» в заголовке, адресе, ориентире — место, вне зоны", () => {
    expect(propertyOutsideServiceArea({ title: "Дом, 9 км, шиферный завод", district: { name: "Шохмансур" } })).toBe(true);
    expect(propertyOutsideServiceArea({ address: "Вахдат, кишлак Симиганч", district: { name: "Сино" } })).toBe(true);
    expect(propertyOutsideServiceArea({ landmark: "12-й км", district: { name: "Фирдавси" } })).toBe(true);
  });

  it("без района в справочнике — как раньше: слова карточки решают", () => {
    expect(isSuburbanProperty({ description: "дача в Варзобе" })).toBe(true);
    expect(isSuburbanProperty({ description: "за городом, тихо" })).toBe(true);
  });

  it("«62 км/ч» и «до центра города 3 км» — не место и в запросе", () => {
    expect(textMentionsSuburb("62 км/ч")).toBe(false);
    expect(textMentionsSuburb("до центра города 3 км")).toBe(false);
    expect(textMentionsSuburb("дом на 9 км")).toBe(true);
  });
});
