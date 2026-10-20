import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * ЗАЩИТА РОБОТА-КОНСУЛЬТАНТА: МАРШРУТЫ (02.10.2026).
 *
 *  - разговоры робота (список с началом расшифровки и звук) — за теми же правами
 *    на звонки, что и все остальные разговоры CRM, а не за одним settings.manage;
 *  - «Звонок роботом» клиенту и проверочный звонок оставляют след в журнале
 *    действий и упираются в суточный предел на сотрудника;
 *  - прослушка голоса — не чаще 10 раз в минуту на сотрудника.
 *
 * Станция и Live API подменены: здесь проверяется, ДОХОДИТ ли дело до звонка и
 * что ложится в журнал, а не сам звонок.
 */

const robot = vi.hoisted(() => ({ testCalls: [] as string[], clientCalls: [] as string[] }));
vi.mock("../src/lib/telephony/liveVoiceBridge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/liveVoiceBridge.js")>()),
  originateLiveVoiceTestCall: async (phone: string) => (robot.testCalls.push(phone), { ok: true, channelId: "lv-test" }),
  originateLiveVoiceCallToClient: async (client: { id: string }) => (robot.clientCalls.push(client.id), { ok: true, channelId: "lv-client" }),
}));
vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/liveVoiceClient.js")>()),
  previewLiveVoiceGreeting: async () => ({ transcript: "Салом", audioBase64: "AAAA", sampleRateHz: 24000 }),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { grantElevation } = await import("../src/lib/stepUp.js");
const { MANUAL_ROBOT_CALLS_PER_DAY } = await import("../src/lib/telephony/manualRobotCalls.js");
const { maskClientPhone } = await import("../src/lib/clientPhone.js");
const { waitFor } = await import("./helpers/waitFor.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const tail = () => String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
const runId = Date.now().toString(36);
const agentIds: string[] = [];
let clientId = "";
const tokens: Record<"settingsOnly" | "transcripts" | "hear" | "director" | "cappedDirector" | "preview", string> = {
  settingsOnly: "",
  transcripts: "",
  hear: "",
  director: "",
  cappedDirector: "",
  preview: "",
};
const ids: Partial<Record<keyof typeof tokens, string>> = {};

async function makeAgent(key: keyof typeof tokens, role: "AGENT" | "DIRECTOR", granted: string[] = []) {
  const a = await prisma.agent.create({
    data: {
      fullName: `Робот-права ${key} ${runId}`,
      phone: `+992${tail()}`,
      role,
      passwordHash: "x",
      permissions: { granted, revoked: [] },
    },
    select: { id: true },
  });
  agentIds.push(a.id);
  ids[key] = a.id;
  tokens[key] = signAccessToken({ sub: a.id, role });
}

beforeAll(async () => {
  await makeAgent("settingsOnly", "AGENT", ["settings.manage"]);
  await makeAgent("transcripts", "AGENT", ["settings.manage", "calls.transcripts"]);
  await makeAgent("hear", "AGENT", ["settings.manage", "calls.transcripts", "calls.hearRecording"]);
  await makeAgent("director", "DIRECTOR");
  await makeAgent("cappedDirector", "DIRECTOR");
  await makeAgent("preview", "AGENT", ["settings.manage"]);
  const c = await prisma.client.create({
    data: { fullName: `Клиент робота ${runId}`, phone: `+992${tail()}`, source: "PHONE_CALL", assignedAgentId: ids.director },
    select: { id: true },
  });
  clientId = c.id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: agentIds } } });
  await deleteAgentsWithTraces(agentIds);
});

beforeEach(() => {
  robot.testCalls.length = 0;
  robot.clientCalls.length = 0;
});

const auth = (key: keyof typeof tokens) => ({ Authorization: `Bearer ${tokens[key]}` });

describe("разговоры робота — за правами на звонки", () => {
  it("одно право настраивать бота не открывает расшифровки — 403", async () => {
    const res = await request(app).get("/api/v1/settings/live-voice/sessions").set(auth("settingsOnly"));
    expect(res.status).toBe(403);
  });

  it("с calls.transcripts — список открывается", async () => {
    const res = await request(app).get("/api/v1/settings/live-voice/sessions").set(auth("transcripts"));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it("звук без calls.hearRecording — 403, с ним — проверка доходит до самой записи", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const denied = await request(app).get(`/api/v1/settings/live-voice/sessions/${missing}/recording`).set(auth("transcripts"));
    expect(denied.status).toBe(403);
    const allowed = await request(app).get(`/api/v1/settings/live-voice/sessions/${missing}/recording`).set(auth("hear"));
    expect(allowed.status).toBe(404);
  });
});

describe("звонок роботом — журнал и суточный предел", () => {
  it("«Звонок роботом» клиенту ложится в журнал: кто и кому", async () => {
    const res = await request(app).post(`/api/v1/clients/${clientId}/live-voice-call`).set(auth("director")).send({});
    expect(res.status).toBe(200);
    expect(robot.clientCalls).toEqual([clientId]);
    const row = await waitFor(() =>
      prisma.auditLog.findFirst({ where: { action: "LIVE_VOICE_CALL_CLIENT", agentId: ids.director, entityId: clientId } })
    );
    expect(row.entityType).toBe("Client");
    expect(row.meta).toMatchObject({ ok: true, channelId: "lv-client" });
  });

  it("проверочный звонок ложится в журнал с номером под маской", async () => {
    grantElevation(ids.director!);
    const phone = `+992${tail()}`;
    const res = await request(app).post("/api/v1/settings/live-voice-test-call").set(auth("director")).send({ phone });
    expect(res.status).toBe(200);
    expect(robot.testCalls).toEqual([phone]);
    const row = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "LIVE_VOICE_TEST_CALL", agentId: ids.director } }));
    // Номер в журнале под маской (аудит роботов №16, 02.10.2026).
    expect(row.meta).toMatchObject({ phone: maskClientPhone(phone), ok: true });
  });

  it(`после ${MANUAL_ROBOT_CALLS_PER_DAY} звонков за сутки — 429, до станции дело не доходит`, async () => {
    await prisma.auditLog.createMany({
      data: Array.from({ length: MANUAL_ROBOT_CALLS_PER_DAY }, () => ({
        action: "LIVE_VOICE_TEST_CALL",
        entityType: "Settings",
        entityId: "singleton",
        agentId: ids.cappedDirector!,
        agentName: "тест",
      })),
    });
    grantElevation(ids.cappedDirector!);
    const test = await request(app)
      .post("/api/v1/settings/live-voice-test-call")
      .set(auth("cappedDirector"))
      .send({ phone: `+992${tail()}` });
    expect(test.status).toBe(429);
    expect(test.body.error).toMatch(/предел/);

    await prisma.client.update({ where: { id: clientId }, data: { assignedAgentId: ids.cappedDirector } });
    const toClient = await request(app).post(`/api/v1/clients/${clientId}/live-voice-call`).set(auth("cappedDirector")).send({});
    expect(toClient.status).toBe(429);
    expect(robot.testCalls).toEqual([]);
    expect(robot.clientCalls).toEqual([]);
  });
});

describe("прослушка голоса — не чаще 10 раз в минуту", () => {
  it("одиннадцатая подряд — 429", async () => {
    for (let i = 0; i < 10; i++) {
      const ok = await request(app).post("/api/v1/settings/live-voice/preview-voice").set(auth("preview")).send({ voice: "Kore" });
      expect(ok.status).toBe(200);
    }
    const res = await request(app).post("/api/v1/settings/live-voice/preview-voice").set(auth("preview")).send({ voice: "Kore" });
    expect(res.status).toBe(429);
  });
});
