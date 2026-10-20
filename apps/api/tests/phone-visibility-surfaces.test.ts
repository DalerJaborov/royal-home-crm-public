import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ТОТ ЖЕ КЛАСС, ЧТО И 21.09.2026 У ОТВЕТОВ ПОСЛЕ ЗАПИСИ (PR #672): правило
 * видимости контакта записано в «своём» разделе и обойдено соседним экраном.
 *
 * Здесь сторожатся два обхода, найденные 22.09.2026 ночным обходом кода:
 *
 * 1. `GET /dashboard/summary`, виджет «Топ объектов». Выборка идёт через
 *    `include`, то есть тянет ВСЕ скаляры Property, а на выдаче стоял один
 *    `stripEmbedding` — вектор резался, `ownerContact` уезжал. Право
 *    `properties.viewOwners` проверялось только в разделе «Объекты», и телефон
 *    собственника четырёх свежих объектов приходил на Главную любому вошедшему.
 *
 * 2. `GET /properties/trash` (Корзина объектов). Единственный хендлер
 *    routes/properties/list.ts, где пара «stripEmbedding + stripOwnerContact»
 *    была разорвана. Право `archive.view` раздаётся галочкой в карточке
 *    сотрудника, и в день, когда «Архив» выдадут агенту или монтажёру, экран
 *    стал бы постраничной выгрузкой контактов по всем удалённым объектам.
 *
 * 3. Имя клиента у ВЛОЖЕННОГО клиента (`GET /calendar/tasks`, «Задачи на
 *    сегодня» и лента активности на Главной). Поле `phone` закрывалось
 *    маской, а `fullName` вида «Входящий +992910001003» — нет: карточки
 *    незнакомых звонивших CRM заводила с открытым номером В ИМЕНИ
 *    (см. lib/clientPhone.ts). Карточка клиента это учитывает (presentClient),
 *    вложенный клиент — не учитывал.
 */

const runId = Date.now();
const password = "testpass123";
const OWNER_CONTACT = `+992900${String(runId).slice(-6)} Собственник`;
// Номер, вписанный в ИМЯ карточки — ровно так CRM заводила незнакомых звонивших
// до 20.08.2026, и такие карточки живут в базе до сих пор.
const PHONE_IN_NAME = `+992918${String(runId).slice(-6)}`;

const agentIds: string[] = [];
let districtId: string;
let propertyId: string;
let clientId: string;
let interactionId: string;
let agentToken: string;
let managerToken: string;
let directorToken: string;
let archiveAgentToken: string;
let deletedPropertyId: string;
const contactProfileIds: string[] = [];
let linkCandidateId: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-phone-vis-${runId}` } })).id;

  const owner = await prisma.agent.create({
    data: { fullName: `Ответственный (phone-vis) ${runId}`, phone: `+992961${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(owner.id);

  // Рядовой агент БЕЗ своих объектов: значит скрыт должен быть КАЖДЫЙ объект
  // виджета, а не «все, кроме своих» — иначе проверка ниже зависела бы от того,
  // что ещё лежит в общей базе стенда.
  const agent = await prisma.agent.create({
    data: { fullName: `Рядовой агент (phone-vis) ${runId}`, phone: `+992962${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(agent.id);

  const manager = await prisma.agent.create({
    data: { fullName: `Менеджер (phone-vis) ${runId}`, phone: `+992963${runId}`, role: "MANAGER", passwordHash },
  });
  agentIds.push(manager.id);

  // Телефон клиента целиком видит только тот, у кого есть clients.viewPhone:
  // у пресета MANAGER его НЕТ (есть clients.viewAll — это другое право, см.
  // комментарий в routes/calendar.ts), поэтому «видно как есть» проверяем
  // директором.
  const director = await prisma.agent.create({
    data: { fullName: `Директор (phone-vis) ${runId}`, phone: `+992964${runId}`, role: "DIRECTOR", passwordHash },
  });
  agentIds.push(director.id);

  // Агент, которому директор выдал галочку «Архив» и НИЧЕГО больше: пресет
  // AGENT не содержит ни archive.view, ни properties.viewOwners.
  const archiveAgent = await prisma.agent.create({
    data: {
      fullName: `Агент с Архивом (phone-vis) ${runId}`,
      phone: `+992965${runId}`,
      role: "AGENT",
      passwordHash,
      permissions: { granted: ["archive.view"], revoked: [] },
    },
  });
  agentIds.push(archiveAgent.id);

  agentToken = await login(`+992962${runId}`);
  managerToken = await login(`+992963${runId}`);
  directorToken = await login(`+992964${runId}`);
  archiveAgentToken = await login(`+992965${runId}`);

  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект phone-vis ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая phone-vis, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner.id,
        createdById: owner.id,
        assignedAgentId: owner.id,
        ownerContact: OWNER_CONTACT,
      } as never,
    })
  ).id;

  deletedPropertyId = (
    await prisma.property.create({
      data: {
        title: `Удалённый объект phone-vis ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 50000,
        currency: "TJS",
        districtId,
        address: "Тестовая phone-vis, 2",
        condition: "GOOD",
        status: "AVAILABLE",
        intakeAgentId: owner.id,
        createdById: owner.id,
        assignedAgentId: owner.id,
        ownerContact: OWNER_CONTACT,
        deletedAt: new Date(),
      } as never,
    })
  ).id;

  clientId = (
    await prisma.client.create({
      data: {
        fullName: `Входящий ${PHONE_IN_NAME}`,
        phone: PHONE_IN_NAME,
        source: "PHONE_CALL",
        acceptedAt: new Date(),
        assignedAgentId: agent.id,
      },
    })
  ).id;

  interactionId = (
    await prisma.interaction.create({
      data: {
        type: "CALL",
        notes: "Звонок с незнакомого номера",
        clientId,
        agentId: agent.id,
        nextAction: "Перезвонить",
        nextActionDate: new Date(),
      },
    })
  ).id;

  // Досье собеседника, у которого вместо имени стоит номер: так приходит
  // WhatsApp, когда человек не заполнил профиль. Пара таких досье попадает в
  // очередь склеек, а право на неё (clients.merge) есть у МЕНЕДЖЕРА, у
  // которого права на номер (clients.viewPhone) нет.
  const left = await prisma.contactProfile.create({
    data: { displayName: PHONE_IN_NAME, nameSource: "profile" },
  });
  const right = await prisma.contactProfile.create({
    data: { displayName: `Клиент ${PHONE_IN_NAME}`, nameSource: "self" },
  });
  contactProfileIds.push(left.id, right.id);
  linkCandidateId = (
    await prisma.contactLinkCandidate.create({
      data: { leftId: left.id, rightId: right.id, reason: "STATED_PHONE" },
    })
  ).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { id: interactionId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, deletedPropertyId] } } });
  await prisma.contactLinkCandidate.deleteMany({ where: { id: linkCandidateId } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: contactProfileIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.deleteMany({ where: { id: districtId } });
});

describe("Главная: виджет «Топ объектов» и право properties.viewOwners", () => {
  it("рядовому агенту контакт собственника не приходит ни по одному объекту виджета", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    // Свой объект в выборке есть всегда (создан выше и он AVAILABLE), поэтому
    // список непустой — проверка не может оказаться пустой формальностью.
    expect(res.body.topProperties.length).toBeGreaterThan(0);
    for (const p of res.body.topProperties) {
      expect(p.ownerContact).toBeFalsy();
      expect(p.ownerContactHidden).toBe(true);
    }
  });

  it("менеджеру контакт приходит, и признак «скрыто» честно false — значит правило вообще применяется, а не поле просто отсутствует", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.topProperties.length).toBeGreaterThan(0);
    for (const p of res.body.topProperties) {
      expect(p.ownerContactHidden).toBe(false);
    }
    const mine = res.body.topProperties.find((p: { id: string }) => p.id === propertyId);
    if (mine) expect(mine.ownerContact).toBe(OWNER_CONTACT);
  });

  it("вектор подбора (embedding) браузеру по-прежнему не уезжает", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${managerToken}`);
    expect(res.status).toBe(200);
    for (const p of res.body.topProperties) {
      expect(p).not.toHaveProperty("embedding");
    }
  });
});

describe("Корзина объектов и право properties.viewOwners", () => {
  it("агенту с галочкой «Архив», но без права на контакт, телефон собственника не приходит", async () => {
    const res = await request(app)
      .get("/api/v1/properties/trash")
      .set("Authorization", `Bearer ${archiveAgentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const p of res.body.items) {
      expect(p.ownerContact).toBeFalsy();
      expect(p.ownerContactHidden).toBe(true);
    }
  });

  it("директору контакт в Корзине приходит как есть", async () => {
    const res = await request(app)
      .get("/api/v1/properties/trash")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const mine = res.body.items.find((p: { id: string }) => p.id === deletedPropertyId);
    expect(mine).toBeTruthy();
    expect(mine.ownerContact).toBe(OWNER_CONTACT);
    expect(mine.ownerContactHidden).toBe(false);
  });
});

describe("Номер внутри имени клиента у вложенной карточки", () => {
  it("календарь: у агента без clients.viewPhone номер не приходит ни в phone, ни в fullName", async () => {
    const res = await request(app).get("/api/v1/calendar/tasks").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const task = res.body.find((t: { id: string }) => t.id === interactionId);
    expect(task).toBeTruthy();
    expect(task.client.phone).not.toContain(PHONE_IN_NAME);
    expect(task.client.fullName).not.toContain(PHONE_IN_NAME);
    // Маска, а не пустое место: по ней видно, что карточка не пустая.
    expect(task.client.fullName).toContain("•");
  });

  it("календарь: директору с правом clients.viewPhone имя приходит как есть", async () => {
    const res = await request(app).get("/api/v1/calendar/tasks").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    const task = res.body.find((t: { id: string }) => t.id === interactionId);
    expect(task).toBeTruthy();
    expect(task.client.fullName).toContain(PHONE_IN_NAME);
  });

  it("Главная: «задачи на сегодня» и лента активности закрывают номер в имени", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    const task = res.body.tasksToday.find((t: { id: string }) => t.id === interactionId);
    expect(task).toBeTruthy();
    expect(task.client.fullName).not.toContain(PHONE_IN_NAME);
    const activity = res.body.recentActivity.find((a: { id: string }) => a.id === interactionId);
    expect(activity).toBeTruthy();
    expect(activity.client.fullName).not.toContain(PHONE_IN_NAME);
  });
});

/**
 * Очередь склеек досье приехала правкой #656 уже после того, как класс был
 * размечен, и повторяет его третий путь: список отдаёт `displayName` как есть.
 * Имя досье — такой же носитель номера, как поле `phone`: у WhatsApp имени
 * часто нет вовсе и транспорт подставляет вместо него сам номер.
 *
 * Пресет MANAGER — ровно тот случай, ради которого проверка и нужна: право
 * «объединять дубликаты» у него ЕСТЬ, право на номер клиента — НЕТ.
 */
describe("Очередь склеек досье и право clients.viewPhone", () => {
  it("менеджер видит имена досье без номера, директор — как есть", async () => {
    const forManager = await request(app)
      .get("/api/v1/contacts/links")
      .set("Authorization", `Bearer ${managerToken}`);
    expect(forManager.status).toBe(200);
    const masked = forManager.body.items.find((i: { id: string }) => i.id === linkCandidateId);
    expect(masked).toBeTruthy();
    expect(JSON.stringify([masked.left, masked.right])).not.toContain(PHONE_IN_NAME);

    const forDirector = await request(app)
      .get("/api/v1/contacts/links")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(forDirector.status).toBe(200);
    const open = forDirector.body.items.find((i: { id: string }) => i.id === linkCandidateId);
    expect(JSON.stringify([open.left, open.right])).toContain(PHONE_IN_NAME);
  });
});
