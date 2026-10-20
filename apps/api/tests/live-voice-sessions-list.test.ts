import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";

/**
 * Список разговоров робота в Настройках (03.10.2026): превью расшифровки — со
 * склеенными осколками реплик («Здрав» / «ствуйте» — одна реплика), а у строки
 * есть направление звонка, по которому сайт подписывает, кто был на линии.
 */
const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { signAccessToken } = await import("../src/auth/jwt.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");

const runId = Date.now().toString(36);
const channelId = `lv-list-${runId}`;
let agentId = "";
let token = "";

beforeAll(async () => {
  const a = await prisma.agent.create({
    data: {
      fullName: `Список робота ${runId}`,
      phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`,
      role: "AGENT",
      passwordHash: "x",
      permissions: { granted: ["settings.manage", "calls.transcripts"], revoked: [] },
    },
    select: { id: true },
  });
  agentId = a.id;
  token = signAccessToken({ sub: a.id, role: "AGENT" });
  await prisma.liveVoiceSession.create({
    data: {
      channelId,
      direction: "inbound",
      transcript: "Бот: Здрав\nБот: ствуйте\nКлиент: Алло\nКонсультант: Слушаю",
    },
  });
});

afterAll(async () => {
  await prisma.liveVoiceSession.deleteMany({ where: { channelId } });
  await deleteAgentsWithTraces([agentId]);
});

describe("GET /settings/live-voice/sessions", () => {
  it("отдаёт направление и превью без осколков реплики", async () => {
    const res = await request(app).get("/api/v1/settings/live-voice/sessions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const row = res.body.sessions.find((s: { channelId: string }) => s.channelId === channelId);
    expect(row).toBeTruthy();
    expect(row.direction).toBe("inbound");
    expect(row.transcriptPreview).toBe("Бот: Здравствуйте\nКлиент: Алло\nКонсультант: Слушаю");
  });
});
