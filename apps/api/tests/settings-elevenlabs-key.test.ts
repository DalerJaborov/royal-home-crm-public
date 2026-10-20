import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { loadLiveVoiceProviderConfig } from "../src/ai/liveVoiceProvider.js";

/**
 * Живой голос через ElevenLabs (02.10.2026): переключатель поставщика и ключ в
 * Настройках. Ключ хранится зашифрованным и наружу уходит только маской — как
 * ключи Gemini; звонок читает его расшифрованным (loadLiveVoiceProviderConfig).
 */

const runId = Date.now();
const password = "testpass123";
const KEY = "sk_TestElevenLabsKeyValue0042";

let adminId: string;
let adminToken: string;
let saved: Record<string, unknown>;

function patch(body: Record<string, unknown>) {
  return request(app).patch("/api/v1/settings").set("Authorization", `Bearer ${adminToken}`).send(body);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ ElevenLabs", phone: `+992938${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  adminToken = res.body.accessToken;
  grantElevation(adminId);

  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  saved = {
    liveVoiceProvider: current.liveVoiceProvider,
    elevenLabsApiKey: current.elevenLabsApiKey,
    elevenLabsAgentId: current.elevenLabsAgentId,
    elevenLabsVoiceIdRu: current.elevenLabsVoiceIdRu,
    elevenLabsVoiceIdTg: current.elevenLabsVoiceIdTg,
    elevenLabsVoiceGender: current.elevenLabsVoiceGender,
  };
});

afterAll(async () => {
  await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `el-list-${runId}` } } });
  await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  await prisma.agent.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("Настройки: поставщик живого голоса и ключ ElevenLabs", () => {
  it("ключ сохраняется зашифрованным, наружу — только маска; звонок получает его расшифрованным", async () => {
    const res = await patch({
      liveVoiceProvider: "elevenlabs",
      elevenLabsApiKey: KEY,
      elevenLabsAgentId: " agent_test_1 ",
      elevenLabsVoiceIdRu: "voice_ru",
      elevenLabsVoiceIdTg: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.liveVoiceProvider).toBe("elevenlabs");
    expect(res.body.elevenLabsApiKeyConfigured).toBe(true);
    expect(res.body.elevenLabsApiKeyMasked).toBe(`••••${KEY.slice(-4)}`);
    expect(res.body.elevenLabsApiKeySource).toBe("settings");
    expect(res.body.elevenLabsAgentId).toBe("agent_test_1");
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect("elevenLabsApiKey" in res.body).toBe(false);

    const row = await prisma.settings.findUnique({ where: { id: "singleton" } });
    expect(row?.elevenLabsApiKey).toBeTruthy();
    expect(row?.elevenLabsApiKey).not.toBe(KEY);

    expect(await loadLiveVoiceProviderConfig()).toEqual({
      provider: "elevenlabs",
      apiKey: KEY,
      agentId: "agent_test_1",
      voiceIdRu: "voice_ru",
      voiceIdTg: null,
      voiceGender: "female",
    });
  });

  it("неизвестный поставщик не принимается", async () => {
    const res = await patch({ liveVoiceProvider: "openai" });
    expect(res.status).toBe(400);
  });

  it("обратно на Google — звонок снова идёт через Gemini", async () => {
    const res = await patch({ liveVoiceProvider: "google" });
    expect(res.status).toBe(200);
    expect(await loadLiveVoiceProviderConfig()).toEqual({ provider: "google" });
  });
});

describe("Настройки: пол голоса ElevenLabs (род робота о себе)", () => {
  it("мужской пол сохраняется и доходит до звонка; null возвращает женский", async () => {
    await patch({ liveVoiceProvider: "elevenlabs", elevenLabsAgentId: "agent_g", elevenLabsVoiceGender: "male" });
    const cfg = await loadLiveVoiceProviderConfig();
    expect(cfg).toMatchObject({ provider: "elevenlabs", voiceGender: "male" });

    const res = await patch({ elevenLabsVoiceGender: null });
    expect(res.status).toBe(200);
    expect(res.body.elevenLabsVoiceGender).toBeNull();
    expect(await loadLiveVoiceProviderConfig()).toMatchObject({ voiceGender: "female" });
  });

  it("чужое значение не принимается", async () => {
    const res = await patch({ elevenLabsVoiceGender: "robot" });
    expect(res.status).toBe(400);
  });
});

describe("Список звонков робота: кто вёл звонок", () => {
  it("поставщик отдаётся словом google/elevenlabs; пусто и мусор — null", async () => {
    const mk = (tag: string, provider: string | null) =>
      prisma.liveVoiceSession.create({
        data: { channelId: `el-list-${runId}-${tag}`, promptVersion: "t", direction: "test", provider },
      });
    await mk("g", "google");
    await mk("e", "elevenlabs");
    await mk("n", null);
    await mk("x", "other");
    const res = await request(app)
      .get("/api/v1/settings/live-voice/sessions?limit=100")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const by = (tag: string) => res.body.sessions.find((s: { channelId: string }) => s.channelId === `el-list-${runId}-${tag}`);
    expect(by("g").provider).toBe("google");
    expect(by("e").provider).toBe("elevenlabs");
    expect(by("n").provider).toBeNull();
    expect(by("x").provider).toBeNull();
  });
});
