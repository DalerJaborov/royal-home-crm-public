import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor, waitForCount } from "./helpers/waitFor.js";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * «Дверь передачи, которой сейчас нет» (мозговой штурм владельца 20-21.08.2026,
 * «рубеж 2»). Между «принял лид» и «сходил на показ» агент раньше не мог ни
 * передать клиента, ни честно бездействовать — «Передача» требовала обязательно
 * проведённого показа (см. client-transfer-deactivate.test.ts, тест «без показа —
 * 409»). Теперь достаточно хотя бы одной попытки реального контакта (см.
 * lib/clientTransfer.ts::canTransferClient), и есть мягкая квота передач в
 * месяц (Settings.transferQuotaPerMonth).
 *
 * СУЖЕНО ДО NO_TRUST (задача F, план 03-04.09.2026): причина передачи больше
 * НЕ маршрутизирует получателя — routeTransferTarget/CANT_MATCH_PROPERTY были
 * актуальны, пока reason мог быть любым из восьми; сейчас clientTransferSchema
 * принимает только "NO_TRUST" (z.literal), и routeTransferTarget всегда падает
 * на обычную очередь по KPI. Ниже — гейт контакта (актуален) и регрессия «прочие
 * причины отклоняются границей» вместо прежних живых тестов маршрутизации.
 */

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let agentId: string; // передающий
let ownerAgentId: string; // хозяин подходящего объекта
let token: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function makeClient(extra: Partial<Parameters<typeof prisma.client.create>[0]["data"]> = {}) {
  const c = await prisma.client.create({
    data: {
      fullName: `Клиент рубежа 2 ${runId}-${clientIds.length}`,
      phone: `+992960${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      ...extra,
    },
  });
  clientIds.push(c.id);
  return c;
}

/** Один состоявшийся звонок — тот же порог, что решает «след работы» во всей
 *  CRM (countContactTrace): recordingDurationSec заведомо больше любого разумного
 *  Settings.leadCallMinSeconds, чтобы тест не зависел от текущей настройки. */
async function makeTalkedCall(clientId: string) {
  await prisma.interaction.create({
    data: { clientId, agentId, type: "CALL", recordingDurationSec: 999, notes: `Звонок ${runId}` },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-рубеж2-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент рубежа 2", phone: `+992961${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  ownerAgentId = (
    await prisma.agent.create({
      data: { fullName: "Хозяин объекта рубежа 2", phone: `+992962${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  token = await login(`+992961${runId}`);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, ownerAgentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("POST /clients/:id/transfer — гейт «хотя бы один реальный контакт»", () => {
  it("без единого контакта — 409, передавать ещё нечего", async () => {
    const c = await makeClient();
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "NO_TRUST" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/показа|попытки/);

    // Клиент остаётся у того же агента — передача не состоялась.
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(agentId);
  });

  it("после звонка с ответом — 200, показ не требуется", async () => {
    const c = await makeClient();
    await makeTalkedCall(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "NO_TRUST", comment: "две недели не выходили на связь" });
    expect(res.status).toBe(200);

    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).not.toBe(agentId);
    expect(after?.refusalCount).toBe(1);
  });

  /**
   * П-5/П-10 (17.09.2026, `docs/audit/lead-ownership-17-09.md` §2, §4): каждая
   * запись хронологии подписана актором. lib/clientTransfer.ts::transferClientToAgent
   * до этой правки звало changeClientAgent с actorId:null всегда — инициатор
   * (агент, нажавший «Передать») терялся из AuditLog, хотя это не автоматика.
   */
  it("actorId в AuditLog — агент, который нажал «Передать», не null", async () => {
    const c = await makeClient();
    await makeTalkedCall(c.id);
    const res = await request(app)
      .post(`/api/v1/clients/${c.id}/transfer`)
      .set("Authorization", `Bearer ${token}`)
      .send({ reason: "NO_TRUST", comment: "проверка актора в аудите" });
    expect(res.status).toBe(200);

    const auditRow = await waitFor(() =>
      prisma.auditLog.findFirst({
        where: { entityType: "Client", entityId: c.id, action: "CLIENT_AGENT_CHANGE" },
        orderBy: { createdAt: "desc" },
      })
    );
    expect(auditRow?.agentId).toBe(agentId);
  });
});

/**
 * «ПРИЧИНА = МАРШРУТ» — БЫЛА живой веткой API до задачи F (03-04.09.2026):
 * CANT_MATCH_PROPERTY уходило агенту с подходящим объектом, OTHER с признаком
 * конфликта эскалировалось руководителю. routeTransferTarget (lib/clientTransfer.ts)
 * эту логику по-прежнему СОДЕРЖИТ (не удалялась намеренно — дешевле сохранить,
 * чем отрезать и потом восстанавливать), но НЕДОСТИЖИМА через реальный API: с
 * задачи F clientTransferSchema принимает только reason="NO_TRUST"
 * (z.literal), и любой другой reason отклоняется ГРАНИЦЕЙ раньше, чем код
 * дойдёт до routeTransferTarget. Три прежних HTTP-теста этого блока проверяли
 * маршрутизацию через живой эндпоинт — теперь эндпоинт саму причину не
 * пропускает, и тесты были бы протестом дороги, по которой больше нельзя
 * проехать. Заменены одним тестом-регрессией: прочие причины ГРАНИЦЕЙ отклонены.
 */
describe("POST /clients/:id/transfer — причина = маршрут (недостижимо с задачи F)", () => {
  it("CANT_MATCH_PROPERTY/OTHER и прочие причины, кроме NO_TRUST, отклоняются на границе (400), до routeTransferTarget код не доходит", async () => {
    const c = await makeClient();
    await makeTalkedCall(c.id);
    for (const reason of ["CANT_MATCH_PROPERTY", "OTHER", "NEEDS_DIFFERENT_APPROACH"]) {
      const res = await request(app)
        .post(`/api/v1/clients/${c.id}/transfer`)
        .set("Authorization", `Bearer ${token}`)
        .send({ reason, comment: "любой текст" });
      expect(res.status).toBe(400);
    }
    // Клиент никуда не ушёл — ни одна из отклонённых причин передачи не состоялась.
    const after = await prisma.client.findUnique({ where: { id: c.id } });
    expect(after?.assignedAgentId).toBe(agentId);
  });
});

describe("POST /clients/:id/transfer — квота передач в месяц", () => {
  it("после transferQuotaPerMonth передач сигнал руководителю, а не блокировка", async () => {
    const saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { transferQuotaPerMonth: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { transferQuotaPerMonth: 1 } });
    try {
      const c1 = await makeClient();
      await makeTalkedCall(c1.id);
      const c2 = await makeClient();
      await makeTalkedCall(c2.id);

      const res1 = await request(app)
        .post(`/api/v1/clients/${c1.id}/transfer`)
        .set("Authorization", `Bearer ${token}`)
        .send({ reason: "NO_TRUST" });
      expect(res1.status).toBe(200);

      // Вторая передача ТЕМ ЖЕ агентом за 30 дней — сверх квоты (=1), но это
      // сигнал руководителю, а не отказ: передача всё равно проходит.
      const res2 = await request(app)
        .post(`/api/v1/clients/${c2.id}/transfer`)
        .set("Authorization", `Bearer ${token}`)
        .send({ reason: "NO_TRUST" });
      expect(res2.status).toBe(200);

      const since = new Date(Date.now() - 30 * 86_400_000);
      const count = await waitForCount(
        () =>
          prisma.auditLog.count({
            where: { action: "CLIENT_TRANSFER", agentId, createdAt: { gte: since } },
          }),
        2
      );
      expect(count).toBeGreaterThanOrEqual(2);
    } finally {
      await prisma.settings.update({
        where: { id: "singleton" },
        data: { transferQuotaPerMonth: saved?.transferQuotaPerMonth ?? 3 },
      });
    }
  });
});
