import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { recordScoreEvent } from "../src/lib/scoreJournal.js";

/**
 * GET /royal-score-events/by-client и PATCH /:id/override.
 *
 * Разведка по мёртвому коду (08.09.2026) нашла: право `score.clientLossOverride`
 * и сам PATCH существовали больше года без единой строки теста на маршрут и без
 * единой кнопки в интерфейсе — только модульные тесты recordScoreEvent напрямую.
 * Этот файл проверяет ровно то, чего не было: сам HTTP-путь, права доступа и
 * починенную повторную попытку (см. комментарий в routes/royalScoreEvents.ts —
 * второй PATCH раньше молча превращался в no-op с ответом «ok: true»).
 */

const runId = Date.now();
let agentId: string;
let directorId: string;
let clientId: string;
let directorToken: string;
let agentToken: string;

async function waitForRow(where: Record<string, unknown>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const row = await prisma.royalScoreEvent.findFirst({ where });
    if (row) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Строка журнала не появилась за отведённое время");
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: "Агент override", phone: `+99295${runId.toString().slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const director = await prisma.agent.create({
    data: { fullName: "Директор override", phone: `+99296${runId.toString().slice(-7)}`, role: "DIRECTOR", passwordHash: "x" },
  });
  const client = await prisma.client.create({
    data: {
      fullName: "Клиент override",
      phone: `+99297${runId.toString().slice(-7)}`,
      kind: "BUYER",
      status: "LOST",
      source: "PHONE_CALL",
    },
  });
  agentId = agent.id;
  directorId = director.id;
  clientId = client.id;
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
});

afterAll(async () => {
  await prisma.royalScoreEvent.deleteMany({ where: { agentId } });
  await prisma.client.delete({ where: { id: clientId } }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, directorId] } } });
});

describe("GET /royal-score-events/by-client/:clientId", () => {
  it("агенту (нет права score.clientLossOverride) — 403", async () => {
    const res = await request(app)
      .get(`/api/v1/royal-score-events/by-client/${clientId}`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });

  it("события ещё нет — event: null, а не 404", async () => {
    const res = await request(app)
      .get(`/api/v1/royal-score-events/by-client/${clientId}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.event).toBeNull();
  });

  it("событие есть — отдаёт id и текущий вид", async () => {
    recordScoreEvent({
      agentId,
      kind: "client_lost_agent_fault",
      delta: -5,
      reason: "тест",
      sourceId: `client-lost-${clientId}`,
    });
    await waitForRow({ agentId, sourceId: `client-lost-${clientId}` });

    const res = await request(app)
      .get(`/api/v1/royal-score-events/by-client/${clientId}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.event).toMatchObject({ currentKind: "client_lost_agent_fault", overridden: false });
    expect(typeof res.body.event.id).toBe("string");
  });
});

describe("PATCH /royal-score-events/:id/override", () => {
  it("переопределяет и сразу видно в GET (overridden: true, currentKind поменялся)", async () => {
    const before = await request(app)
      .get(`/api/v1/royal-score-events/by-client/${clientId}`)
      .set("Authorization", `Bearer ${directorToken}`);
    const eventId = before.body.event.id;

    const patchRes = await request(app)
      .patch(`/api/v1/royal-score-events/${eventId}/override`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ override: "client_lost_no_fault", comment: "клиент передумал, при чём тут агент" });
    expect(patchRes.status).toBe(200);

    const after = await request(app)
      .get(`/api/v1/royal-score-events/by-client/${clientId}`)
      .set("Authorization", `Bearer ${directorToken}`);
    expect(after.body.event).toMatchObject({ id: eventId, currentKind: "client_lost_no_fault", overridden: true });
  });

  it("вторая попытка на то же событие — 409, а НЕ тихий ok:true (починенный баг)", async () => {
    const { event } = (
      await request(app)
        .get(`/api/v1/royal-score-events/by-client/${clientId}`)
        .set("Authorization", `Bearer ${directorToken}`)
    ).body;

    const res = await request(app)
      .patch(`/api/v1/royal-score-events/${event.id}/override`)
      .set("Authorization", `Bearer ${directorToken}`)
      .send({ override: "client_lost_agent_fault" });

    expect(res.status).toBe(409);
  });
});

describe("PATCH /royal-score-events/:id/override — сбой второй записи (№161)", () => {
  it("вторая запись упала — 500 со структурированной ошибкой, ни одной строки override-* не осталось", async () => {
    const ev = await prisma.royalScoreEvent.create({
      data: {
        agentId,
        kind: "client_lost_agent_fault",
        delta: -5,
        reason: "тест атомарности",
        sourceId: `atomic-${runId}`,
      },
    });
    const original = prisma.royalScoreEvent.create.bind(prisma.royalScoreEvent);
    let calls = 0;
    const spy = vi.spyOn(prisma.royalScoreEvent, "create").mockImplementation(((args: never) => {
      calls += 1;
      // Первая запись (откат исходной) проходит как обычно, вторая (начисление верной) падает.
      if (calls === 2) return Promise.reject(new Error("сбой базы на второй записи"));
      return original(args);
    }) as never);
    let res;
    try {
      res = await request(app)
        .patch(`/api/v1/royal-score-events/${ev.id}/override`)
        .set("Authorization", `Bearer ${directorToken}`)
        .send({ override: "client_lost_no_fault" });
    } finally {
      spy.mockRestore();
    }
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SCORE_OVERRIDE_FAILED");
    expect(typeof res.body.error).toBe("string");
    const left = await prisma.royalScoreEvent.count({
      where: { sourceId: { in: [`override-revert-${ev.id}`, `override-apply-${ev.id}`] } },
    });
    expect(left).toBe(0);
  });
});
