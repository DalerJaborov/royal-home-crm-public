import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * POST /interactions/:id/retranscribe (24.09.2026) — кнопка «пере-расшифровать»
 * в интерфейсе. Сам конвейер (retranscribeInteraction) проверяется в
 * call-recordings.test.ts вместе с остальным путём «станция → текст»; здесь —
 * только контур маршрута: права (те же, что у GET /:id/transcript), 404 без
 * записи, 202 + фоновая постановка, 429 при повторе в пределах суток.
 *
 * retranscribeInteraction подменена: сама переrасшифровка платно ходит к Gemini
 * и станции — маршруту это знать не нужно, ему важно лишь ЧТО он её вызвал и
 * КОГДА отказал раньше неё (права/лимит).
 */
const retranscribeInteraction = vi.fn(async () => ({ ok: true }));
vi.mock("../src/lib/telephony/callRecordings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/telephony/callRecordings.js")>();
  return { ...actual, retranscribeInteraction: (...args: [string]) => retranscribeInteraction(...args) };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { invalidateAgentAccess } = await import("../src/auth/middleware.js");

const runId = Date.now();
let agentId = "";
let otherAgentId = "";
let adminId = "";
let clientId = "";
let agentToken = "";
let otherAgentToken = "";
let adminToken = "";

async function makeInteraction(ownerId: string, opts: { recordingUrl?: string | null; type?: string } = {}) {
  const { recordingUrl = "2026/09/24/out-1-1004-20260924-120000-1.mp3", type = "CALL" } = opts;
  return prisma.interaction.create({
    data: {
      clientId,
      agentId: ownerId,
      type: type as "CALL",
      notes: "Звонок через CRM, разговор 1:00",
      recordingUrl,
    },
  });
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент повтора ${runId}`, phone: `+99297${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const otherAgent = await prisma.agent.create({
    data: { fullName: `Коллега повтора ${runId}`, phone: `+99296${String(runId).slice(-7)}`, role: "AGENT", passwordHash: "x" },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Админ повтора ${runId}`, phone: `+99298${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  agentId = agent.id;
  otherAgentId = otherAgent.id;
  adminId = admin.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  otherAgentToken = signAccessToken({ sub: otherAgent.id, role: "AGENT" });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент повтора ${runId}`,
      phone: `+99299${String(runId).slice(-7)}`,
      source: "PHONE_CALL",
      assignedAgentId: agent.id,
      acceptedAt: new Date(),
    },
  });
  clientId = client.id;
});

afterEach(() => {
  retranscribeInteraction.mockClear();
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId, adminId] } } });
  await prisma.$disconnect();
});

describe("POST /interactions/:id/retranscribe", () => {
  it("несуществующий разговор — 404, конвейер не запускается", async () => {
    const res = await request(app)
      .post(`/api/v1/interactions/00000000-0000-4000-8000-000000000000/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
    expect(retranscribeInteraction).not.toHaveBeenCalled();
  });

  it("неверный формат id — 400, а не 500", async () => {
    const res = await request(app)
      .post(`/api/v1/interactions/not-a-uuid/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(400);
    expect(retranscribeInteraction).not.toHaveBeenCalled();
  });

  it("у разговора нет записи — 404, конвейер не запускается", async () => {
    const interaction = await makeInteraction(agentId, { recordingUrl: null });
    const res = await request(app)
      .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
    expect(retranscribeInteraction).not.toHaveBeenCalled();
  });

  it("это не звонок (type ≠ CALL) — тоже 404", async () => {
    const interaction = await makeInteraction(agentId, { type: "MESSAGE" });
    const res = await request(app)
      .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(404);
    expect(retranscribeInteraction).not.toHaveBeenCalled();
  });

  it("чужой разговор коллеге — 403 (те же права, что у GET /:id/transcript)", async () => {
    const interaction = await makeInteraction(agentId);
    const res = await request(app)
      .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
      .set("Authorization", `Bearer ${otherAgentToken}`);
    expect(res.status).toBe(403);
    expect(retranscribeInteraction).not.toHaveBeenCalled();
  });

  it("свой разговор — 202 {queued:true}, конвейер запущен фоном", async () => {
    const interaction = await makeInteraction(agentId);
    const res = await request(app)
      .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
    expect(retranscribeInteraction).toHaveBeenCalledTimes(1);
    expect(retranscribeInteraction).toHaveBeenCalledWith(interaction.id);
  });

  it("администратор запускает пере-расшифровку и чужого разговора", async () => {
    const interaction = await makeInteraction(agentId);
    const res = await request(app)
      .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(202);
    expect(retranscribeInteraction).toHaveBeenCalledTimes(1);
  });

  it("повтор в пределах суток — 429, второй запуск конвейера не срабатывает", async () => {
    const interaction = await makeInteraction(agentId);
    const first = await request(app)
      .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(first.status).toBe(202);

    const second = await request(app)
      .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(second.status).toBe(429);
    expect(second.body.error).toBeTruthy();
    // Конвейер запущен только один раз — вторым запросом ничего не поставилось.
    expect(retranscribeInteraction).toHaveBeenCalledTimes(1);
  });

  it("лимит — на РАЗГОВОР, а не глобальный: другой разговор того же агента запускается сразу", async () => {
    const first = await makeInteraction(agentId);
    await request(app)
      .post(`/api/v1/interactions/${first.id}/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);

    const second = await makeInteraction(agentId);
    const res = await request(app)
      .post(`/api/v1/interactions/${second.id}/retranscribe`)
      .set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(202);
    expect(retranscribeInteraction).toHaveBeenCalledTimes(2);
  });

  it("право можно снять — своя же запись становится недоступна и для повтора расшифровки", async () => {
    const interaction = await makeInteraction(agentId);
    await prisma.agent.update({
      where: { id: agentId },
      data: { permissions: { granted: [], revoked: ["calls.ownTranscripts"] } },
    });
    invalidateAgentAccess(agentId);
    try {
      const res = await request(app)
        .post(`/api/v1/interactions/${interaction.id}/retranscribe`)
        .set("Authorization", `Bearer ${agentToken}`);
      expect(res.status).toBe(403);
      expect(retranscribeInteraction).not.toHaveBeenCalled();
    } finally {
      await prisma.agent.update({ where: { id: agentId }, data: { permissions: { granted: [], revoked: [] } } });
      invalidateAgentAccess(agentId);
    }
  });
});
