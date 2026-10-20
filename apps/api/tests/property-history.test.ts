import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * История объекта (спецификация владельца): каждая смена статуса и
 * ответственного агента пишется в журнал действий — руководитель обязан
 * видеть, кто и когда двигал карточку. Раньше ничего из этого не логировалось.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminId: string;
let adminToken: string;
let secondAgentId: string;
let secondAgentToken: string;
let thirdAgentId: string;
let thirdAgentToken: string;
let propertyId: string;

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-история-${runId}` } })).id;
  const passwordHash = await bcrypt.hash(password, 10);

  adminId = (
    await prisma.agent.create({
      data: { fullName: "Админ истории", phone: `+992940${runId.toString().slice(-6)}`, role: "ADMIN", passwordHash },
    })
  ).id;
  const res = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992940${runId.toString().slice(-6)}`, password });
  adminToken = res.body.accessToken;

  secondAgentId = (
    await prisma.agent.create({
      data: { fullName: "Второй агент истории", phone: `+992941${runId.toString().slice(-6)}`, role: "AGENT", passwordHash },
    })
  ).id;
  const secondLogin = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992941${runId.toString().slice(-6)}`, password });
  secondAgentToken = secondLogin.body.accessToken;

  thirdAgentId = (
    await prisma.agent.create({
      data: { fullName: "Третий агент истории (посторонний)", phone: `+992942${runId.toString().slice(-6)}`, role: "AGENT", passwordHash },
    })
  ).id;
  const thirdLogin = await request(app)
    .post("/api/v1/auth/login")
    .send({ phone: `+992942${runId.toString().slice(-6)}`, password });
  thirdAgentToken = thirdLogin.body.accessToken;

  const created = await request(app)
    .post("/api/v1/properties")
    .set("Authorization", `Bearer ${adminToken}`)
    .send({
      type: "APARTMENT",
      areaSqm: 55,
      rooms: 2,
      floor: 3,
      totalFloors: 9,
      windowCount: 3,
      price: 350000,
      currency: "TJS",
      districtId,
      address: "Тестовая история, 1",
      condition: "GOOD",
      ownerContact: `+992937${runId.toString().slice(-6)}`, // не сидовый номер (staffPhoneGuard, 17.09.2026)
      title: `Объект истории ${runId}`,
      // intakeAgentId должен указывать на действующего сотрудника с ролью
      // AGENT (assignableAgentError, shared.ts) — ADMIN сам себя интейкером
      // назначить не может, только выбрать агента явно.
      intakeAgentId: secondAgentId,
    });
  expect(created.status).toBe(201);
  propertyId = created.body.id;
});

afterAll(async () => {
  // Смена номера собственника правит и карточку продавца, заведённую по этому номеру
  // при создании объекта, с записью в её хронологии от имени админа (24.09.2026,
  // lib/propertyOwnerRelink.ts) — без её уборки агента не удалить.
  const seller = await prisma.property.findUnique({ where: { id: propertyId }, select: { sellerClientId: true } });
  await prisma.auditLog.deleteMany({ where: { entityId: propertyId } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  if (seller?.sellerClientId) {
    await prisma.interaction.deleteMany({ where: { clientId: seller.sellerClientId } });
    await prisma.client.deleteMany({ where: { id: seller.sellerClientId } });
  }
  await prisma.agent.deleteMany({ where: { id: { in: [adminId, secondAgentId, thirdAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Заведение карточки пишется в журнал", () => {
  /**
   * Раньше записи о создании не было вовсе: правка, удаление и восстановление
   * журнал писали, а «кто завёл» держалось только в полях самой карточки и
   * исчезало вместе с ней. Объект для этой проверки создан в beforeAll обычным
   * POST — тем же путём, которым его заводит агент.
   */
  it("POST /properties создаёт запись PROPERTY_CREATED с автором и адресом", async () => {
    const entry = await waitFor(
      async () => {
        const log = await request(app)
          .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
          .set("Authorization", `Bearer ${adminToken}`);
        return log.body.items?.find((e: { action: string }) => e.action === "PROPERTY_CREATED") ?? null;
      },
      { label: "запись PROPERTY_CREATED" }
    );

    expect(entry.agentId).toBe(adminId);
    // Название карточке даёт сервер (buildPropertyTitle), присланное в запросе он
    // игнорирует — в журнале должно стоять то же, что в самой карточке.
    const saved = await prisma.property.findUniqueOrThrow({
      where: { id: propertyId },
      select: { title: true, shortId: true },
    });
    expect(entry.meta.title).toBe(saved.title);
    expect(entry.meta.shortId).toBe(saved.shortId);
    expect(entry.meta.address).toBe("Тестовая история, 1");
    // Новый объект входит в конвейер, а не в продажу (routes/properties/crud.ts) —
    // в журнале должен стоять именно тот статус, с которым карточка родилась.
    expect(entry.meta.status).toBe("AWAITING_PHOTOS");
    expect(entry.meta.intakeAgentId).toBe(secondAgentId);
  });
});

describe("Смена статуса и ответственного пишется в журнал", () => {
  /**
   * НАХОДКА 12.09.2026: объект в beforeAll создаётся без единой фотографии
   * (draftId не передан) — раньше это всё равно давало PENDING_REVIEW (бага
   * routes/properties/crud.ts, статус не зависел от наличия фото), теперь
   * правильно AWAITING_PHOTOS. PATCH здесь двигает статус дальше, на
   * PENDING_REVIEW, чтобы проверка «была/стала» осталась содержательной
   * (была бы холостым PATCH в то же значение, не породи выше запись).
   */
  it("PATCH статуса создаёт запись PROPERTY_STATUS_CHANGED с was/becomes", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "PENDING_REVIEW" });
    expect(res.status).toBe(200);
    // logAudit пишет best-effort, не дожидаясь ответа (см. lib/audit.ts) — даём
    // записи время дойти до базы, иначе следующий GET читает пустоту.
    await new Promise((r) => setTimeout(r, 200));

    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(log.status).toBe(200);
    const entry = log.body.items.find((e: { action: string }) => e.action === "PROPERTY_STATUS_CHANGED");
    expect(entry).toBeDefined();
    expect(entry.meta.was).toBe("AWAITING_PHOTOS");
    expect(entry.meta.becomes).toBe("PENDING_REVIEW");
  });

  it("PATCH ответственного агента создаёт запись PROPERTY_ASSIGNED_AGENT_CHANGED", async () => {
    // Риелтор при создании объекта не назначается (см. routes/properties.ts) —
    // «был» здесь честно null, первое назначение — это переход из пустоты.
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ assignedAgentId: secondAgentId });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    const entry = log.body.items.find((e: { action: string }) => e.action === "PROPERTY_ASSIGNED_AGENT_CHANGED");
    expect(entry).toBeDefined();
    expect(entry.meta.was).toBeNull();
    expect(entry.meta.becomes).toBe(secondAgentId);
  });

  it("правка описания пишет одну запись «поля изменены», а не смену статуса/ответственного", async () => {
    // logAudit пишет вне запроса: записи ПРЕДЫДУЩИХ тестов этого файла могли
    // ещё не приземлиться, и тогда «до» окажется меньше правды, а чужая строка
    // засчиталась бы за нашу. Ждём, пока счётчик перестанет расти.
    const before = await waitForSettled(() => prisma.auditLog.count({ where: { entityId: propertyId } }));
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ description: "просто правка описания" });
    expect(res.status).toBe(200);
    // И «после» тоже даём осесть: иначе запоздавшая запись самого PATCH'а
    // проскочит мимо проверки и поломка останется незамеченной.
    // С 23.09.2026 каждая правка объекта ложится в хронологию (владелец): одна
    // запись PROPERTY_FIELDS_CHANGED, и никаких записей о статусе/ответственном.
    // Под нагрузкой полного прогона запись PATCH-а приземляется позже, чем два
    // замера подряд через 50 мс (25.09.2026: «3 вместо 4» только в полном прогоне),
    // поэтому сначала ждём саму запись, и уже потом — тишины после неё.
    await waitFor(
      async () => ((await prisma.auditLog.count({ where: { entityId: propertyId } })) >= before + 1 ? true : null),
      { label: "запись PROPERTY_FIELDS_CHANGED после PATCH" }
    );
    const after = await waitForSettled(() => prisma.auditLog.count({ where: { entityId: propertyId } }));
    expect(after).toBe(before + 1);
    const last = await prisma.auditLog.findFirst({ where: { entityId: propertyId }, orderBy: { createdAt: "desc" } });
    expect(last?.action).toBe("PROPERTY_FIELDS_CHANGED");
  });

  it("entityId сужает выборку — чужие записи не попадают", async () => {
    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(log.body.items.every((e: { entityId: string }) => e.entityId === propertyId)).toBe(true);
  });
});

/**
 * Открыли историю ОБЪЕКТА рядовому агенту, не имеющему `auditLog.view` —
 * PropertyHistoryCard раньше была видна только руководителю. Право сузили до
 * ровно того же круга людей, что и canManageProperty (routes/properties.ts):
 * назначенный риелтор, интейкер, создатель карточки. Чужой объект агенту без
 * общего права по-прежнему недоступен — предыдущий тест уже назначил
 * secondAgentId риелтором propertyId (PATCH assignedAgentId выше).
 */
describe("Доступ агента к истории своего объекта (без auditLog.view)", () => {
  it("назначенный риелтор объекта видит его историю", async () => {
    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${secondAgentToken}`);
    expect(log.status).toBe(200);
    expect(log.body.items.length).toBeGreaterThan(0);
  });

  it("посторонний агент (не риелтор/интейкер/создатель) получает 403", async () => {
    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${thirdAgentToken}`);
    expect(log.status).toBe(403);
  });

  it("без entityId рядовому агенту общий Архив по-прежнему закрыт", async () => {
    const log = await request(app).get(`/api/v1/audit-log`).set("Authorization", `Bearer ${secondAgentToken}`);
    expect(log.status).toBe(403);
  });

  it("entityType, отличный от Property, рядовому агенту недоступен", async () => {
    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Client&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${secondAgentToken}`);
    expect(log.status).toBe(403);
  });
});

/**
 * КОНВЕЙЕР ВИДИТ ИСТОРИЮ ОБЪЕКТА, КОТОРЫЙ САМ ЖЕ ДВИГАЕТ.
 *
 * Маркетинг и монтажёр не значатся ни риелтором, ни интейкером, ни создателем
 * карточки, и `auditLog.view` им не выдан — узкая выборка по одному объекту
 * отвечала им 403. При этом карточку они правят (canManageProperty пускает по
 * `properties.viewAll`), то есть право «вести объект» и право «видеть, кто его
 * вёл» разошлись: PropertyHistoryCard у них молча пустела, а в консоль на
 * каждое открытие капал 403. Проверено вживую 16.08.2026 под ролью EDITOR.
 */
describe("Доступ конвейера (properties.viewAll) к истории объекта", () => {
  it("монтажёр видит историю объекта, который забирает в монтаж", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const phone = `+992943${runId.toString().slice(-6)}`;
    const editor = await prisma.agent.create({
      data: { fullName: "Монтажёр истории", phone, role: "EDITOR", passwordHash },
    });
    try {
      const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
      const log = await request(app)
        .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
        .set("Authorization", `Bearer ${login.body.accessToken}`);
      expect(log.status).toBe(200);
      expect(log.body.items.length).toBeGreaterThan(0);

      // Послабление узкое: общий Архив монтажёру по-прежнему закрыт.
      const archive = await request(app)
        .get(`/api/v1/audit-log`)
        .set("Authorization", `Bearer ${login.body.accessToken}`);
      expect(archive.status).toBe(403);
    } finally {
      await prisma.agent.deleteMany({ where: { id: editor.id } });
    }
  });
});

/**
 * НОМЕР СОБСТВЕННИКА НЕ УТЕКАЕТ ЧЕРЕЗ ИСТОРИЮ (ночная проверка 24.09.2026).
 *
 * С 23.09.2026 каждая правка карточки ложится в журнал строкой «было → стало»,
 * и «Контакт владельца» — вместе с настоящими номерами. Историю объекта читает
 * и тот, кому сам номер закрыт: монтажёр (properties.editForeign без
 * properties.viewOwners) на карточке видел «скрыто», а строкой ниже — оба
 * номера открытым текстом. Кто видит номер в истории — решает то же правило,
 * что и на карточке (lib/ownerContact.ts): право viewOwners или свой объект.
 */
describe("Контакт владельца в истории объекта закрыт тем, кому закрыт сам номер", () => {
  const oldPhone = `+992937${runId.toString().slice(-6)}`;
  const newPhone = `+992938${runId.toString().slice(-6)}`;
  const editorPhone = `+992944${runId.toString().slice(-6)}`;
  let editorToken: string;
  let editorId: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    await prisma.agent.deleteMany({ where: { phone: editorPhone } });
    editorId = (await prisma.agent.create({ data: { fullName: "Монтажёр без номера", phone: editorPhone, role: "EDITOR", passwordHash } })).id;
    editorToken = (await request(app).post("/api/v1/auth/login").send({ phone: editorPhone, password })).body.accessToken;

    const res = await request(app)
      .patch(`/api/v1/properties/${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ ownerContact: newPhone });
    expect(res.status).toBe(200);
    // logAudit пишет вне запроса — дожидаемся записи со сменой контакта.
    await waitFor(
      async () => {
        const log = await request(app)
          .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
          .set("Authorization", `Bearer ${adminToken}`);
        return ownerContactChange(log.body.items);
      },
      { label: "запись PROPERTY_FIELDS_CHANGED с контактом владельца" }
    );
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: editorId } });
  });

  function ownerContactChange(items: unknown[]): { was: string; becomes: string } | null {
    for (const e of items as { action: string; meta?: { changes?: { field: string; was: string; becomes: string }[] } }[]) {
      if (e.action !== "PROPERTY_FIELDS_CHANGED") continue;
      const change = e.meta?.changes?.find((c) => c.field === "ownerContact");
      if (change) return change;
    }
    return null;
  }

  it("монтажёр (editForeign без viewOwners) получает историю без номеров", async () => {
    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${editorToken}`);
    expect(log.status).toBe(200);
    expect(ownerContactChange(log.body.items)).toEqual({ field: "ownerContact", label: "Контакт владельца", was: "скрыто", becomes: "скрыто" });
    // Ни один номер не должен уехать нигде в ответе — ни в этой записи, ни в соседней.
    const raw = JSON.stringify(log.body);
    expect(raw).not.toContain(oldPhone);
    expect(raw).not.toContain(newPhone);
  });

  it("руководитель (viewOwners) видит настоящие номера «было → стало»", async () => {
    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(log.status).toBe(200);
    expect(ownerContactChange(log.body.items)).toMatchObject({ was: oldPhone, becomes: newPhone });
  });

  it("ответственный риелтор без viewOwners видит номера своего объекта", async () => {
    // secondAgentId назначен риелтором объекта выше (PATCH assignedAgentId) — на
    // карточке номер ему открыт, значит и в истории он открыт.
    const log = await request(app)
      .get(`/api/v1/audit-log?entityType=Property&entityId=${propertyId}`)
      .set("Authorization", `Bearer ${secondAgentToken}`);
    expect(log.status).toBe(200);
    expect(ownerContactChange(log.body.items)).toMatchObject({ was: oldPhone, becomes: newPhone });
  });
});
