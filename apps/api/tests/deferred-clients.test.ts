import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { createLeadFromChannel } from "../src/leads.js";
import {
  deferClient,
  returnDeferredClientManually,
  runDeferredClientsReturnTick,
} from "../src/lib/deferredClients.js";

/**
 * «ОТЛОЖЕННЫЕ» (задача G, план вечерней сессии 03-04.09.2026, решение владельца):
 * EXPENSIVE/FINANCE_ISSUE/WRONG_OBJECT перестают вести к обычному отказу/передаче
 * и уходят в Client.workStatus=DEFERRED — слот освобождается, никто не звонит,
 * агент не штрафуется, возврат по таймеру (3 мес/1 мес) или раньше срока, если
 * клиент написал/позвонил сам.
 */

const runId = Date.now();
const password = "testpass123";
const DAY = 24 * 60 * 60 * 1000;

let agentId: string;
let otherAgentId: string;
let directorId: string;
let token: string;
let otherToken: string;
let directorToken: string;
const clientIds: string[] = [];
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(extra: Record<string, unknown> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент отложенных ${runId}-${clientIds.length}`,
      phone: `+992920${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      budgetMax: 400000,
      ...extra,
    },
  });
  clientIds.push(c.id);
  return c;
}

async function makeShowing(clientId: string) {
  return prisma.interaction.create({
    data: { clientId, agentId, type: "SHOWING", notes: "Показ объекта", completedAt: new Date() },
  });
}

function refuse(clientId: string, body: Record<string, unknown>, useToken = token) {
  return request(app)
    .post(`/api/v1/clients/${clientId}/refuse`)
    .set("Authorization", `Bearer ${useToken}`)
    .send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: `Агент отложенных ${runId}`, phone: `+992921${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(agentId);
  otherAgentId = (
    await prisma.agent.create({
      data: { fullName: `Другой агент отложенных ${runId}`, phone: `+992922${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  agentIds.push(otherAgentId);
  directorId = (
    await prisma.agent.create({
      data: { fullName: `Директор отложенных ${runId}`, phone: `+992923${runId}`, role: "DIRECTOR", passwordHash },
    })
  ).id;
  agentIds.push(directorId);

  token = await login(`+992921${runId}`);
  otherToken = await login(`+992922${runId}`);
  directorToken = await login(`+992923${runId}`);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
  await prisma.$disconnect();
});

describe("POST /clients/:id/refuse — EXPENSIVE/FINANCE_ISSUE/WRONG_OBJECT уходят в «Отложенные»", () => {
  it("EXPENSIVE: workStatus=DEFERRED, слот освобождён, refusalCount не растёт, срок — 3 месяца", async () => {
    const c = await makeClient();
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "просит скидку 20%" });
    expect(res.status).toBe(200);
    expect(res.body.deferred).toBe(true);
    expect(res.body.deferredUntil).toBeTruthy();

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("DEFERRED");
    // Агент НЕ меняется — карточка остаётся его, это не передача.
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.refusalCount).toBe(0);
    expect(after?.deferredReason).toBe("EXPENSIVE");
    expect(after?.deferredAt).not.toBeNull();
    expect(after?.deferredUntil).not.toBeNull();

    const days = (after!.deferredUntil!.getTime() - after!.deferredAt!.getTime()) / DAY;
    // ~3 месяца — допуск на календарные различия длины месяца (28-31 день).
    expect(days).toBeGreaterThan(85);
    expect(days).toBeLessThan(95);

    const note = await prisma.interaction.findFirst({ where: { clientId: c.id, type: "SYSTEM" } });
    expect(note?.notes).toContain("отложен");
  });

  it("WRONG_OBJECT: срок отсрочки — 1 месяц (подборка меняется быстрее)", async () => {
    const c = await makeClient();
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "WRONG_OBJECT", initiator: "AGENT", comment: "ничего не подошло" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("DEFERRED");
    const days = (after!.deferredUntil!.getTime() - after!.deferredAt!.getTime()) / DAY;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(33);
  });

  it("FINANCE_ISSUE: та же отсрочка 3 месяца, что и EXPENSIVE", async () => {
    const c = await makeClient();
    await makeShowing(c.id);
    const res = await refuse(c.id, { reason: "FINANCE_ISSUE", initiator: "AGENT", comment: "ипотеку не одобрили" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("DEFERRED");
    const days = (after!.deferredUntil!.getTime() - after!.deferredAt!.getTime()) / DAY;
    expect(days).toBeGreaterThan(85);
    expect(days).toBeLessThan(95);
  });

  it("отложенный клиент освобождает слот в лимите активных лидов", async () => {
    const { activeLeadCounts } = await import("../src/lib/leadLimits.js");
    const before = (await activeLeadCounts([agentId])).get(agentId)?.total ?? 0;
    const c = await makeClient();
    const afterCreate = (await activeLeadCounts([agentId])).get(agentId)?.total ?? 0;
    expect(afterCreate).toBe(before + 1);

    await makeShowing(c.id);
    await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "дорого вышло" });
    const afterDefer = (await activeLeadCounts([agentId])).get(agentId)?.total ?? 0;
    expect(afterDefer).toBe(before);
  });

  it("EXPENSIVE до показа — тот же гейт 409, что и у обычного «Без сделки»", async () => {
    const c = await makeClient();
    const res = await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "заранее дорого" });
    expect(res.status).toBe(409);
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("ACTIVE");
  });
});

describe("GET /clients/deferred", () => {
  it("агент видит только свои отложенные, директор — все", async () => {
    const mine = await makeClient({ fullName: `Мой отложенный ${runId}` });
    await makeShowing(mine.id);
    await refuse(mine.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "дорого для него" });

    const foreign = await makeClient({ fullName: `Чужой отложенный ${runId}`, assignedAgentId: otherAgentId });
    await prisma.interaction.create({
      data: { clientId: foreign.id, agentId: otherAgentId, type: "SHOWING", notes: "Показ", completedAt: new Date() },
    });
    await refuse(foreign.id, { reason: "WRONG_OBJECT", initiator: "AGENT", comment: "не подошло" }, otherToken);

    const mineList = await request(app).get("/api/v1/clients/deferred").set("Authorization", `Bearer ${token}`);
    expect(mineList.status).toBe(200);
    const mineIds = (mineList.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(mineIds).toContain(mine.id);
    expect(mineIds).not.toContain(foreign.id);

    const directorList = await request(app)
      .get("/api/v1/clients/deferred")
      .set("Authorization", `Bearer ${directorToken}`);
    expect(directorList.status).toBe(200);
    const directorIds = (directorList.body.items as Array<{ id: string }>).map((i) => i.id);
    expect(directorIds).toContain(mine.id);
    expect(directorIds).toContain(foreign.id);
  });
});

describe("Ранний возврат — клиент написал/позвонил сам до срока", () => {
  it("createLeadFromChannel возвращает отложенного клиента в ACTIVE тому же агенту, таймер снят", async () => {
    const c = await makeClient({ fullName: `Вернулся сам ${runId}` });
    await makeShowing(c.id);
    await refuse(c.id, { reason: "EXPENSIVE", initiator: "AGENT", comment: "дорого показалось" });
    const deferred = await prisma.client.findUnique({ where: { id: c.id } });
    expect(deferred?.workStatus).toBe("DEFERRED");

    const result = await createLeadFromChannel({
      fullName: c.fullName,
      phone: c.phone,
      source: "WHATSAPP",
      requirementsNotes: "снова готов смотреть варианты",
    });
    expect(result.created).toBe(false);
    expect(result.clientId).toBe(c.id);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("ACTIVE");
    expect(after?.deferredUntil).toBeNull();
    expect(after?.deferredReason).toBeNull();
    // Тот же агент, без переназначения и без предложения принять/отклонить —
    // отсрочка не была его паузой (в отличие от возврата из INACTIVE).
    expect(after?.assignedAgentId).toBe(agentId);
    expect(after?.reactivationOfferedToAgentId).toBeNull();

    const note = await prisma.interaction.findFirst({
      where: { clientId: c.id, type: "SYSTEM", notes: { contains: "Отложенных" } },
    });
    expect(note).not.toBeNull();
  });
});

describe("POST /clients/:id/deferred/return — поднять раньше срока вручную", () => {
  it("свой агент может поднять клиента из «Отложенных»", async () => {
    const c = await makeClient({ fullName: `Поднят вручную ${runId}` });
    await makeShowing(c.id);
    await refuse(c.id, { reason: "WRONG_OBJECT", initiator: "AGENT", comment: "не то" });

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/deferred/return`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.workStatus).toBe("ACTIVE");
    expect(after?.deferredUntil).toBeNull();
  });

  it("чужой агент поднять не может — 403", async () => {
    const c = await makeClient({ fullName: `Не поднимет чужой ${runId}` });
    await makeShowing(c.id);
    await refuse(c.id, { reason: "WRONG_OBJECT", initiator: "AGENT", comment: "не то совсем" });

    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/deferred/return`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(403);
  });

  it("клиент не в «Отложенных» — 409", async () => {
    const c = await makeClient({ fullName: `Не отложен вовсе ${runId}` });
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/deferred/return`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });
});

describe("runDeferredClientsReturnTick — крон автовозврата по таймеру", () => {
  it("возвращает клиента, у которого deferredUntil уже наступил, и не трогает тех, у кого ещё впереди", async () => {
    const due = await makeClient({ fullName: `Срок наступил ${runId}` });
    const notYet = await makeClient({ fullName: `Срок ещё впереди ${runId}` });
    const now = new Date();
    await deferClient({
      clientId: due.id,
      agentId,
      reason: "WRONG_OBJECT",
      initiator: "AGENT",
      now: new Date(now.getTime() - 40 * DAY), // 40 дней назад + 1 месяц отсрочки = уже в прошлом
    });
    await deferClient({ clientId: notYet.id, agentId, reason: "EXPENSIVE", initiator: "AGENT", now });

    const { returned } = await runDeferredClientsReturnTick(now);
    expect(returned).toBeGreaterThanOrEqual(1);

    const dueAfter = await prisma.client.findUnique({ where: { id: due.id } });
    expect(dueAfter?.workStatus).toBe("ACTIVE");
    expect(dueAfter?.deferredUntil).toBeNull();

    const notYetAfter = await prisma.client.findUnique({ where: { id: notYet.id } });
    expect(notYetAfter?.workStatus).toBe("DEFERRED");
  });
});

describe("returnDeferredClientManually — не трогает клиента, который уже не отложен", () => {
  it("возвращает { ok: false } для клиента без workStatus=DEFERRED", async () => {
    const c = await makeClient({ fullName: `Обычный активный ${runId}` });
    const result = await returnDeferredClientManually(c.id);
    expect(result.ok).toBe(false);
  });
});
