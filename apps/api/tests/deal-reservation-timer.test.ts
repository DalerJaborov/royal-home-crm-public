import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

const sendPushToAgent = vi.fn(async () => 1);
vi.mock("../src/push.js", async (importOriginal) => ({
  // Подмена ДОПОЛНЯЕТ модуль, а не заменяет его целиком (19.09.2026):
  // фабрика без importOriginal убирает остальные экспорты у всего
  // процесса, и СОСЕДНИЙ тест падает на «No "…" export is defined».
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent, sendPushToAgents: sendPushToAgent,
}));

/** Рубильник для теста на атомарность ниже: ронять запись в ленту, которая идёт
 *  ВНУТРИ транзакции возврата объекта в продажу. Шпион на `prisma.deal.update`
 *  для этого не годится — внутри транзакции код зовёт `tx.deal.update`, другой
 *  объект. По умолчанию выключен, подмена просто пропускает вызов насквозь. */
let mockFailTimelineOnce = false;
vi.mock("../src/lib/timeline.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/timeline.js")>();
  return {
    ...actual,
    logTimeline: (...args: Parameters<typeof actual.logTimeline>) => {
      if (mockFailTimelineOnce) {
        mockFailTimelineOnce = false;
        throw new Error("тестовое падение посреди транзакции");
      }
      return actual.logTimeline(...args);
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { releaseExpiredReservations } = await import("../src/lib/dealReservation.js");
const { grantElevation } = await import("../src/lib/stepUp.js");

/**
 * Резерв объекта на сделке (Путь покупателя, решение владельца 30.07.2026):
 * объект резервируется, как только заведена сделка; если она не закрылась и
 * не отменилась за Settings.dealReservationBusinessDays рабочих дней, объект
 * автоматически возвращается в продажу.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string;
let directorId: string;
let token: string;
let directorToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const dealIds: string[] = [];

async function makeClient() {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент резерва ${runId}-${clientIds.length}`,
      phone: `+992986${clientIds.length}${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeProperty() {
  const p = await prisma.property.create({
    data: {
      title: `Объект резерва ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, резерв",
      condition: "GOOD",
    },
  });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-резерв-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент резерва", phone: `+992987${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992987${runId}`, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;

  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор резерва", phone: `+992988${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  const directorRes = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992988${runId}`, password });
  expect(directorRes.status).toBe(200);
  grantElevation(directorId);
  directorToken = directorRes.body.accessToken as string;

  await prisma.settings.update({ where: { id: "singleton" }, data: { dealReservationBusinessDays: 3 } });
});

afterAll(async () => {
  await prisma.deal.deleteMany({ where: { id: { in: dealIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { dealReservationBusinessDays: 3 } });
});

describe("Создание сделки резервирует объект с отметкой времени", () => {
  it("reservedAt ставится в момент создания", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const before = Date.now();
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    expect(res.status).toBe(201);
    dealIds.push(res.body.id);

    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("RESERVED");
    expect(after?.reservedAt).not.toBeNull();
    expect(after!.reservedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("releaseExpiredReservations", () => {
  it("объект в резерве меньше срока — не трогает", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    await releaseExpiredReservations();
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("RESERVED");
  });

  it("резерв истёк (3 рабочих дня прошли) — объект возвращается в продажу", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    // Форсируем reservedAt на 5 календарных дней назад — заведомо больше 3 рабочих.
    await prisma.property.update({
      where: { id: property.id },
      data: { reservedAt: new Date(Date.now() - 5 * 24 * 3600_000) },
    });

    const released = await releaseExpiredReservations();
    expect(released).toBeGreaterThanOrEqual(1);

    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("AVAILABLE");
    expect(after?.reservedAt).toBeNull();
    expect(after?.assignedAgentId).toBeNull();

    // Пачка 8 (11.09.2026): БАГ был именно в том, что сделка сама не трогалась —
    // висела открытой по уже свободному объекту (docs/flow-audit-deal-11-09.md).
    // По умолчанию (Settings.dealReservationExpiryAction="cancel") она теперь
    // переводится в CANCELLED и помечается reservationExpiredAt.
    const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(deal?.stage).toBe("CANCELLED");
    expect(deal?.reservationExpiredAt).not.toBeNull();

    const interaction = await prisma.interaction.findFirst({
      where: { clientId: client.id, propertyId: property.id, type: "SYSTEM" },
      orderBy: { createdAt: "desc" },
    });
    expect(interaction?.notes).toContain("Резерв истёк");
  });

  /**
   * Ночная проверка 24.09.2026, круг «Сделки, деньги», находка №3: отменённую
   * сделку (резерв истёк, объект вернулся в продажу, по нему уже завели другую)
   * мог вернуть в рабочую стадию кто угодно и без проверок — запоздавший
   * офлайн-PATCH канбана давал две живые сделки на один объект. Теперь: агент —
   * 403, руководитель при чужой живой сделке — 409, руководитель на свободный
   * объект — можно.
   */
  it("отменённую сделку возвращает в работу только руководитель и только на свободный объект", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    expect(created.status).toBe(201);
    dealIds.push(created.body.id);
    await prisma.property.update({
      where: { id: property.id },
      data: { reservedAt: new Date(Date.now() - 5 * 24 * 3600_000) },
    });
    await releaseExpiredReservations();
    expect((await prisma.deal.findUnique({ where: { id: created.body.id } }))?.stage).toBe("CANCELLED");

    // По освободившемуся объекту заведена вторая, живая сделка.
    const otherClient = await makeClient();
    const second = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: otherClient.id, propertyId: property.id, agentId });
    expect(second.status).toBe(201);
    dealIds.push(second.body.id);

    // Агент (тот самый запоздавший PATCH канбана без version) — не может.
    const byAgent = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ stage: "NEGOTIATION" });
    expect(byAgent.status).toBe(403);
    expect((await prisma.deal.findUnique({ where: { id: created.body.id } }))?.stage).toBe("CANCELLED");

    // Руководитель — тоже нет, пока по объекту идёт другая сделка.
    const byDirector = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "NEGOTIATION" });
    expect(byDirector.status).toBe(409);
    expect((await prisma.deal.findUnique({ where: { id: created.body.id } }))?.stage).toBe("CANCELLED");

    // Вторую сделку отменили — объект свободен, руководитель возвращает первую.
    const cancelSecond = await request(app)
      .patch(`/api/v1/deals/${second.body.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "CANCELLED" });
    expect(cancelSecond.status).toBe(200);
    const revived = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "NEGOTIATION" });
    expect(revived.status).toBe(200);
    expect(revived.body.stage).toBe("NEGOTIATION");
  });

  /**
   * АТОМАРНОСТЬ ПАРЫ «ОБЪЕКТ + СДЕЛКА» (22.09.2026).
   *
   * До этой правки объект освобождался своим запросом, а сделка закрывалась
   * отдельной транзакцией следом. Падение между ними давало ровно то состояние,
   * ради которого Пачка 8 всё это и писала: объект свободен, сделка висит
   * открытой — и следующий проход крона уже НЕ починит, потому что объект больше
   * не в RESERVED и в выборку не попадает.
   *
   * Роняем закрытие сделки и проверяем, что объект остался в резерве: значит
   * откатились обе записи, а не одна.
   */
  it("падение на закрытии сделки откатывает и возврат объекта в продажу", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);
    await prisma.property.update({
      where: { id: property.id },
      data: { reservedAt: new Date(Date.now() - 5 * 24 * 3600_000) },
    });

    mockFailTimelineOnce = true;
    try {
      // С 01.10.2026 (№173 ночной проверки 24.09) сбой одного объекта не
      // обрывает проход: исключение ловится на строке и уходит в журнал, а
      // остальные истёкшие резервы того же тика обрабатываются. Откат самого
      // объекта и сделки проверяется ниже так же, как раньше.
      await expect(releaseExpiredReservations()).resolves.toEqual(expect.any(Number));
    } finally {
      mockFailTimelineOnce = false;
    }

    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("RESERVED");
    expect(after?.reservedAt).not.toBeNull();

    const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(deal?.stage).not.toBe("CANCELLED");

    // И следующий проход, уже без падения, доводит дело до конца — объект снова
    // виден крону, потому что откат вернул его в RESERVED.
    await releaseExpiredReservations();
    const done = await prisma.property.findUnique({ where: { id: property.id } });
    expect(done?.status).toBe("AVAILABLE");
    const dealAfter = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(dealAfter?.stage).toBe("CANCELLED");
  });

  it("настройка dealReservationExpiryAction=\"keep\" не отменяет сделку, только метит её", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { dealReservationExpiryAction: "keep" } });
    try {
      const [client, property] = await Promise.all([makeClient(), makeProperty()]);
      const created = await request(app)
        .post("/api/v1/deals")
        .set("Authorization", `Bearer ${token}`)
        .send({ clientId: client.id, propertyId: property.id, agentId });
      dealIds.push(created.body.id);

      await prisma.property.update({
        where: { id: property.id },
        data: { reservedAt: new Date(Date.now() - 5 * 24 * 3600_000) },
      });

      await releaseExpiredReservations();

      const after = await prisma.property.findUnique({ where: { id: property.id } });
      expect(after?.status).toBe("AVAILABLE");

      const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
      expect(deal?.stage).toBe("NEGOTIATION");
      expect(deal?.reservationExpiredAt).not.toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { dealReservationExpiryAction: "cancel" } });
    }
  });

  it("закрытая (SOLD) сделка джобом не трогается — объект уже не RESERVED", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    await prisma.interaction.create({
      data: {
        clientId: client.id,
        propertyId: property.id,
        agentId,
        type: "SHOWING",
        notes: "Показ",
        completedAt: new Date(),
      },
    });
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);

    const submitted = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({
        stage: "PENDING_APPROVAL",
        soldPrice: Number(property.price),
        commissionRealtorAmount: 1000,
        commissionCompanyAmount: 1000,
      });
    expect(submitted.status).toBe(200);

    const completed = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "COMPLETED" });
    expect(completed.status).toBe(200);

    await releaseExpiredReservations();
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("SOLD");
  });
});

/**
 * Глубокая проверка 02.10.2026, C1: таймер резерва считал срок от СОЗДАНИЯ
 * сделки и отменял любую живую — в том числе «Ждёт одобрения», где агент уже
 * всё сдал и ждут только директора. Директор в отъезде — сделка CANCELLED,
 * объект снова в продаже, вернуть одним «Одобрить» нельзя.
 */
describe("Резерв истёк, а сделка ждёт одобрения (C1)", () => {
  it("сделка не отменяется, объект остаётся в резерве, руководству — одно напоминание", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    expect(created.status).toBe(201);
    dealIds.push(created.body.id);
    await prisma.deal.update({ where: { id: created.body.id }, data: { stage: "PENDING_APPROVAL" } });
    await prisma.property.update({
      where: { id: property.id },
      data: { reservedAt: new Date(Date.now() - 6 * 24 * 3600_000) },
    });

    await releaseExpiredReservations();

    const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(deal?.stage).toBe("PENDING_APPROVAL");
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("RESERVED");
    expect(after?.assignedAgentId).toBe(agentId);
    // Отметка «резерв истёк» — и признак, что напоминание уже ушло.
    expect(deal?.reservationExpiredAt).not.toBeNull();

    // Следующий час: ничего не меняется, отметка та же (повторного напоминания нет).
    await releaseExpiredReservations();
    const again = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(again?.stage).toBe("PENDING_APPROVAL");
    expect(again?.reservationExpiredAt?.getTime()).toBe(deal?.reservationExpiredAt?.getTime());
    const tag = `reservation-expired-held-${created.body.id}`;
    expect(await prisma.pendingDirectorAlert.count({ where: { tag } })).toBe(1);
  });

  // Решение владельца 02.10 «да, по советам»: «Договор подписан» тоже не
  // отменять, а напоминать руководству — не чаще раза в сутки на сделку.
  it("«Договор подписан» тоже не отменяется; напоминание руководству не чаще раза в сутки", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    expect(created.status).toBe(201);
    dealIds.push(created.body.id);
    await prisma.deal.update({ where: { id: created.body.id }, data: { stage: "CONTRACT_SIGNED" } });
    await prisma.property.update({
      where: { id: property.id },
      data: { reservedAt: new Date(Date.now() - 6 * 24 * 3600_000) },
    });
    const tag = `reservation-expired-held-${created.body.id}`;
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });

    await releaseExpiredReservations();
    await releaseExpiredReservations(); // следующий час — второго напоминания нет

    const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(deal?.stage).toBe("CONTRACT_SIGNED");
    expect(deal?.reservationExpiredAt).not.toBeNull();
    const after = await prisma.property.findUnique({ where: { id: property.id } });
    expect(after?.status).toBe("RESERVED");
    const alerts = await prisma.pendingDirectorAlert.findMany({ where: { tag } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].title).toContain("договор подписан");

    // Прошли сутки — повод не устранён, руководству ещё одно напоминание.
    await releaseExpiredReservations(new Date(Date.now() + 25 * 3600_000));
    expect(await prisma.pendingDirectorAlert.count({ where: { tag } })).toBe(2);
    const still = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(still?.stage).toBe("CONTRACT_SIGNED");
    await prisma.pendingDirectorAlert.deleteMany({ where: { tag } });
  });

  it("возврат на доработку после такого ожидания даёт агенту свежий срок резерва", async () => {
    const [client, property] = await Promise.all([makeClient(), makeProperty()]);
    const created = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientId: client.id, propertyId: property.id, agentId });
    dealIds.push(created.body.id);
    await prisma.deal.update({ where: { id: created.body.id }, data: { stage: "PENDING_APPROVAL" } });
    await prisma.property.update({
      where: { id: property.id },
      data: { reservedAt: new Date(Date.now() - 6 * 24 * 3600_000) },
    });
    await releaseExpiredReservations();

    const before = Date.now();
    const rejected = await request(app)
      .patch(`/api/v1/deals/${created.body.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ stage: "CONTRACT_SIGNED", rejectReason: "Нет подписи покупателя" });
    expect(rejected.status).toBe(200);

    const prop = await prisma.property.findUnique({ where: { id: property.id } });
    expect(prop?.status).toBe("RESERVED");
    expect(prop!.reservedAt!.getTime()).toBeGreaterThanOrEqual(before);

    // Ближайший тик не отменяет только что возвращённую на доработку сделку.
    await releaseExpiredReservations();
    const deal = await prisma.deal.findUnique({ where: { id: created.body.id } });
    expect(deal?.stage).toBe("CONTRACT_SIGNED");
  });
});
