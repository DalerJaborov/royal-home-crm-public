import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * РАССЫЛКА ОБЪЕКТА ПО СМС и переход по ссылке из неё (23.09.2026).
 * Провайдер подменён в этом файле: реальные СМС из тестов не уходят никогда, а
 * общую строку Settings трогать нельзя (соседние файлы идут параллельно).
 */

const sent: { phone: string; text: string; clientId?: string | null; propertyId?: string | null }[] = [];
let providerFails = false;

vi.mock("../src/lib/sms/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/sms/index.js")>();
  const { prisma } = await import("../src/db.js");
  return {
    ...orig,
    smsConfigured: async () => true,
    sendSms: async (p: { phone: string; text: string; purpose: string; clientId?: string | null; propertyId?: string | null; agentId?: string | null }) => {
      if (providerFails) return { ok: false, error: "на счёте Payom закончились деньги" };
      sent.push(p);
      const row = await prisma.smsMessage.create({
        data: { phone: orig.toSmsPhone(p.phone)!, purpose: p.purpose, text: p.text, status: "DRY_RUN", clientId: p.clientId ?? null, propertyId: p.propertyId ?? null, agentId: p.agentId ?? null },
      });
      return { ok: true, id: row.id, parts: 2 };
    },
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { waitForSettled } = await import("./helpers/waitFor.js");
const { SMS_SHARE_DAILY_CAP } = await import("../src/routes/properties/smsShare.js");

const tail = String(Date.now()).slice(-6);
const password = "testpass123";
const prevCrmUrl = process.env.CRM_PUBLIC_URL;
let districtId: string;
let agentId: string;
let agentToken: string;
let otherAgentId: string;
let otherToken: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];
const extraAgentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(phone: string, assignedAgentId: string | null) {
  await prisma.client.deleteMany({ where: { phone } });
  const c = await prisma.client.create({ data: { fullName: `Клиент СМС ${phone}`, phone, source: "PHONE_CALL", assignedAgentId } });
  clientIds.push(c.id);
  return c;
}

async function makeProperty(overrides: Record<string, unknown> = {}) {
  const p = await prisma.property.create({
    data: {
      title: `Объект СМС ${tail}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 3,
      areaSqm: 82,
      price: 650000,
      currency: "TJS",
      districtId,
      address: "Тестовая СМС, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      intakeAgentId: agentId,
      createdById: agentId,
      assignedAgentId: agentId,
      ...overrides,
    },
  });
  propertyIds.push(p.id);
  return p;
}

function share(token: string, propertyId: string, ids: string[]) {
  return request(app).post(`/api/v1/properties/${propertyId}/sms-share`).set("Authorization", `Bearer ${token}`).send({ clientIds: ids });
}

beforeAll(async () => {
  process.env.CRM_PUBLIC_URL = "https://crm.example.tj";
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-СМС-${tail}` } })).id;
  const aPhone = `+99277100${tail.slice(-4)}`;
  const bPhone = `+99277200${tail.slice(-4)}`;
  await prisma.agent.deleteMany({ where: { phone: { in: [aPhone, bPhone] } } });
  agentId = (await prisma.agent.create({ data: { fullName: "Шахло Агентова", phone: aPhone, role: "AGENT", passwordHash } })).id;
  otherAgentId = (await prisma.agent.create({ data: { fullName: "Чужой Агент", phone: bPhone, role: "AGENT", passwordHash } })).id;
  agentToken = await login(aPhone);
  otherToken = await login(bPhone);
});

beforeEach(() => {
  sent.length = 0;
  providerFails = false;
});

afterAll(async () => {
  process.env.CRM_PUBLIC_URL = prevCrmUrl;
  await prisma.smsMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  // Интерес пишется «в отрыве» (void recordInterest) — дождаться, пока записи
  // улягутся, иначе строка ляжет после удаления клиента и уронит уборку.
  await waitForSettled(() => prisma.propertyInterestEvent.count({ where: { propertyId: { in: propertyIds } } }));
  await prisma.propertyInterestEvent.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyShareLink.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await deleteAgentsWithTraces([agentId, otherAgentId, ...extraAgentIds]);
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("POST /properties/:id/sms-share", () => {
  it("своему клиенту уходит СМС с личной ссылкой перехода, номером объекта и агентом; в хронологии — SYSTEM, не MESSAGE", async () => {
    const p = await makeProperty({ publishedOnSite: true });
    const c = await makeClient(`+99277300${tail.slice(-4)}`, agentId);
    const res = await share(agentToken, p.id, [c.id]);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
    expect(sent).toHaveLength(1);
    const link = await prisma.propertyShareLink.findFirstOrThrow({ where: { propertyId: p.id, clientId: c.id } });
    expect(sent[0].text).toContain(`https://crm.example.tj/api/v1/l/${link.token}/go`);
    expect(sent[0].text).toContain(`№${p.shortId}`);
    expect(sent[0].text).toContain("Шахло");
    const entry = await prisma.interaction.findFirstOrThrow({ where: { clientId: c.id, propertyId: p.id } });
    expect(entry.type).toBe("SYSTEM");
    expect(entry.agentId).toBe(agentId);
  });

  it("повтор тому же клиенту про тот же объект в течение недели — пропуск, денег не тратит", async () => {
    const p = await makeProperty();
    const c = await makeClient(`+99277400${tail.slice(-4)}`, agentId);
    await share(agentToken, p.id, [c.id]);
    const again = await share(agentToken, p.id, [c.id]);
    expect(again.body.sent).toBe(0);
    expect(again.body.items[0].status).toBe("skipped");
    expect(sent).toHaveLength(1);
  });

  it("чужой клиент (без права видеть всех) и иностранный номер — пропуск", async () => {
    const p = await makeProperty();
    const foreign = await makeClient(`+99277500${tail.slice(-4)}`, otherAgentId);
    const abroad = await makeClient(`+7916${tail}1`, agentId);
    const res = await share(agentToken, p.id, [foreign.id, abroad.id]);
    expect(res.body.sent).toBe(0);
    expect(res.body.items.map((i: { status: string }) => i.status)).toEqual(["skipped", "skipped"]);
    expect(sent).toHaveLength(0);
  });

  it("несайтовый объект чужой агент не рассылает; проданный не рассылает никто", async () => {
    const off = await makeProperty({ offSite: true });
    const c = await makeClient(`+99277600${tail.slice(-4)}`, otherAgentId);
    expect((await share(otherToken, off.id, [c.id])).status).toBe(403);
    const sold = await makeProperty({ status: "SOLD" });
    expect((await share(agentToken, sold.id, [c.id])).status).toBe(400);
  });

  it("отказ провайдера останавливает рассылку на первом же получателе", async () => {
    providerFails = true;
    const p = await makeProperty();
    const a = await makeClient(`+99277700${tail.slice(-4)}`, agentId);
    const b = await makeClient(`+99277800${tail.slice(-4)}`, agentId);
    const res = await share(agentToken, p.id, [a.id, b.id]);
    expect(res.body.sent).toBe(0);
    expect(res.body.items.map((i: { status: string }) => i.status)).toEqual(["failed", "failed"]);
  });
});

describe("GET /l/:token/go — переход из СМС", () => {
  it("опубликованный объект → страница на сайте; отметка «открыл» ставится", async () => {
    const p = await makeProperty({ publishedOnSite: true, siteListingId: 900000 + Number(tail.slice(-5)) });
    const c = await makeClient(`+99277900${tail.slice(-4)}`, agentId);
    await share(agentToken, p.id, [c.id]);
    const link = await prisma.propertyShareLink.findFirstOrThrow({ where: { propertyId: p.id, clientId: c.id } });
    const res = await request(app).get(`/api/v1/l/${link.token}/go`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(new RegExp(`/listing/${p.siteListingId}$`));
    const after = await prisma.propertyShareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(after.viewedAt).not.toBeNull();
  });

  it("несайтовый объект → страница ссылки в CRM, не сайт", async () => {
    const p = await makeProperty({ offSite: true });
    const c = await makeClient(`+99277010${tail.slice(-4)}`, agentId);
    await share(agentToken, p.id, [c.id]);
    const link = await prisma.propertyShareLink.findFirstOrThrow({ where: { propertyId: p.id, clientId: c.id } });
    const res = await request(app).get(`/api/v1/l/${link.token}/go`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`https://crm.example.tj/l/${link.token}`);
  });

  it("отозванная или несуществующая ссылка → главная сайта, а не ошибка", async () => {
    const res = await request(app).get(`/api/v1/l/nope-${tail}/go`);
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain("/listing/");
  });
});

describe("дневной потолок СМС на сотрудника (находка №150, ночная проверка 24.09.2026)", () => {
  let capAgentId: string;
  let capToken: string;

  beforeAll(async () => {
    const phone = `+99277800${tail.slice(-4)}`;
    await prisma.agent.deleteMany({ where: { phone } });
    capAgentId = (await prisma.agent.create({ data: { fullName: "Потолок Агентов", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })).id;
    extraAgentIds.push(capAgentId);
    capToken = await login(phone);
  });

  afterAll(async () => {
    // Агента убирает общий afterAll — после клиентов, которые за ним закреплены.
    await prisma.smsMessage.deleteMany({ where: { agentId: capAgentId } });
  });

  it("сотрудник, исчерпавший сутки, получает 429 по-русски, и ни одно СМС не уходит", async () => {
    await prisma.smsMessage.createMany({
      data: Array.from({ length: SMS_SHARE_DAILY_CAP }, (_, i) => ({
        phone: `+9929330${String(i).padStart(5, "0")}`,
        purpose: "PROPERTY_SHARE",
        text: "уже отправлено",
        status: "DRY_RUN",
        agentId: capAgentId,
      })),
    });
    const p = await makeProperty();
    const c = await makeClient(`+99277900${tail.slice(-4)}`, capAgentId);
    const res = await share(capToken, p.id, [c.id]);
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/СМС/);
    expect(sent).toHaveLength(0);
  });

  it("вчерашние СМС (до полуночи по Душанбе) потолок не съедают", async () => {
    await prisma.smsMessage.updateMany({ where: { agentId: capAgentId }, data: { createdAt: new Date(Date.now() - 36 * 3600 * 1000) } });
    const p = await makeProperty();
    const c = await makeClient(`+99277910${tail.slice(-4)}`, capAgentId);
    const res = await share(capToken, p.id, [c.id]);
    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(1);
  });
});
