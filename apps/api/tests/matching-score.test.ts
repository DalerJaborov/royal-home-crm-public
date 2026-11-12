import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findMatchingClients, findMatchingPropertiesForClient } from "../src/routes/matching.js";
import { matchClientProperty } from "../src/lib/clientPropertyMatching.js";
import { DEFAULT_MATCH_POLICY } from "../src/lib/matchPolicy.js";
import { loadMoneyContext } from "../src/lib/money.js";

/** Шкала близости «клиент ↔ объект» вынесена в scoreClientProperty, чтобы ею
 *  могло пользоваться и распределение лидов. Рефакторинг обязан оставить числа
 *  прежними: на них с 11.08.2026 завязан порог в Настройках, и молчаливый сдвиг
 *  шкалы поехал бы сразу и в карточке объекта, и в раздаче клиентов.
 *
 *  Поэтому баллы здесь ПРИБИТЫ ЯВНО, а не сверяются «больше/меньше». */

const runId = Date.now();

let districtId: string;
let otherDistrictId: string;
let intakeAgentId: string;
let exactPropertyId: string;
let roughPropertyId: string;
let ownerlessPropertyId: string;
let soldPropertyId: string;
let exactClientId: string;
let hotClientId: string;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-подбор-${runId}` } })).id;
  otherDistrictId = (await prisma.district.create({ data: { name: `Тест-подбор-чужой-${runId}` } })).id;
  intakeAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент интейка", phone: `+992925${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;

  async function makeProperty(opts: {
    rooms: number;
    price: number;
    withIntake: boolean;
    status?: "AVAILABLE" | "SOLD";
    district?: string;
  }) {
    const p = await prisma.property.create({
      data: {
        title: `Объект подбора ${opts.rooms}к ${opts.price} ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        rooms: opts.rooms,
        price: opts.price,
        currency: "TJS",
        districtId: opts.district ?? districtId,
        address: "Тестовая, 1",
        condition: "GOOD",
        status: opts.status ?? "AVAILABLE",
        intakeAgentId: opts.withIntake ? intakeAgentId : null,
      },
    });
    return p.id;
  }

  // Точное попадание: район, комнаты и бюджет — всё сходится (40+25+20+15 = 100).
  exactPropertyId = await makeProperty({ rooms: 3, price: 300_000, withIntake: true });
  // Компромисс: комнат на одну больше и цена выше бюджета (проходит растяжкой).
  roughPropertyId = await makeProperty({ rooms: 4, price: 430_000, withIntake: true });
  // Без хозяина — лида принести не может.
  ownerlessPropertyId = await makeProperty({ rooms: 3, price: 300_000, withIntake: false });
  // Продан — из подбора выпадает.
  soldPropertyId = await makeProperty({ rooms: 3, price: 300_000, withIntake: true, status: "SOLD" });

  async function makeClient(status: "NEW" | "HOT", phoneSuffix: string) {
    const c = await prisma.client.create({
      data: {
        fullName: `Клиент подбора ${status} ${runId}`,
        phone: `+99292${phoneSuffix}${runId}`,
        source: "PHONE_CALL",
        kind: "BUYER",
        status,
        currency: "TJS",
        budgetMin: 250_000,
        budgetMax: 400_000,
        desiredDistrictId: districtId,
        desiredRooms: 3,
      },
    });
    return c.id;
  }
  exactClientId = await makeClient("NEW", "1");
  hotClientId = await makeClient("HOT", "2");
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: [exactClientId, hotClientId] } } });
  await prisma.property.deleteMany({
    where: { id: { in: [exactPropertyId, roughPropertyId, ownerlessPropertyId, soldPropertyId] } },
  });
  await prisma.agent.deleteMany({ where: { id: intakeAgentId } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, otherDistrictId] } } });
  await prisma.$disconnect();
});

describe("Шкала порога «свой объект» не сдвинулась при подборе 2.0", () => {
  /** Шкала (points) живёт в единой модели matchClientProperty и нужна только
   *  порогу распределения заявок; числа прибиты, как и до 10.11.2026. */
  it("точное попадание — сто из ста, причины названы поимённо", async () => {
    const money = await loadMoneyContext();
    const found = matchClientProperty(
      { budgetMin: 250_000, budgetMax: 400_000, currency: "TJS", desiredDistrictId: districtId, desiredRooms: 3 },
      { id: exactPropertyId, price: 300_000, currency: "TJS", districtId, rooms: 3, type: "APARTMENT" },
      money, DEFAULT_MATCH_POLICY
    )!;
    // 40 база + 25 район + 20 комнаты + 15 бюджет.
    expect(found.points).toBe(100);
    expect(found.tier).toBe("exact");
    expect(found.reasons).toEqual(["Нужный район", "В бюджете", "3 комнаты, как просил"]);
  });

  it("компромисс по комнатам и цене — сорок, уровень «можно предложить»", async () => {
    const money = await loadMoneyContext();
    const found = matchClientProperty(
      { budgetMin: 250_000, budgetMax: 400_000, currency: "TJS", desiredDistrictId: null, desiredRooms: 3 },
      { id: roughPropertyId, price: 430_000, currency: "TJS", districtId, rooms: 4, type: "APARTMENT" },
      money, DEFAULT_MATCH_POLICY
    )!;
    expect(found.points).toBe(40);
    expect(found.tier).toBe("alternative");
    expect(found.tradeoffs).toEqual(["На 8% дороже бюджета (+30 000 сомони)", "На 1 комнату больше (просил 3)"]);
  });

  it("теплота клиента на шкалу пары не влияет — бонуса «горячему» больше нет", async () => {
    const money = await loadMoneyContext();
    const property = { id: exactPropertyId, price: 300_000, currency: "TJS", districtId, rooms: 3 };
    const client = { budgetMax: 400_000, budgetMin: null, currency: "TJS", desiredDistrictId: null, desiredRooms: null };
    expect(matchClientProperty({ ...client, status: "HOT" } as typeof client, property, money, DEFAULT_MATCH_POLICY)!.points).toBe(55);
    expect(matchClientProperty(client, property, money, DEFAULT_MATCH_POLICY)!.points).toBe(55);
  });

  it("findMatchingClients: точный уровень у обоих, горячий — только при прочих равных выше", async () => {
    const { items: matched } = await findMatchingClients(exactPropertyId, 50);
    const exact = matched.find((m) => m.id === exactClientId);
    const hot = matched.find((m) => m.id === hotClientId);
    expect(exact?.match.tier).toBe("exact");
    expect(hot?.match.tier).toBe("exact");
    expect(matched.findIndex((m) => m.id === hotClientId)).toBeLessThan(matched.findIndex((m) => m.id === exactClientId));
  });
});

describe("Веса шкалы — константа в коде (Путь покупателя, п.5.1; с 01.11.2026)", () => {
  afterEach(async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { matchScoreDistrict: 25, matchScoreBase: 40 },
    });
  });

  it("веса шкалы — константа с 01.11.2026: колонка Settings.matchScoreDistrict на балл не влияет", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { matchScoreDistrict: 50 } });
    try {
      const matched = await findMatchingPropertiesForClient(exactClientId);
      const exact = matched.find((m) => m.propertyId === exactPropertyId);
      // 40 база + 25 район + 20 комнаты + 15 бюджет = 100 (MATCH_SCORE_WEIGHTS).
      expect(exact?.score).toBe(100);
      // 40 база + 25 район = 65, комнаты и бюджет мимо. Читай сервер колонку — было бы 90.
      expect(matched.find((m) => m.propertyId === roughPropertyId)?.score).toBe(65);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { matchScoreDistrict: 25 } });
    }
  });
});

describe("Объекты под клиента", () => {
  it("отдаёт подходящие объекты с их хозяином, по убыванию совпадения", async () => {
    const matched = await findMatchingPropertiesForClient(exactClientId);
    const ids = matched.map((m) => m.propertyId);
    expect(ids).toContain(exactPropertyId);
    expect(matched[0].propertyId).toBe(exactPropertyId);
    expect(matched[0].intakeAgentId).toBe(intakeAgentId);
    expect(matched[0].score).toBe(100);
  });

  it("объект без хозяина в выдачу не попадает — лида он принести не может", async () => {
    const matched = await findMatchingPropertiesForClient(exactClientId);
    expect(matched.map((m) => m.propertyId)).not.toContain(ownerlessPropertyId);
  });

  it("проданный объект в выдачу не попадает", async () => {
    const matched = await findMatchingPropertiesForClient(exactClientId);
    expect(matched.map((m) => m.propertyId)).not.toContain(soldPropertyId);
  });

  it("горячий клиент не получает бонуса — иначе порог означал бы для него другое", async () => {
    // Тот же запрос, что у обычного клиента; отличие только в статусе HOT.
    const forHot = await findMatchingPropertiesForClient(hotClientId);
    const forPlain = await findMatchingPropertiesForClient(exactClientId);
    const hotScore = forHot.find((m) => m.propertyId === exactPropertyId)?.score;
    const plainScore = forPlain.find((m) => m.propertyId === exactPropertyId)?.score;
    expect(hotScore).toBe(plainScore);
  });

  it("удалённый клиент даёт пустую выдачу, а не падение", async () => {
    expect(await findMatchingPropertiesForClient("00000000-0000-0000-0000-000000000000")).toEqual([]);
  });
});
