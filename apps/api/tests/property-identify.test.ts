import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { identifyProperty } from "../src/lib/propertyMatch.js";
import { resetGeoMentionIndex } from "../src/ai/geoMentions.js";
import { loadMoneyContext } from "../src/lib/money.js";

/**
 * УЗНАВАНИЕ ОБЪЕКТА ПО ПРИМЕТАМ ИЗ ЗВОНКА (владелец 24.09.2026, после ПК-000475):
 * «если клиент сказал, что видел объявление, и интересуется нашим объектом —
 * определить его точно, по всем параметрам… и ориентиры, и по карте».
 *
 * Проверяются не баллы, а границы, за которыми лид уходит не тому агенту:
 * узнаёт по цене и ориентиру, по цене и точке на карте, этажом разводит двух
 * похожих, противоречие (комнаты) вычёркивает, похожих без различия не угадывает,
 * проданный узнаёт со статусом, агента называет.
 *
 * Слова-ориентиры придуманы из букв номера прогона: в общей тестовой базе у
 * соседних файлов свои «Гулдасты», и совпасть с ними нельзя. Метка стоит В
 * НАЧАЛЕ слова и собрана с младших цифр: слова сравниваются с точностью до
 * окончания (общее начало), и метка в хвосте («Ситора» + метка) у двух прогонов
 * с разницей в минуты совпадала бы — объект, оставшийся от прерванного прогона,
 * становился третьим кандидатом. Кандидатов проверяем только среди своих
 * объектов: в долго живущей базе чужой объект с той же ценой законно набирает
 * баллы за цену.
 */

const runId = Date.now();
const tag = String(runId)
  .slice(-8)
  .split("")
  .reverse()
  .map((d) => "бвгдзклмнр"[Number(d)])
  .join("");
const PLACE = `${tag}зарнигор`;
const MAP_PLACE = `${tag}шукуфа`;
const PIN = { lat: 38.5102, lng: 68.7011 };

let ownerId: string;
let rivalId: string;
let landmarkId: string;
let districtId: string;
let usdToTjs: number;
const propertyIds: string[] = [];

/** Только свои объекты: чужие в общей базе законно набирают баллы за цену. */
function own<T extends { id: string }>(list: T[]): T[] {
  return list.filter((c) => propertyIds.includes(c.id));
}

async function makeProperty(data: Record<string, unknown>) {
  const p = await prisma.property.create({
    data: {
      title: `Объект узнавания ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 60,
      price: 30000,
      currency: "USD",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      intakeAgentId: ownerId,
      ownerContact: `+99293${String(runId).slice(-6)}${propertyIds.length}`,
      ...data,
    } as never,
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  usdToTjs = (await loadMoneyContext()).usdToTjs;
  ownerId = (
    await prisma.agent.create({
      data: { fullName: `Сурайё Узнавание ${runId}`, phone: `+992915${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  rivalId = (
    await prisma.agent.create({
      data: { fullName: `Соперник Узнавание ${runId}`, phone: `+992916${String(runId).slice(-6)}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;
  landmarkId = (
    await prisma.landmark.create({
      data: { name: `Бог ${MAP_PLACE}`, category: "Парк", lat: PIN.lat, lng: PIN.lng },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район узнавания ${runId}` } })).id;
  resetGeoMentionIndex();
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.landmark.deleteMany({ where: { id: landmarkId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [ownerId, rivalId] } } });
  resetGeoMentionIndex();
});

describe("identifyProperty — какой объект имеет в виду звонящий", () => {
  it("цена в долларах и ориентир словами — находит объект и называет агента", async () => {
    const target = await makeProperty({ price: 35000, landmark: `Фабрика ${PLACE}` });
    // Та же цена без ориентира и тот же ориентир за другие деньги — не он.
    await makeProperty({ price: 35000, intakeAgentId: rivalId });
    await makeProperty({ price: 80000, landmark: `Фабрика ${PLACE}`, intakeAgentId: rivalId });

    const started = Date.now();
    const found = await identifyProperty({ place: `у фабрики ${PLACE}а`, priceTjs: Math.round(35000 * usdToTjs) });
    expect(Date.now() - started, "узнавание обязано укладываться в доли секунды").toBeLessThan(1000);

    expect(found.propertyId).toBe(target.id);
    expect(found.via).toBe("description");
    expect(found.candidates[0].shortId).toBe(target.shortId);
    expect(found.candidates[0].agentId).toBe(ownerId);
    expect(found.candidates[0].agentName).toContain("Сурайё");
    expect(found.candidates[0].status).toBe("AVAILABLE");
  });

  it("ориентир по карте: в карточке его нет, но точка объекта рядом с ним", async () => {
    const near = await makeProperty({ price: 42000, lat: PIN.lat + 0.002, lng: PIN.lng + 0.002 });
    // Та же цена в пяти километрах — не он.
    await makeProperty({ price: 42000, lat: PIN.lat + 0.05, lng: PIN.lng, intakeAgentId: rivalId });

    const found = await identifyProperty({ place: `возле бога ${MAP_PLACE}`, priceTjs: Math.round(42000 * usdToTjs) });
    expect(found.propertyId).toBe(near.id);
    expect(found.candidates[0].signals.some((s) => s.startsWith("рядом"))).toBe(true);
  });

  it("два похожих у одного ориентира — не угадывает, отдаёт обоих для переспроса", async () => {
    const place = `${tag}ситора`;
    const a = await makeProperty({ price: 50000, landmark: place, floor: 3 });
    const b = await makeProperty({ price: 51000, landmark: place, floor: 7, intakeAgentId: rivalId });

    const unsure = await identifyProperty({ place, priceTjs: Math.round(50000 * usdToTjs) });
    expect(unsure.propertyId).toBeNull();
    expect(own(unsure.candidates).map((c) => c.id).sort()).toEqual([a.id, b.id].sort());

    // Этаж разводит их.
    const sure = await identifyProperty({ place, priceTjs: Math.round(50000 * usdToTjs), floor: 7 });
    expect(sure.propertyId).toBe(b.id);
    expect(sure.candidates[0].agentId).toBe(rivalId);
  });

  /**
   * До 24.09.2026 чужое число комнат вычёркивало объект совсем, как и тип
   * (ОБ-000118). Теперь противоречие мешает узнать уверенно, но объект остаётся
   * в похожих: в разборе звонка «комнаты» бывают и «сколько нужно», а агент
   * мог посчитать «3 хона» иначе.
   */
  it("противоречие по комнатам не даёт узнать уверенно, но объект остаётся в похожих", async () => {
    const place = `${tag}гулбахор`;
    const p = await makeProperty({ price: 137_777, landmark: place, rooms: 3 });
    // Площадь в приметах — не украшение: `candidates` это `scored.slice(0, 3)`
    // (lib/propertyMatch.ts), и в базе, где накопились объекты сотен других
    // файлов, тройку занимали посторонние с одной лишь подходящей ценой (вето
    // по цене — 20%), а наш объект с минусом за комнаты выпадал из неё. Тест
    // краснел на исправном коде, и только на засоренной базе (25.09.2026).
    // Цена НАРОЧНО редкая. `candidates` — это `scored.slice(0, 3)`
    // (lib/propertyMatch.ts), а в выборку попадает любой объект, чья цена в
    // пределах 20% (вето по цене): на базе, где накопились объекты сотен других
    // файлов, тройку занимали посторонние с одной подходящей ценой, и наш
    // объект с минусом за комнаты из неё выпадал — тест краснел на исправном
    // коде, только на засорённой базе (25.09.2026, прогон --clean-db показал
    // обратную картину). Добавлять свои приметы нельзя: ориентир уже делает
    // объект «узнанным по месту», и лишний совпавший этаж или площадь
    // поднимают его выше порога уверенности, отменяя первую половину проверки.
    // Редкая цена оставляет обе половины на месте и просто не пускает
    // посторонних в выборку.
    const found = await identifyProperty({ place, priceTjs: Math.round(137_777 * usdToTjs), rooms: 2 });
    expect(found.propertyId).toBeNull();
    expect(own(found.candidates).map((c) => c.id)).toEqual([p.id]);
  });

  it("одна цена без места — не угадывает", async () => {
    await makeProperty({ price: 71234, landmark: `${tag}бахористон` });
    const found = await identifyProperty({ priceTjs: Math.round(71234 * usdToTjs) });
    expect(found.propertyId).toBeNull();
  });

  it("недавно проданный узнаётся со статусом «продан»", async () => {
    const place = `${tag}навбахор`;
    const sold = await makeProperty({ price: 45000, landmark: place, status: "SOLD", soldAt: new Date(), publishedOnSite: false });
    const found = await identifyProperty({ place, priceTjs: Math.round(45000 * usdToTjs) });
    expect(found.propertyId).toBe(sold.id);
    expect(found.candidates[0].status).toBe("SOLD");
  });

  it("номер объекта — сразу он, без баллов", async () => {
    const p = await makeProperty({ price: 99000 });
    const found = await identifyProperty({ text: String(p.shortId) });
    expect(found.propertyId).toBe(p.id);
    expect(found.via).toBe("hint");
    expect(found.candidates[0].agentName).toContain("Сурайё");
  });

  /**
   * ЖИВОЙ ЗВОНОК 24.09.2026 ПРО ОБ-000118. Клиент оператору: квартира, 34 м²,
   * 300 000 сомони, Исмоили Сомони, у Бодомзора. В карточке объект заведён
   * «Участком», а «Бодомзора» в ней нет. Раньше несовпадение типа вычёркивало
   * объект, и лид ушёл раздачей другому агенту.
   */
  it("в карточке «Участок», клиент сказал «квартира» — цена, площадь и район всё равно узнают объект", async () => {
    const target = await makeProperty({ type: "LAND", areaSqm: 34, price: 300000, currency: "TJS", districtId, landmark: null });
    const found = await identifyProperty({
      place: "Бодомзор",
      priceTjs: 300000,
      areaSqm: 34,
      districtId,
      type: "APARTMENT",
    });
    expect(found.propertyId).toBe(target.id);
    expect(found.candidates[0].agentId).toBe(ownerId);
    expect(found.candidates[0].signals).toEqual(expect.arrayContaining(["цена", "площадь", "район"]));
  });

  it("цена и площадь без района — не угадывает, но показывает объект похожим", async () => {
    const p = await makeProperty({ type: "LAND", areaSqm: 41, price: 377000, currency: "TJS", landmark: null });
    const found = await identifyProperty({ priceTjs: 377000, areaSqm: 41, type: "APARTMENT" });
    expect(found.propertyId).toBeNull();
    expect(own(found.candidates).map((c) => c.id)).toContain(p.id);
  });

  it("бюджет клиента не вычёркивает объект: «ищу до 400, видел вашу за 300 у ориентира»", async () => {
    const place = `${tag}бодомзор`;
    const p = await makeProperty({ price: 300000, currency: "TJS", landmark: `Бог ${place}`, areaSqm: 48 });
    // Та же сумма как ЦЕНА ОБЪЯВЛЕНИЯ — это уже другой объект (дальше 20 %).
    const asPrice = await identifyProperty({ place, priceTjs: 400000, areaSqm: 48 });
    expect(asPrice.candidates.map((c) => c.id)).not.toContain(p.id);
    // Как бюджет — не приговор: ориентир и площадь узнают объект.
    const asBudget = await identifyProperty({ place, budgetTjs: 400000, areaSqm: 48 });
    expect(asBudget.propertyId).toBe(p.id);
  });

  it("без района и ориентира — цена, площадь, комнаты и этаж узнают объект (владелец 24.09.2026)", async () => {
    const p = await makeProperty({ price: 523456, currency: "TJS", areaSqm: 64, rooms: 2, floor: 5, landmark: null });
    const found = await identifyProperty({ priceTjs: 523456, areaSqm: 64, rooms: 2, floor: 5 });
    expect(found.propertyId).toBe(p.id);
    // Без этажа — три приметы, этого мало.
    const three = await identifyProperty({ priceTjs: 523456, areaSqm: 64, rooms: 2 });
    expect(three.propertyId).toBeNull();
  });

  it("участок в сотках: цена, сотки и район узнают его", async () => {
    const p = await makeProperty({ type: "LAND", price: 611111, currency: "TJS", areaSqm: 600, landAreaSotka: 6, districtId, landmark: null });
    const found = await identifyProperty({ priceTjs: 611111, landSotka: 6, districtId, type: "LAND" });
    expect(found.propertyId).toBe(p.id);
    expect(found.candidates[0].signals).toContain("сотки");
  });

  it("номер объекта словами — «объект №…», «ОБ-000…»; код клиента номером объекта не считается", async () => {
    const p = await makeProperty({ price: 98000 });
    const code = `ОБ-${String(p.shortId).padStart(6, "0")}`;
    for (const text of [`объект №${p.shortId}`, `объект номер ${p.shortId}`, code]) {
      const found = await identifyProperty({ text });
      expect(found.propertyId, text).toBe(p.id);
      expect(found.via, text).toBe("hint");
    }
    const client = await identifyProperty({ text: `ПК-${String(p.shortId).padStart(6, "0")}` });
    expect(client.via).not.toBe("hint");
  });

  it("тот же район и цена, но названная площадь другая — не узнаёт", async () => {
    await makeProperty({ areaSqm: 90, price: 412000, currency: "TJS", districtId, landmark: null });
    const found = await identifyProperty({ priceTjs: 412000, areaSqm: 34, districtId });
    expect(found.propertyId).toBeNull();
  });
});
