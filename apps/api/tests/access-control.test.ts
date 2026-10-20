import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let adminId: string;
let agentAId: string;
let agentBId: string;
let clientAId: string;
let clientBId: string;
let propertyAId: string;
let propertyBId: string;
let clientAShortId: number;
let clientBShortId: number;
let propertyAShortId: number;
let dealAId: string;
let dealBId: string;

let adminToken: string;
let agentAToken: string;
let agentBToken: string;

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  // Настройки/сотрудники защищены step-up (428 без свежего подтверждения личности).
  // Здесь тестируются права ролей, а не сам step-up (у него свой блок тестов) —
  // выдаём элевацию напрямую, чтобы не упереться в rate-limit /auth/step-up.
  const agent = await prisma.agent.findUnique({ where: { phone }, select: { id: true } });
  if (agent) grantElevation(agent.id);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);

  const district = await prisma.district.create({ data: { name: `Тест-район-${runId}` } });
  districtId = district.id;

  const admin = await prisma.agent.create({
    data: { fullName: "Тест Админ", phone: `+992990${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;

  const agentA = await prisma.agent.create({
    data: { fullName: "Агент А", phone: `+992991${runId}`, role: "AGENT", passwordHash },
  });
  agentAId = agentA.id;

  const agentB = await prisma.agent.create({
    data: { fullName: "Агент Б", phone: `+992992${runId}`, role: "AGENT", passwordHash },
  });
  agentBId = agentB.id;

  const clientA = await prisma.client.create({
    data: {
      fullName: "Клиент А",
      phone: `+992993${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentAId,
    },
  });
  clientAId = clientA.id;
  clientAShortId = clientA.shortId;

  const clientB = await prisma.client.create({
    data: {
      fullName: "Клиент Б",
      phone: `+992994${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentBId,
    },
  });
  clientBId = clientB.id;
  clientBShortId = clientB.shortId;

  const propertyA = await prisma.property.create({
    data: {
      title: `Тест-объект-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "USD",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      assignedAgentId: agentAId,
      ownerContact: "+992900000099",
    },
  });
  propertyAId = propertyA.id;
  propertyAShortId = propertyA.shortId;

  const dealA = await prisma.deal.create({
    data: { clientId: clientAId, propertyId: propertyAId, agentId: agentAId, stage: "NEGOTIATION" },
  });
  dealAId = dealA.id;
  // «Закрыть сделку» доступна только после проведённого показа — без этой записи
  // PATCH .../dealAId {stage: COMPLETED} ниже отказал бы по новой причине.
  await prisma.interaction.create({
    data: { clientId: clientAId, propertyId: propertyAId, agentId: agentAId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
  });

  // Свой объект, а не propertyAId (30.08.2026: частичный уникальный индекс
  // Deal_active_propertyId_unique запрещает вторую ОДНОВРЕМЕННО активную
  // сделку на тот же объект) — здесь тестируется изоляция сделок по агенту,
  // а не бизнес-правило про один объект/одну сделку, так что объект под
  // dealB не должен совпадать с dealA.
  const propertyB = await prisma.property.create({
    data: {
      title: `Тест-объект-Б-${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "USD",
      districtId,
      address: "Тестовая, 2",
      condition: "GOOD",
      assignedAgentId: agentBId,
      ownerContact: "+992900000098",
    },
  });
  propertyBId = propertyB.id;

  const dealB = await prisma.deal.create({
    data: { clientId: clientBId, propertyId: propertyBId, agentId: agentBId, stage: "NEGOTIATION" },
  });
  dealBId = dealB.id;

  adminToken = await login(admin.phone);
  agentAToken = await login(agentA.phone);
  agentBToken = await login(agentB.phone);
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { phone: `+992986${runId}` } });
  await prisma.deal.deleteMany({ where: { id: { in: [dealAId, dealBId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [clientAId, clientBId] } } });
  await prisma.client.deleteMany({ where: { id: { in: [clientAId, clientBId] } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyAId, propertyBId] } } });
  // По самому агенту, а не по списку его клиентов: раздача лидов могла отдать
  // нашему агенту карточку, которую этот файл не заводил (см. helpers).
  await deleteAgentsWithTraces([adminId, agentAId, agentBId]);
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Клиенты — изоляция по агенту", () => {
  it("агент видит карточку своего клиента", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientAShortId}`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(clientAId);
  });

  it("агент НЕ видит карточку чужого клиента (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientBShortId}`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });

  it("список клиентов агента содержит только своих", async () => {
    const res = await request(app).get("/api/v1/clients?page=1").set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(clientAId);
    expect(ids).not.toContain(clientBId);
  });

  it("admin видит клиентов обоих агентов", async () => {
    const res = await request(app).get("/api/v1/clients?page=1&q=Клиент").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.items.map((c: { id: string }) => c.id);
    expect(ids).toContain(clientAId);
    expect(ids).toContain(clientBId);
  });

  it("агент не может изменить чужого клиента (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${clientBId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ status: "COLD" });
    expect(res.status).toBe(403);
  });

  it("агент не может добавить взаимодействие чужому клиенту (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${clientBId}/interactions`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ type: "CALL", notes: "попытка" });
    expect(res.status).toBe(403);
  });

  it("агент не может назначить нового клиента другому сотруднику (403)", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ fullName: "Чужой клиент", phone: `+992985${runId}`, source: "PHONE_CALL", assignedAgentId: agentBId });
    expect(res.status).toBe(403);
  });

  it("агент не может переназначить своего клиента другому сотруднику (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${clientAId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ assignedAgentId: agentBId });
    expect(res.status).toBe(403);
  });

  it("агент не может подбирать объекты чужому клиенту (403)", async () => {
    const res = await request(app)
      .get(`/api/v1/clients/${clientBId}/match`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });

  it("агент не может вызывать AI-разбор заметки чужого клиента (403)", async () => {
    const res = await request(app)
      .post("/api/v1/ai/parse-note")
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ clientId: clientBId, text: "Тестовая заметка" });
    expect(res.status).toBe(403);
  });
});

describe("Сделки — изоляция по агенту", () => {
  it("список сделок агента содержит только свои", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((d: { id: string }) => d.id);
    expect(ids).toContain(dealAId);
    expect(ids).not.toContain(dealBId);
  });

  it("admin видит все сделки", async () => {
    const res = await request(app).get("/api/v1/deals").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((d: { id: string }) => d.id);
    expect(ids).toContain(dealAId);
    expect(ids).toContain(dealBId);
  });

  it("агент видит карточку клиента чужого назначения, если у него есть сделка с ним", async () => {
    // Свой объект (не propertyAId/propertyBId — оба уже заняты активной
    // сделкой в этот момент теста, см. Deal_active_propertyId_unique):
    // здесь тестируется видимость карточки клиента, объект несущественен.
    const crossProperty = await prisma.property.create({
      data: {
        title: `Тест-объект-В-${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 3",
        condition: "GOOD",
        assignedAgentId: agentAId,
        ownerContact: "+992900000097",
      },
    });
    // Админ создаёт сделку: клиент Б (числится за агентом Б), но сделку ведёт агент А —
    // легитимный кейс (например, админ переназначил сделку отдельно от клиента).
    const crossDeal = await prisma.deal.create({
      data: { clientId: clientBId, propertyId: crossProperty.id, agentId: agentAId, stage: "NEGOTIATION" },
    });
    try {
      const res = await request(app)
        .get(`/api/v1/clients/${clientBShortId}`)
        .set("Authorization", `Bearer ${agentAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(clientBId);
    } finally {
      await prisma.deal.delete({ where: { id: crossDeal.id } });
      await prisma.property.delete({ where: { id: crossProperty.id } });
    }
  });

  it("агент не может менять этап чужой сделки (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealBId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ stage: "CONTRACT_SIGNED" });
    expect(res.status).toBe(403);
  });

  it("агент не может создать сделку для чужого клиента (403)", async () => {
    const res = await request(app)
      .post("/api/v1/deals")
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ clientId: clientBId, propertyId: propertyAId, agentId: agentBId });
    expect(res.status).toBe(403);
  });

  it("агент не может закрыть сделку сам (403)", async () => {
    // Закрытие — необратимое денежное событие: снапшот выплат, объект «Продано»,
    // публикация на сайте. Подтверждает его руководитель, а не получатель комиссии.
    const res = await request(app)
      .patch(`/api/v1/deals/${dealAId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ stage: "COMPLETED" });
    expect(res.status).toBe(403);
  });

  it("агент не может задать себе сумму комиссии (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealAId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ commissionAmount: 500000 });
    expect(res.status).toBe(403);
  });

  it("агент двигает сделку по стадиям как обычно (200)", async () => {
    const res = await request(app)
      .patch(`/api/v1/deals/${dealAId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ stage: "CONTRACT_SIGNED" });
    expect(res.status).toBe(200);
  });

  it("только одна сделка может продать объект", async () => {
    const submitted = await request(app)
      .patch(`/api/v1/deals/${dealAId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        stage: "PENDING_APPROVAL",
        soldPrice: 1000,
        commissionRealtorAmount: 0,
        commissionCompanyAmount: 0,
      });
    expect(submitted.status).toBe(200);

    const first = await request(app)
      .patch(`/api/v1/deals/${dealAId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ stage: "COMPLETED" });
    expect(first.status).toBe(200);

    // Директор теперь может закрыть сделку и напрямую (19.08.2026), минуя
    // отправку на согласование — но для этого нужны те же данные, что и в
    // обычном потоке. Шлём их, чтобы проверка дошла до настоящего конфликта
    // (объект уже продан другой сделкой), а не споткнулась раньше на пустых полях.
    const second = await request(app)
      .patch(`/api/v1/deals/${dealBId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        stage: "COMPLETED",
        soldPrice: 1000,
        commissionRealtorAmount: 0,
        commissionCompanyAmount: 0,
      });
    expect(second.status).toBe(409);

    const property = await prisma.property.findUnique({ where: { id: propertyAId } });
    expect(property?.status).toBe("SOLD");
  });

  it("правка комиссии закрытой сделки пересчитывает снапшот долей", async () => {
    // Иначе Финансы показывали выплаты от старой суммы, а валовую комиссию — от новой,
    // и отчёт переставал сходиться сам с собой.
    const res = await request(app)
      .patch(`/api/v1/deals/${dealAId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ commissionAmount: 20000 });
    expect(res.status).toBe(200);
    const sum =
      Number(res.body.commissionIntakeAmount) +
      Number(res.body.commissionRealtorAmount) +
      Number(res.body.commissionCompanyAmount);
    expect(sum).toBe(20000);
  });
});

describe("Объекты — видимость контакта владельца", () => {
  it("назначенный агент видит ownerContact", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyAShortId}`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBeTruthy();
  });

  it("не назначенный агент НЕ видит ownerContact", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyAShortId}`)
      .set("Authorization", `Bearer ${agentBToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBeNull();
  });

  it("admin видит ownerContact в любом случае", async () => {
    const res = await request(app)
      .get(`/api/v1/properties/${propertyAShortId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ownerContact).toBeTruthy();
  });

  it("не назначенный агент не может изменить чужой объект (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/properties/${propertyAId}`)
      .set("Authorization", `Bearer ${agentBToken}`)
      .send({ price: 41000 });
    expect(res.status).toBe(403);
  });
});

describe("Распределение лидов и контакты до принятия", () => {
  let leadId: string;
  let leadShortId: number;

  it("лид без явного агента распределяется автоматически на агента (role AGENT)", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: "Лид Распределяемый", phone: `+992986${runId}`, source: "WEBSITE", force: true });
    expect(res.status).toBe(201);
    expect(res.body.acceptedAt).toBeNull();
    expect(res.body.pendingAcceptance).toBe(true);
    const assignee = await prisma.agent.findUnique({ where: { id: res.body.assignedAgentId } });
    expect(assignee?.role).toBe("AGENT");
    leadId = res.body.id;
    leadShortId = res.body.shortId;
    // Для детерминированности дальнейших проверок закрепляем лид за агентом А
    await prisma.client.update({ where: { id: leadId }, data: { assignedAgentId: agentAId } });
  });

  it("до принятия агент видит лид с замаскированным телефоном", async () => {
    const res = await request(app).get(`/api/v1/clients/${leadShortId}`).set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pendingAcceptance).toBe(true);
    expect(res.body.phone).toContain("•");
    expect(res.body.phone).not.toBe(`+992986${runId}`);
  });

  it("admin видит телефон лида без маски и до принятия", async () => {
    const res = await request(app).get(`/api/v1/clients/${leadShortId}`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe(`+992986${runId}`);
  });

  it("до принятия агент не может добавить взаимодействие (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${leadId}/interactions`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ type: "CALL", notes: "попытка до принятия" });
    expect(res.status).toBe(403);
  });

  it("до принятия агент не может менять карточку (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${leadId}`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ status: "CONTACTED" });
    expect(res.status).toBe(403);
  });

  it("чужой агент не может принять лид (409 «уже у другого»)", async () => {
    const res = await request(app)
      .post(`/api/v1/clients/${leadId}/accept`)
      .set("Authorization", `Bearer ${agentBToken}`);
    expect(res.status).toBe(409);
  });

  it("после принятия открывается работа с карточкой, но телефон агенту не показывается никогда", async () => {
    const accept = await request(app)
      .post(`/api/v1/clients/${leadId}/accept`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(accept.status).toBe(200);
    // Решение владельца 07.08.2026, вместе с запуском телефонии: номер клиента агенту
    // закрыт и после принятия. Раньше он открывался целиком, и агент мог позвонить со
    // своего мобильного мимо CRM — без записи разговора, без следа в хронологии, а при
    // уходе сотрудника клиент уходил вместе с содержимым его телефонной книжки.
    // Звонить теперь можно только кнопкой: номер набирает АТС.
    expect(accept.body.phone).not.toBe(`+992986${runId}`);
    expect(accept.body.phone).toContain("•");
    expect(accept.body.pendingAcceptance).toBe(false);

    const interaction = await request(app)
      .post(`/api/v1/clients/${leadId}/interactions`)
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ type: "CALL", notes: "первый звонок после принятия" });
    expect(interaction.status).toBe(201);
  });
});

describe("Профиль (/me) — самообслуживание", () => {
  it("агент видит свой профиль", async () => {
    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(agentAId);
  });

  it("агент может сменить своё имя без пароля", async () => {
    const res = await request(app)
      .patch("/api/v1/me")
      .set("Authorization", `Bearer ${agentAToken}`)
      .send({ fullName: "Агент А (переименован)" });
    expect(res.status).toBe(200);
    expect(res.body.fullName).toBe("Агент А (переименован)");
  });

});

describe("Агенты — удаление и аватар (только admin)", () => {
  it("не-админ не может удалить агента (403)", async () => {
    const res = await request(app)
      .delete(`/api/v1/agents/${agentBId}`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });

  it("не-админ не может загрузить аватар агента (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/agents/${agentAId}/avatar`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });

  it("admin не может удалить собственную учётную запись (400)", async () => {
    const res = await request(app)
      .delete(`/api/v1/agents/${adminId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);

    const stillExists = await prisma.agent.findUnique({ where: { id: adminId } });
    expect(stillExists).not.toBeNull();
  });

  it("admin не может стереть строку агента со связанными сделками — учётка отключается и освобождает телефон (200)", async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const tempAgent = await prisma.agent.create({
      data: { fullName: "Временный агент", phone: `+992995${runId}`, role: "AGENT", passwordHash },
    });
    const tempClient = await prisma.client.create({
      data: {
        fullName: "Временный клиент",
        phone: `+992996${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: tempAgent.id,
      },
    });
    // Свой объект — propertyAId уже занят активной сделкой dealA в это время
    // выполнения (Deal_active_propertyId_unique); здесь тестируется отключение
    // агента со связанной сделкой, объект несущественен.
    const tempProperty = await prisma.property.create({
      data: {
        title: `Тест-объект-Г-${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "USD",
        districtId,
        address: "Тестовая, 4",
        condition: "GOOD",
        assignedAgentId: tempAgent.id,
        ownerContact: "+992900000096",
      },
    });
    const tempDeal = await prisma.deal.create({
      data: { clientId: tempClient.id, propertyId: tempProperty.id, agentId: tempAgent.id, stage: "NEGOTIATION" },
    });

    try {
      /**
       * Сделка держит учётку: комиссию задним числом не переписывают, поэтому
       * такого сотрудника не стирают, а отключают и освобождают телефон (решение
       * владельца 18.08.2026, см. DELETE /agents/:id) — 200 с отчётом о раздаче
       * клиентов, а не 409: для владельца отключённая и невидимая учётка это и
       * есть «удалил», а не отказ операции.
       */
      const res = await request(app)
        .delete(`/api/v1/agents/${tempAgent.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.deactivatedInsteadOfDeleted).toBe(true);
      expect(res.body.handover).toBeDefined();
      expect(typeof res.body.handover.clients).toBe("number");

      const deactivated = await prisma.agent.findUniqueOrThrow({ where: { id: tempAgent.id } });
      expect(deactivated.isActive).toBe(false);
      expect(deactivated.phone).toContain(`${tempAgent.id}-deleted:`);
    } finally {
      await prisma.deal.deleteMany({ where: { id: tempDeal.id } });
      await prisma.client.deleteMany({ where: { id: tempClient.id } });
      await prisma.agent.deleteMany({ where: { id: tempAgent.id } });
      await prisma.property.deleteMany({ where: { id: tempProperty.id } });
    }
  });
});

describe("Доступ без токена", () => {
  it("запрос без Authorization отклоняется (401)", async () => {
    const res = await request(app).get("/api/v1/clients");
    expect(res.status).toBe(401);
  });

  it("агент не может управлять другими агентами (403)", async () => {
    const res = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });
});

describe("Финансы, Команда, Импорт — только руководство", () => {
  it("агент не видит финансы (403)", async () => {
    const res = await request(app).get("/api/v1/expenses/summary").set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });

  it("админ видит финансовую сводку (200)", async () => {
    const res = await request(app).get("/api/v1/expenses/summary").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.months)).toBe(true);
  });

  it("админ создаёт и удаляет расход", async () => {
    const created = await request(app)
      .post("/api/v1/expenses")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ category: "ADVERTISING", source: "INSTAGRAM", amount: 500, month: "2026-07" });
    expect(created.status).toBe(201);
    const del = await request(app)
      .delete(`/api/v1/expenses/${created.body.id}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(del.status).toBe(204);
  });

  it("агент не видит экран Команда (403), админ видит (200)", async () => {
    const agentRes = await request(app).get("/api/v1/team").set("Authorization", `Bearer ${agentAToken}`);
    expect(agentRes.status).toBe(403);
    const adminRes = await request(app).get("/api/v1/team").set("Authorization", `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body.some((m: { id: string }) => m.id === agentAId)).toBe(true);
  });

  it("агент не может импортировать клиентов (403)", async () => {
    const res = await request(app)
      .post("/api/v1/import/clients")
      .set("Authorization", `Bearer ${agentAToken}`)
      .attach("file", Buffer.from("Имя;Телефон\nТест;+992000000000\n"), "clients.csv");
    expect(res.status).toBe(403);
  });

  it("импорт клиентов: валидные создаются, дубликаты пропускаются", async () => {
    // Свой хвост из 9 цифр (02.10.2026): у остальных номеров файла последние 9
    // цифр — одни и те же (хвост runId), а импорт с B8 сверяет дубли именно по ним.
    const phone = `+992983${String(runId).slice(-6)}`;
    const csv = `Имя;Телефон;Источник\nИмпорт Тестовый;${phone};Instagram\nБез Телефона;;Сайт\n`;
    const res = await request(app)
      .post("/api/v1/import/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .attach("file", Buffer.from(`﻿${csv}`), "clients.csv");
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped.length).toBe(1);
    await prisma.client.deleteMany({ where: { phone } });
  });

  it("агент не видит дубликаты клиентов (403)", async () => {
    const res = await request(app).get("/api/v1/clients/duplicates").set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });

  it("агент не выгружает весь каталог объектов (403)", async () => {
    // Выгрузка мимо пагинации по 20 — готовый дамп базы; управленческое действие.
    const res = await request(app)
      .get("/api/v1/properties/export?format=json")
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(403);
  });

  it("агенту в Настройках не видно ни промта бота, ни структуры комиссии", async () => {
    // Курс валюты нужен интерфейсу (сведение сумм) — он остаётся; всё остальное нет.
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.usdToTjsRate !== undefined).toBe(true);
    expect(res.body.botSystemPrompt).toBeUndefined();
    expect(res.body.commissionIntakePercent).toBeUndefined();
    expect(res.body.monthlyCommissionPlan).toBeUndefined();
    expect(res.body.anthropicApiKeyMasked).toBeUndefined();
    expect(res.body.kpiMinThreshold).toBeUndefined();
  });

  it("админ по-прежнему видит Настройки целиком", async () => {
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.botSystemPrompt).toBeTruthy();
    expect(res.body.commissionIntakePercent).toBeDefined();
  });

  it("агент не читает ленту взаимодействий чужого агента", async () => {
    // ?agentId=<чужой> раньше постранично отдавал заметки коллег по клиентам,
    // карточки которых тому же агенту отвечают 403.
    const res = await request(app)
      .get(`/api/v1/interactions?agentId=${agentBId}`)
      .set("Authorization", `Bearer ${agentAToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items.every((i: { agentId: string }) => i.agentId === agentAId)).toBe(true);
  });
});

describe("Роль DIRECTOR — иерархия прав", () => {
  let directorId: string;
  let directorToken: string;
  let director2Id: string | undefined;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const director = await prisma.agent.create({
      data: { fullName: "Тест Директор", phone: `+992996${runId}`, role: "DIRECTOR", passwordHash },
    });
    directorId = director.id;
    directorToken = await login(director.phone);
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({
      where: { id: { in: [directorId, ...(director2Id ? [director2Id] : [])] } },
    });
  });

  it("директор проходит админ-проверки (список агентов доступен)", async () => {
    const res = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
  });

  it("админ НЕ может создать директора (403)", async () => {
    const res = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ fullName: "Самозванец", phone: `+992997${runId}`, role: "DIRECTOR", password });
    expect(res.status).toBe(403);
  });

  it("админ НЕ может изменить учётку директора (403)", async () => {
    const res = await request(app)
      .patch(`/api/v1/agents/${directorId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it("админ НЕ может удалить директора (403)", async () => {
    const res = await request(app)
      .delete(`/api/v1/agents/${directorId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(403);
  });

  /**
   * Дыра, найденная аудитом 06.08.2026: учётку директора админ тронуть не мог
   * (PATCH/DELETE/аватар отдавали 403), а вот ПЕРЕДАЧУ ДЕЛ — мог. Одним запросом
   * все клиенты, задачи и объекты директора уезжали выбранному сотруднику.
   * Защита учётки, которую можно обойти по соседнему маршруту, — не защита.
   */
  it("админ НЕ может передать дела директора другому сотруднику (403)", async () => {
    const res = await request(app)
      .post(`/api/v1/agents/${directorId}/handover`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ toAgentId: agentAId });
    expect(res.status).toBe(403);
  });

  it("директор передать дела директора может", async () => {
    const res = await request(app)
      .post(`/api/v1/agents/${directorId}/handover`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ toAgentId: agentAId });
    expect(res.status).toBe(200);
  });

  it("директор может создать директора и управлять его учёткой", async () => {
    const created = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ fullName: "Второй Директор", phone: `+992998${runId}`, role: "DIRECTOR", password });
    expect(created.status).toBe(201);
    director2Id = created.body.id as string;

    // Деактивация второго директора допустима: первый остаётся активным.
    const updated = await request(app)
      .patch(`/api/v1/agents/${director2Id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ isActive: false });
    expect(updated.status).toBe(200);
  });

  /**
   * Fair Play (спецификация 03.08.2026, Royal Score Engine, часть 2): «Ручное
   * изменение KPI запрещено. Ни агент. Ни руководитель. Ни администратор». Поле
   * `kpi` убрано из agentUpdateSchema целиком — даже у директора, у которого раньше
   * было право `score.override`, счёт через PATCH больше не меняется.
   */
  it("даже директор не может поменять Royal Score через PATCH — поле тихо игнорируется", async () => {
    const target = await prisma.agent.create({
      data: {
        fullName: "Цель ручной правки",
        phone: `+992995${runId}`,
        role: "AGENT",
        passwordHash: await bcrypt.hash(password, 10),
        kpi: 42,
      },
    });
    const res = await request(app)
      .patch(`/api/v1/agents/${target.id}`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ kpi: 99 });
    expect(res.status).toBe(200);
    const after = await prisma.agent.findUnique({ where: { id: target.id } });
    expect(after?.kpi).toBe(42);
    await prisma.agent.deleteMany({ where: { id: target.id } });
  });

  it("директор сохраняет настройки компании (доступ уровня админа)", async () => {
    const current = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${directorToken}`);
    expect(current.status).toBe(200);
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ companyName: current.body.companyName });
    expect(res.status).toBe(200);
  });

  /**
   * Раздел «Настройки Royal Score» (решение владельца 03.08.2026): цена события,
   * окно расчёта и стартовый счёт правятся через тот же PATCH /settings, что и
   * веса KPI. kpi_override/lead_missed сюда не входят — устаревшие виды событий.
   *
   * Настройка общая на всю базу (singleton) и читается computeRoyalScore в
   * ДРУГИХ тестовых файлах — меняем и обязательно возвращаем как было, иначе
   * окно/старт "утекают" в соседние тесты, запущенные в этом же прогоне.
   */
  describe("Настройки Royal Score", () => {
    let before: { royalScoreEventPoints: unknown; royalScoreWindowDays: number; royalScoreStartingScore: number } | null;

    beforeAll(async () => {
      before = await prisma.settings.findUnique({
        where: { id: "singleton" },
        select: { royalScoreEventPoints: true, royalScoreWindowDays: true, royalScoreStartingScore: true },
      });
    });

    afterAll(async () => {
      // Явный null, а НЕ undefined: Prisma пропускает undefined-поля при update,
      // и правка из теста (deal_closed: 12) осталась бы в singleton навсегда —
      // ровно так это и утекло в royal-score-engine.test.ts при первом запуске.
      await prisma.settings.update({
        where: { id: "singleton" },
        data: {
          royalScoreEventPoints: (before?.royalScoreEventPoints as object | null) ?? null,
          royalScoreWindowDays: before?.royalScoreWindowDays ?? 30,
          royalScoreStartingScore: before?.royalScoreStartingScore ?? 100,
        },
      });
    });

    it("директор меняет цену события, окно и стартовый счёт Royal Score", async () => {
      const res = await request(app)
        .patch("/api/v1/settings")
        .set("Authorization", `Bearer ${directorToken}`)
        .send({
          royalScoreEventPoints: { deal_closed: 12, property_rework_fixed: 2.7 },
          royalScoreWindowDays: 45,
          royalScoreStartingScore: 80,
        });
      expect(res.status).toBe(200);
      expect(res.body.royalScoreEventPoints).toEqual({ deal_closed: 12, property_rework_fixed: 2.7 });
      expect(res.body.royalScoreWindowDays).toBe(45);
      expect(res.body.royalScoreStartingScore).toBe(80);
    });

    it("устаревший вид события (kpi_override) не принимается схемой", async () => {
      const res = await request(app)
        .patch("/api/v1/settings")
        .set("Authorization", `Bearer ${directorToken}`)
        .send({ royalScoreEventPoints: { kpi_override: 99 } });
      expect(res.status).toBe(400);
    });

    it("окно расчёта вне границ (0 дней) отклоняется", async () => {
      const res = await request(app)
        .patch("/api/v1/settings")
        .set("Authorization", `Bearer ${directorToken}`)
        .send({ royalScoreWindowDays: 0 });
      expect(res.status).toBe(400);
    });
  });
});

/**
 * Ночная проверка 24.09.2026 (находка №146/П4), решение владельца — ДА: у роли
 * SECURITY нет собственного управления сотрудниками, но фильтр по агенту на
 * её экранах (например «Проверка причин закрытия») должен работать — для
 * этого нужен справочник сотрудников, а не только agents.manage/clients.assign.
 * До починки маршрут отдавал 403 право team.viewFull у пресета отсутствовало.
 */
describe("Роль SECURITY — справочник сотрудников для фильтра (team.viewFull)", () => {
  let securityId: string;
  let securityToken: string;

  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(password, 10);
    const securityPhone = `+992989${runId}`;
    const security = await prisma.agent.create({
      data: { fullName: "Тест СБ", phone: securityPhone, role: "SECURITY", passwordHash },
    });
    securityId = security.id;
    securityToken = await login(securityPhone);
  });

  afterAll(async () => {
    await prisma.agent.deleteMany({ where: { id: securityId } });
  });

  it("СБ получает список сотрудников (200, непустой) — раньше был 403", async () => {
    const res = await request(app).get("/api/v1/agents").set("Authorization", `Bearer ${securityToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.some((m: { id: string }) => m.id === agentAId)).toBe(true);
    // Справочник для фильтра, не карточка сотрудника — учётные данные (телефон/email)
    // видит только agents.manage; урезанный вид, как у MANAGER, это не регресс.
    expect(res.body[0].phone).toBeUndefined();
  });
});

describe("Step-up защита настроек (sudo-режим)", () => {
  let phone: string;
  let token: string;
  let agentId: string;

  beforeAll(async () => {
    phone = `+992996${runId}`;
    const passwordHash = await bcrypt.hash(password, 10);
    const admin = await prisma.agent.create({
      data: { fullName: "Админ без элевации", phone, role: "ADMIN", passwordHash },
    });
    agentId = admin.id;
    // Логин напрямую, БЕЗ хелпера login() — он выдаёт элевацию автоматически.
    const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
    expect(res.status).toBe(200);
    token = res.body.accessToken as string;
  });

  afterAll(async () => {
    await prisma.agent.delete({ where: { id: agentId } }).catch(() => {});
  });

  it("PATCH /settings без step-up отклоняется (428)", async () => {
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ companyName: "Hack Home" });
    expect(res.status).toBe(428);
    expect(res.body.stepUpRequired).toBe(true);
  });

  it("step-up с неверным паролем отклоняется (401)", async () => {
    const res = await request(app)
      .post("/api/v1/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  it("после step-up с верным паролем настройки сохраняются", async () => {
    const stepUp = await request(app)
      .post("/api/v1/auth/step-up")
      .set("Authorization", `Bearer ${token}`)
      .send({ password });
    expect(stepUp.status).toBe(200);
    expect(stepUp.body.elevated).toBe(true);

    const current = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${token}`);
    const res = await request(app)
      .patch("/api/v1/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ companyName: current.body.companyName });
    expect(res.status).toBe(200);
  });
});
