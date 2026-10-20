import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findMatchingClients, findMatchingPropertiesForClient, scoreClientProperty } from "../src/routes/matching.js";
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

describe("Шкала близости не сдвинулась при выносе", () => {
  it("точное попадание — сто из ста", async () => {
    const money = await loadMoneyContext();
    const { score, reasons } = scoreClientProperty(
      { budgetMin: 250_000, budgetMax: 400_000, currency: "TJS", desiredDistrictId: districtId, desiredRooms: 3 },
      { id: exactPropertyId, price: 300_000, currency: "TJS", districtId, rooms: 3 },
      money
    );
    // 40 база + 25 район + 20 комнаты + 15 бюджет.
    expect(score).toBe(100);
    expect(reasons).toEqual(["район совпал", "комнат столько же", "в бюджете"]);
  });

  it("компромисс по комнатам и цене — сорок пять", async () => {
    const money = await loadMoneyContext();
    const { score, reasons } = scoreClientProperty(
      { budgetMin: 250_000, budgetMax: 400_000, currency: "TJS", desiredDistrictId: null, desiredRooms: 3 },
      { id: roughPropertyId, price: 430_000, currency: "TJS", districtId, rooms: 4 },
      money
    );
    // 40 база + 5 ни за что: район не назван, комнаты не те, цена выше бюджета.
    expect(score).toBe(40);
    expect(reasons).toEqual(["искал 3-комн", "чуть выше бюджета"]);
  });

  it("горячий клиент получает свои десять — и теряет их, когда бонус выключен", async () => {
    const money = await loadMoneyContext();
    const pair = [
      { budgetMax: 400_000, budgetMin: null, currency: "TJS", desiredDistrictId: null, desiredRooms: null, status: "HOT" },
      { id: exactPropertyId, price: 300_000, currency: "TJS", districtId, rooms: 3 },
      money,
    ] as const;
    expect(scoreClientProperty(...pair).score).toBe(65); // 40 + 15 бюджет + 10 горячий
    expect(scoreClientProperty(...pair, { includeHotBonus: false }).score).toBe(55);
  });

  it("findMatchingClients продолжает считать по той же шкале", async () => {
    // 17.09.2026: findMatchingClients возвращает { items, total }, не голый массив.
    const { items: matched } = await findMatchingClients(exactPropertyId, 50);
    const exact = matched.find((m) => m.id === exactClientId);
    const hot = matched.find((m) => m.id === hotClientId);
    expect(exact?.score).toBe(100);
    // Горячему больше сотни не начисляется — потолок остался на месте.
    expect(hot?.score).toBe(100);
    // И горячий стоит не ниже обычного при равном балле.
    expect(matched.findIndex((m) => m.id === hotClientId)).toBeLessThanOrEqual(
      matched.findIndex((m) => m.id === exactClientId) + 1
    );
  });
});

describe("Веса шкалы настраиваются в Настройках (Путь покупателя, п.5.1)", () => {
  afterEach(async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { matchScoreDistrict: 25, matchScoreBase: 40 },
    });
  });

  it("правка веса района в Настройках меняет реальный балл подбора", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { matchScoreDistrict: 50 } });

    const matched = await findMatchingPropertiesForClient(exactClientId);
    const exact = matched.find((m) => m.propertyId === exactPropertyId);
    // 40 база + 50 район (было 25) + 20 комнаты + 15 бюджет = 125, потолок 100.
    expect(exact?.score).toBe(100);

    // Без потолка эффект виден по объекту с компромиссом — район у него тот же (districtId).
    const { items: matchedRough } = await findMatchingClients(roughPropertyId, 50);
    const client = matchedRough.find((m) => m.id === exactClientId);
    // 40 база + 50 район (новый вес) = 90, комнаты и бюджет мимо. Со старым весом 25 было бы 65.
    expect(client?.score).toBe(90);
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
