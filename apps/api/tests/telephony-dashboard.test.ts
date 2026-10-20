import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { encryptSecret } from "../src/crypto.js";
import { resetIncomingCalls, seedLiveIncoming } from "../src/lib/telephony/incomingCalls.js";
import { resetCalls } from "../src/lib/telephony/callTracker.js";

/**
 * ДАШБОРД ТЕЛЕФОНИИ (владелец 11.08.2026: «сделать полноценный дашборд звонилки,
 * как у настоящей АТС»).
 *
 * Проверяется то, ради чего он и делался: один экран отвечает на вопрос «работает
 * ли телефония прямо сейчас», и отвечает ЧЕСТНО — при оборванном туннеле до станции
 * он показывает «станция недоступна», а не молчит и не падает, потому что обрыв
 * туннеля здесь штатная ситуация (АТС в офисе, CRM на VPS).
 */

const runId = Date.now();
let agentToken = "";
let adminToken = "";
let adminId = "";
let agentId = "";
const fetchMock = vi.fn();

async function dashboard(token: string) {
  return request(app).get("/api/v1/calls/telephony/dashboard").set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент дашборда ${runId}`,
      phone: `+99274${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash: "x",
      sipExtension: `4${String(runId).slice(-2)}`,
    },
  });
  const admin = await prisma.agent.create({
    data: { fullName: `Админ дашборда ${runId}`, phone: `+99275${String(runId).slice(-7)}`, role: "ADMIN", passwordHash: "x" },
  });
  agentId = agent.id;
  adminId = admin.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN" });

  await prisma.settings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      asteriskAriUrl: "http://ari.dash-test:8088",
      asteriskAriUsername: "royalhome",
      asteriskAriPassword: encryptSecret("secret"),
    },
    update: {
      asteriskAriUrl: "http://ari.dash-test:8088",
      asteriskAriUsername: "royalhome",
      asteriskAriPassword: encryptSecret("secret"),
    },
  });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  resetIncomingCalls();
  resetCalls();
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, adminId] } } });
  await prisma.settings
    .update({ where: { id: "singleton" }, data: { asteriskAriUrl: null, asteriskAriUsername: null, asteriskAriPassword: null } })
    .catch(() => {});
  await prisma.$disconnect();
});

describe("GET /calls/telephony/dashboard", () => {
  // Свои разговоры агент с 15.08.2026 смотрит, а состояние станции и аппараты
  // коллег — нет: это работа телефонии целиком, а не его разговоры.
  it("агенту закрыт — это работа станции, а не его звонки", async () => {
    const res = await dashboard(agentToken);
    expect(res.status).toBe(403);
  });

  it("показывает состояние станции и аппараты сотрудников с именами", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes("/ari/endpoints")
        ? ({
            ok: true,
            status: 200,
            json: async () => [
              { technology: "SIP", resource: `4${String(runId).slice(-2)}`, state: "online" },
              { technology: "SIP", resource: "9999", state: "unknown" },
            ],
          } as Response)
        : ({ ok: false, status: 404 } as Response)
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await dashboard(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.station).toMatchObject({ configured: true, online: true });

    // Аппарат сотрудника подписан ИМЕНЕМ, а не голым номером: список вида
    // «1001 online, 1004 unknown» требует держать нумерацию в голове — ровно эту
    // проблему уже чинили в журнале входящих.
    const mine = res.body.extensions.find((e: { agentId: string }) => e.agentId === agentId);
    expect(mine).toMatchObject({ fullName: `Агент дашборда ${runId}`, online: true, knownToStation: true });
  });

  // №223 (ночная проверка 24.09): «Входящий, принял 1003» — панель показывала
  // добавочный номер, а не имя, хотя журнал входящих уже отдаёт имя.
  it("живой входящий подписан именем принявшего, а не добавочным номером", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);
    seedLiveIncoming({
      channelId: `dash-live-op-${runId}`,
      phone: "+992900000001",
      bridgedAt: new Date(),
      answeredBy: `4${String(runId).slice(-2)}`,
    });
    seedLiveIncoming({ channelId: `dash-live-ai-${runId}`, phone: "+992900000002", consultantAt: new Date() });
    seedLiveIncoming({ channelId: `dash-live-wait-${runId}`, phone: "+992900000003" });

    const res = await dashboard(adminToken);
    expect(res.status).toBe(200);
    const byChannel = new Map(
      (res.body.live.incoming as { channelId: string; answeredByName: string | null }[]).map((c) => [c.channelId, c])
    );
    expect(byChannel.get(`dash-live-op-${runId}`)?.answeredByName).toBe(`Агент дашборда ${runId}`);
    expect(byChannel.get(`dash-live-ai-${runId}`)?.answeredByName).toBe("консультант (ИИ)");
    expect(byChannel.get(`dash-live-wait-${runId}`)?.answeredByName).toBeNull();
  });

  it("станция недоступна — отвечает честно, а не падает: статистика из базы приезжает всё равно", async () => {
    /**
     * Туннель до АТС рвётся штатно (станция в офисе, CRM на VPS), и дашборд обязан
     * это пережить: цифры за день лежат в базе и к станции отношения не имеют.
     * Раньше такой обрыв означал бы 500 на весь экран.
     */
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await dashboard(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.station).toMatchObject({ configured: true, online: false, registered: 0 });
    expect(res.body.today).toHaveProperty("incoming");
    expect(res.body.today).toHaveProperty("missed");
  });

  it("отдаёт действующие настройки телефонии — их же показывает экран", async () => {
    fetchMock.mockRejectedValue(new Error("нет связи"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await dashboard(adminToken);
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      pushEnabled: expect.any(Boolean),
      panelEnabled: expect.any(Boolean),
      hoursEnabled: expect.any(Boolean),
    });
    expect(res.body.settings.hoursStart).toMatch(/^\d{2}:\d{2}$/);
  });
});
