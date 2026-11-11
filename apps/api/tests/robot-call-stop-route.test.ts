import { randomInt } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

/**
 * «НЕ ЗВОНИТЬ РОБОТОМ» В КАРТОЧКЕ (П3, 11.11.2026): GET/PUT /clients/:id/robot-call-stop
 * и отказ кнопки «Звонок роботом» по этой отметке — причиной словами и без набора.
 */

const originateToStasisApp = vi.fn(async () => ({ ok: true, channelId: `lv-stop-${Date.now()}` }));
vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  originateToStasisApp,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");

const tag = `${Date.now()}${randomInt(0, 1000)}`;
const local = `93${String(randomInt(0, 10_000_000)).padStart(7, "0")}`;
let ownToken = "";
let otherToken = "";
let directorToken = "";
const agentIds: string[] = [];
let clientId = "";
let liveVoiceBefore = false;
const portBefore = process.env.LIVE_VOICE_RTP_PORT;
const hostBefore = process.env.LIVE_VOICE_RTP_HOST;

async function agent(role: "AGENT" | "DIRECTOR", n: number) {
  const a = await prisma.agent.create({
    data: { fullName: `Стоп робота ${role} ${n}`, phone: `+99291${tag.slice(-6)}${n}`, role, passwordHash: "x" },
  });
  agentIds.push(a.id);
  return a;
}

function put(token: string, body: unknown) {
  return request(app).put(`/api/v1/clients/${clientId}/robot-call-stop`).set("Authorization", `Bearer ${token}`).send(body as object);
}

beforeAll(async () => {
  process.env.LIVE_VOICE_RTP_PORT = "40820";
  process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
  const own = await agent("AGENT", 1);
  const other = await agent("AGENT", 2);
  const director = await agent("DIRECTOR", 3);
  ownToken = signAccessToken({ sub: own.id, role: "AGENT" });
  otherToken = signAccessToken({ sub: other.id, role: "AGENT" });
  directorToken = signAccessToken({ sub: director.id, role: "DIRECTOR" });
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент стопа ${tag}`, phone: `+992${local}`, source: "PHONE_CALL", assignedAgentId: own.id, acceptedAt: new Date() },
    })
  ).id;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { liveVoiceEnabled: true } });
  liveVoiceBefore = s?.liveVoiceEnabled ?? false;
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true } });
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  if (portBefore === undefined) delete process.env.LIVE_VOICE_RTP_PORT;
  else process.env.LIVE_VOICE_RTP_PORT = portBefore;
  if (hostBefore === undefined) delete process.env.LIVE_VOICE_RTP_HOST;
  else process.env.LIVE_VOICE_RTP_HOST = hostBefore;
  await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: liveVoiceBefore } });
  await prisma.robotCallStop.deleteMany({ where: { OR: [{ phone: local }, { clientId }] } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
});

describe("PUT/GET /clients/:id/robot-call-stop", () => {
  it("чужой агент не видит и не ставит отметку", async () => {
    expect((await request(app).get(`/api/v1/clients/${clientId}/robot-call-stop`).set("Authorization", `Bearer ${otherToken}`)).status).toBe(403);
    expect((await put(otherToken, { stopped: true })).status).toBe(403);
    expect(await prisma.robotCallStop.count({ where: { phone: local } })).toBe(0);
  });

  it("неверное тело — 400 (Zod, лишние поля не принимаются)", async () => {
    expect((await put(ownToken, { stopped: "yes" })).status).toBe(400);
    expect((await put(ownToken, { stopped: true, source: "VOICE" })).status).toBe(400);
    expect((await put(ownToken, {})).status).toBe(400);
  });

  it("свой агент ставит отметку; повторная постановка не плодит записей; снимает свою", async () => {
    const first = await put(ownToken, { stopped: true });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ stopped: true, source: "STAFF", canClear: true });
    const again = await put(ownToken, { stopped: true });
    expect(again.status).toBe(200);
    expect(await prisma.robotCallStop.count({ where: { phone: local, clearedAt: null } })).toBe(1);

    const got = await request(app).get(`/api/v1/clients/${clientId}/robot-call-stop`).set("Authorization", `Bearer ${ownToken}`);
    expect(got.body).toMatchObject({ stopped: true, optedOutInChat: false });

    const off = await put(ownToken, { stopped: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ stopped: false, source: null });
    expect(await prisma.robotCallStop.count({ where: { phone: local, clearedAt: null } })).toBe(0);
  });

  it("просьбу самого клиента снимает только руководитель", async () => {
    await prisma.robotCallStop.create({ data: { phone: local, clientId, source: "VOICE" } });
    const asAgent = await put(ownToken, { stopped: false });
    expect(asAgent.status).toBe(403);
    expect(await prisma.robotCallStop.count({ where: { phone: local, clearedAt: null } })).toBe(1);
    const asDirector = await put(directorToken, { stopped: false });
    expect(asDirector.status).toBe(200);
    expect(asDirector.body.stopped).toBe(false);
  });

  it("своя отметка не открывает снятие чужой: отметка сотрудника + просьба клиента по карточке", async () => {
    expect((await put(ownToken, { stopped: true })).status).toBe(200);
    await prisma.robotCallStop.create({ data: { phone: `93${String(randomInt(0, 10_000_000)).padStart(7, "0")}`, clientId, source: "VOICE" } });
    const state = await request(app).get(`/api/v1/clients/${clientId}/robot-call-stop`).set("Authorization", `Bearer ${ownToken}`);
    expect(state.body).toMatchObject({ stopped: true, source: "VOICE", canClear: false });
    expect((await put(ownToken, { stopped: false })).status).toBe(403);
    expect((await put(directorToken, { stopped: false })).status).toBe(200);
    expect(await prisma.robotCallStop.count({ where: { clientId, clearedAt: null } })).toBe(0);
  });

  it("кнопка «Звонок роботом» по номеру с отметкой — 409 с причиной и без набора", async () => {
    await put(ownToken, { stopped: true });
    // Полдень по Душанбе: отказ должен быть именно из-за отметки, а не из-за часов.
    const noon = new Date();
    noon.setUTCHours(7, 0, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(noon);
    originateToStasisApp.mockClear();
    const res = await request(app).post(`/api/v1/clients/${clientId}/live-voice-call`).set("Authorization", `Bearer ${directorToken}`).send({});
    vi.useRealTimers();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Не звонить роботом/);
    expect(originateToStasisApp).not.toHaveBeenCalled();
  });
});
