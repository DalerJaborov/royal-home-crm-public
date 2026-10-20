import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * РУБИЛЬНИК «ЖИВОГО ГОЛОСА» ВИДЕН РЯДОВОМУ АГЕНТУ (28.09.2026).
 *
 * Карточка клиента показывает строку «Робот позвонит клиенту» только при
 * включённом живом голосе. Агент получает усечённые настройки (toStaffSettings),
 * и без этого поля строка не появлялась бы у него никогда — ровно та ловушка,
 * что уже была с aiAssistantEnabled. Сам текст подсказки робота и прочие
 * настройки живого голоса агенту по-прежнему не уходят.
 */

const runId = String(Date.now()).slice(-7);
let agentToken = "";
let agentId = "";
let before: boolean | null = null;

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: `+99283${runId}` } });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент голос ${runId}`, phone: `+99283${runId}`, role: "AGENT", passwordHash: "x" },
  });
  agentId = agent.id;
  agentToken = signAccessToken({ sub: agent.id, role: "AGENT" });
  const s = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  before = s.liveVoiceEnabled;
});

afterAll(async () => {
  if (before !== null) await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: before } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("GET /settings для агента — liveVoiceEnabled", () => {
  it("агент видит включённый рубильник, но не текст подсказки робота", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: true } });
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.liveVoiceEnabled).toBe(true);
    expect(res.body.liveVoicePrompt).toBeUndefined();
    expect(res.body.liveVoiceTestExtension).toBeUndefined();
  });

  it("выключенный рубильник агент тоже видит — как false", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { liveVoiceEnabled: false } });
    const res = await request(app).get("/api/v1/settings").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.liveVoiceEnabled).toBe(false);
  });
});
