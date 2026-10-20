import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { geoMentionBlock, placesMentioned, resetGeoMentionIndex } from "../src/ai/geoMentions.js";
import { FOLK_PINS } from "../src/ai/folkPlaces.js";
import { districtByPoint } from "../src/lib/propertyDistrict.js";

/**
 * БОТ ОТВЕЧАЕТ ПРО МЕСТО ПО КАРТЕ, А НЕ НАУГАД (20.09.2026).
 *
 * Живой случай: «кадом тарафда боша кучаи дехоти?» — бот ответил «дар тарафи
 * Фирдавсӣ» наугад, а двумя сообщениями выше называл ту же улицу Шохмансуром.
 * Справочник улиц лежал в базе и боту не был доступен вовсе.
 */

const runId = Date.now();
const STREET = `улица Тестдехоти ${runId}`;
const STREET_TJ = `кӯчаи Тестдеҳотӣ ${runId}`;
const POINT = { lat: 38.5334, lng: 68.7558 };

let districtId = "";
let streetSourceId = "";
let landmarkSourceId = "";

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-карта-${runId}` } })).id;
  streetSourceId = `test-street-mention-${runId}`;
  landmarkSourceId = `test-landmark-mention-${runId}`;
  await prisma.street.create({
    data: {
      sourceId: streetSourceId,
      name: STREET,
      nameTj: STREET_TJ,
      kind: "улица",
      districtId,
      lat: POINT.lat,
      lng: POINT.lng,
    },
  });
  await prisma.landmark.create({
    data: {
      sourceId: landmarkSourceId,
      name: `Бозорчаи Тест ${runId}`,
      category: "Базар",
      districtId,
      lat: POINT.lat,
      lng: POINT.lng,
    },
  });
  resetGeoMentionIndex();
});

afterAll(async () => {
  await prisma.landmark.deleteMany({ where: { sourceId: landmarkSourceId } });
  await prisma.street.deleteMany({ where: { sourceId: streetSourceId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  resetGeoMentionIndex();
});

describe("Места из сообщения клиента — по карте города", () => {
  it("находит улицу, названную клиентом живой фразой", async () => {
    const places = await placesMentioned(`Амин озир ман навиштм кадом тарафда боша ${STREET}?`);
    expect(places.map((p) => p.name)).toContain(STREET);
  });

  it("находит её же по таджикскому написанию", async () => {
    const places = await placesMentioned(`${STREET_TJ} дар кучост?`);
    expect(places.map((p) => p.name)).toContain(STREET);
  });

  it("в блок промта попадают ориентир и верный район", async () => {
    const block = await geoMentionBlock(`кадом тарафда боша ${STREET}?`);
    expect(block).toContain(STREET);
    expect(block).toContain(`Бозорчаи Тест ${runId}`);
    expect(block).toContain(`район Тест-район-карта-${runId}`);
  });

  it("незнакомое место не выдумывается — блок пустой", async () => {
    expect(await geoMentionBlock("кучаи Такойулицынетвсправочнике кучост?")).toBe("");
  });

  it("таджикские буквы и русские близнецы — одно и то же место", async () => {
    // Клиент пишет «Роҳат», а в справочнике «Рохат» (и наоборот) — без свёртки
    // букв ғ ӣ қ ӯ ҳ ҷ бот не узнаёт место, написанное другой раскладкой.
    const russianSpelling = STREET_TJ.replace(/ӯ/g, "у").replace(/ҳ/g, "х").replace(/ӣ/g, "и");
    expect(russianSpelling).not.toBe(STREET_TJ);
    const places = await placesMentioned(`${russianSpelling} дар кучост?`);
    expect(places.map((p) => p.name)).toContain(STREET);
  });

  it("даёт ссылку на карту — клиент спрашивает «это где?»", async () => {
    const block = await geoMentionBlock(`кадом тарафда боша ${STREET}?`);
    expect(block).toContain(`https://maps.google.com/?q=${POINT.lat},${POINT.lng}`);
  });

  it("ссылки выключены рубильником — карты в блоке нет", async () => {
    const block = await geoMentionBlock(`кадом тарафда боша ${STREET}?`, false);
    expect(block).toContain(STREET);
    expect(block).not.toContain("maps.google.com");
  });

  /**
   * НАРОДНОЕ НАЗВАНИЕ С ПРОВЕРЕННОЙ ТОЧКОЙ (20.09.2026).
   *
   * Владелец: «забери к нам на карту, чтобы было всё точнее». Семь названий,
   * которых нет в купленном слое, получили координату из проверяемого источника
   * (FOLK_PINS в ai/folkPlaces.ts) — и бот отвечает про них так же, как про
   * любое место с карты, а не по рукописному списку районов.
   */
  it("народное название с точкой находится и отдаёт карту", async () => {
    const pin = FOLK_PINS.find((p) => p.name === "Медгородок")!;
    const places = await placesMentioned("Медгородок дар кучост?");
    expect(places.map((p) => p.name)).toContain(pin.name);
    const block = await geoMentionBlock("Медгородок дар кучост?");
    expect(block).toContain(`https://maps.google.com/?q=${pin.lat},${pin.lng}`);
  });

  /**
   * СПОРНЫЙ РАЙОН РЕШАЕТ КАРТА, А НЕ СПИСОК (20.09.2026).
   *
   * Владелец: «чтобы карта сама определила, посмотрим кто прав». Про «Колхоз
   * Россия» источники расходятся (Фирдавси или Шохмансур), про «Сархадчиён» не
   * говорит никто — но точка у обоих есть, а границы районов у нас настоящие.
   * Поэтому район берётся у границы по точке: приписанный в списке сюда не
   * попадает вовсе.
   */
  it("у народной точки район берётся у границы, а не из списка", async () => {
    const pin = FOLK_PINS.find((p) => p.name === "Колхоз Россия")!;
    const inDistrict = await districtByPoint(pin.lat, pin.lng);
    const [place] = await placesMentioned("Колхоз Россия кучост?");
    expect(place.name).toBe(pin.name);
    expect(place.districtName).toBe(inDistrict?.name ?? null);
    // В блок место попадает даже когда карта про него ничего не знает: у нас
    // есть точка и описание из источника — молчать про них незачем.
    expect(await geoMentionBlock("Колхоз Россия кучост?")).toContain(pin.name);
  });

  it("короткое слово не ловится куском другого слова", async () => {
    // Защита от ложных совпадений: название ищется по границам слов.
    expect(await placesMentioned(`${STREET}енебыло`)).toHaveLength(0);
  });
});
