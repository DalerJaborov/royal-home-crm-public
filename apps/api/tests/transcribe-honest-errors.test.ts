import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const transcribe = vi.hoisted(() => ({ result: vi.fn() }));
vi.mock("../src/ai/transcribe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/transcribe.js")>()),
  transcribeAudioResult: transcribe.result,
}));

import { app } from "../src/app.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Голосовой вопрос Ассистенту на iPhone 20.11.2026 давал «Сервер временно недоступен». Причина:
 * модель вернула ПУСТУЮ расшифровку, а маршрут отвечал на это 502 — Cloudflare подменяет тело 5xx,
 * и человек не видел настоящего текста. Теперь «не поняли речь» и «поставщик не ответил» — не 5xx
 * и с текстом по-русски.
 */
let agentId: string;
let token: string;

beforeAll(async () => {
  agentId = await createTestAgent("Речь Честность");
  token = signAccessToken({ sub: agentId, role: "AGENT" });
});
afterAll(async () => { await deleteAgentsWithTraces([agentId]); });
beforeEach(() => transcribe.result.mockReset());

const send = () =>
  request(app).post("/api/v1/transcribe").set("Authorization", `Bearer ${token}`)
    .attach("audio", Buffer.from("abc"), { filename: "voice.webm", contentType: "audio/webm" });

describe("POST /transcribe: честные ответы", () => {
  it("расшифровка есть — 200 и текст", async () => {
    transcribe.result.mockResolvedValue({ text: "  мои клиенты ", failed: false });
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("мои клиенты");
  });

  it("модель вернула пустую расшифровку — 422 «скажите ещё раз», не 5xx", async () => {
    transcribe.result.mockResolvedValue({ text: null, failed: false });
    const res = await send();
    expect(res.status).toBe(422);
    expect(res.body.error).toMatch(/Речь не распознана.*ещё раз/);
  });

  it("поставщик не ответил — 424 с причиной словами, не 5xx", async () => {
    transcribe.result.mockResolvedValue({ text: null, failed: true, detail: "Gemini HTTP 503 (gemini-3.1-pro-preview): overloaded", reason: "provider_failed" });
    const res = await send();
    expect(res.status).toBe(424);
    expect(res.status).toBeLessThan(500);
    expect(res.body.error).toMatch(/не ответил/);
    expect(res.body.error).not.toMatch(/gemini|503|overloaded/i);
  });

  it("ключ ИИ не задан — 424 и прямо об этом", async () => {
    transcribe.result.mockResolvedValue({ text: null, failed: true, detail: "ключ Gemini не задан", reason: "no_key" });
    const res = await send();
    expect(res.status).toBe(424);
    expect(res.body.error).toMatch(/не задан ключ/);
  });
});
