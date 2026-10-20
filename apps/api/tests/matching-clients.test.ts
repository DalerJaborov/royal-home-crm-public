import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { findMatchingClients } from "../src/routes/matching.js";

/**
 * «Кому подойдёт этот объект».
 *
 * Счётчик спроса отвечал «трое ищут» и на этом заканчивался: кто эти трое, агент
 * выяснял руками через фильтры. Здесь проверяется главное, что легко испортить
 * незаметно, — ПОРЯДОК и ПРИЧИНЫ. Список без объяснений, почему в нём клиент с
 * бюджетом «до 400 000» у объекта за 440 000, перестают читать, а это худшее, что
 * может случиться с подсказкой.
 */

const runId = Date.now();
let districtId: string;
let otherDistrictId: string;
let propertyId: string;
const clientIds: string[] = [];

async function makeClient(data: Record<string, unknown>) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент-${clientIds.length}-${runId}`,
      phone: `+9929${runId.toString().slice(-8)}${clientIds.length}`,
      status: "NEW",
      kind: "BUYER",
      source: "WEBSITE",
      ...data,
    } as never,
  });
  clientIds.push(c.id);
  return c;
}

beforeAll(async () => {
  const [d1, d2] = await Promise.all([
    prisma.district.create({ data: { name: `Подбор-${runId}` } }),
    prisma.district.create({ data: { name: `Чужой-${runId}` } }),
  ]);
  districtId = d1.id;
  otherDistrictId = d2.id;

  const property = await prisma.property.create({
    data: {
      title: `Объект подбора ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 3,
      price: 400000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
    },
  });
  propertyId = property.id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: { in: [districtId, otherDistrictId] } } });
});

describe("Кого показываем", () => {
  it("точное совпадение стоит выше приблизительного", async () => {
    const exact = await makeClient({
      fullName: `Точный-${runId}`,
      desiredDistrictId: districtId,
      desiredRooms: 3,
      budgetMax: 450000,
      currency: "TJS",
    });
    // Другое число комнат и цена, проходящая только за счёт растяжки бюджета.
    await makeClient({
      fullName: `Приблизительный-${runId}`,
      desiredDistrictId: districtId,
      desiredRooms: 2,
      budgetMax: 380000,
      currency: "TJS",
    });

    // 17.09.2026: findMatchingClients возвращает { items, total }, не голый массив.
    const { items: matched, total } = await findMatchingClients(propertyId);
    expect(matched.length).toBeGreaterThanOrEqual(2);
    expect(total).toBeGreaterThanOrEqual(matched.length);
    expect(matched[0].id).toBe(exact.id);
    expect(matched[0].score).toBeGreaterThan(matched[1].score);
  });

  /** Без причин агент не понимает, почему клиент в списке, и списку не доверяет. */
  it("у точного совпадения причины названы поимённо", async () => {
    const { items: matched } = await findMatchingClients(propertyId);
    const top = matched[0];
    expect(top.reasons).toContain("район совпал");
    expect(top.reasons).toContain("комнат столько же");
    expect(top.reasons).toContain("в бюджете");
  });

  it("клиент, прошедший только за счёт растяжки бюджета, помечен честно", async () => {
    const { items: matched } = await findMatchingClients(propertyId);
    const loose = matched.find((m) => m.fullName.startsWith("Приблизительный"));
    expect(loose).toBeDefined();
    expect(loose!.reasons).toContain("чуть выше бюджета");
  });

  it("клиент из другого района не показывается", async () => {
    const foreign = await makeClient({
      fullName: `Чужой район-${runId}`,
      desiredDistrictId: otherDistrictId,
      budgetMax: 450000,
      currency: "TJS",
    });
    const { items: matched } = await findMatchingClients(propertyId);
    expect(matched.map((m) => m.id)).not.toContain(foreign.id);
  });

  /**
   * 17.09.2026: «ждущий» теперь единое определение waitingBuyerWhere
   * (lib/matchPolicy.ts) — Client.status (воронка лида) в него не входит вовсе,
   * это отдельное измерение от workStatus (см. docstring waitingBuyerWhere).
   * Что действительно исключает клиента безусловно — buyerStage=NEGOTIATION
   * (уже занят показом другого объекта); включение/выключение по workStatus
   * проверяется отдельно в match-policy.test.ts (matchIncludeInactive).
   */
  it("клиент в «Переговорах» по другому объекту не показывается", async () => {
    const negotiating = await makeClient({
      fullName: `В переговорах-${runId}`,
      desiredDistrictId: districtId,
      desiredRooms: 3,
      budgetMax: 450000,
      currency: "TJS",
      buyerStage: "NEGOTIATION",
    });
    const { items: matched } = await findMatchingClients(propertyId);
    expect(matched.map((m) => m.id)).not.toContain(negotiating.id);
  });

  it("удалённый объект даёт пустой список, а не ошибку", async () => {
    expect(await findMatchingClients("00000000-0000-0000-0000-000000000000")).toEqual({ items: [], total: 0 });
  });

  /**
   * Текущий агент клиента нужен фронту для кнопки «отдать» (спецификация
   * владельца: «из карточки объекта — действие «отдать подходящего клиента
   * нужному агенту»») — без него интерфейс не может понять, что клиент уже у
   * ответственного за объект, и предложил бы передать его самому себе.
   */
  it("отдаёт текущего агента клиента, null — если не назначен", async () => {
    const withAgent = await prisma.agent.create({
      data: { fullName: `Агент подбора ${runId}`, phone: `+992946${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const assigned = await makeClient({
      fullName: `С агентом-${runId}`,
      desiredDistrictId: districtId,
      desiredRooms: 3,
      budgetMax: 450000,
      currency: "TJS",
      assignedAgentId: withAgent.id,
    });
    const { items: matched } = await findMatchingClients(propertyId);
    const found = matched.find((m) => m.id === assigned.id);
    expect(found?.assignedAgentId).toBe(withAgent.id);

    const exact = matched.find((m) => m.fullName.startsWith("Точный"));
    expect(exact?.assignedAgentId).toBeNull();

    await prisma.agent.deleteMany({ where: { id: withAgent.id } });
  });

  /**
   * 17.09.2026 (план раздел 6, единая панель «Подбор»): строка кандидата на
   * карточке объекта показывает имя агента без второго запроса за ним по
   * assignedAgentId — имя должно прийти в том же ответе.
   */
  it("отдаёт имя текущего агента клиента, null — если не назначен", async () => {
    const withAgent = await prisma.agent.create({
      data: { fullName: `Агент подбора имени ${runId}`, phone: `+992947${runId}`, role: "AGENT", passwordHash: "x" },
    });
    const assigned = await makeClient({
      fullName: `С именем агента-${runId}`,
      desiredDistrictId: districtId,
      desiredRooms: 3,
      budgetMax: 450000,
      currency: "TJS",
      assignedAgentId: withAgent.id,
    });
    const { items: matched } = await findMatchingClients(propertyId);
    const found = matched.find((m) => m.id === assigned.id);
    expect(found?.assignedAgentName).toBe(withAgent.fullName);

    const exact = matched.find((m) => m.fullName.startsWith("Точный"));
    expect(exact?.assignedAgentName).toBeNull();

    await prisma.agent.deleteMany({ where: { id: withAgent.id } });
  });
});
