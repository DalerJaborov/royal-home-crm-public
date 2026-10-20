import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/ai/transcribe.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/transcribe.js")>()),
  transcribeAudio: vi.fn(async () => "текст записи"),
}));
vi.mock("../src/lib/privateFiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/privateFiles.js")>()),
  savePrivateFile: vi.fn(async () => "test-voice.webm"),
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ai/client.js")>()),
  callAiText: vi.fn(async () => ({
    interaction: { type: "CALL", notes: "заметка" },
    clientUpdates: {},
  })),
}));

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { signAccessToken } from "../src/auth/jwt.js";

/**
 * Платная расшифровка речи и разбор заметки ограничены на сотрудника
 * (находка №149, ночная проверка 24.09.2026): раньше у /transcribe, /me/voice-notes
 * и /ai/parse-note был только общий потолок 1500 запросов за 5 минут.
 */

const LIMIT = 30;
let agentIds: string[] = [];
const tokens: string[] = [];
let clientId: string;

beforeAll(async () => {
  for (const name of ["Речь А", "Речь Б", "Речь В"]) {
    const id = await createTestAgent(name);
    agentIds.push(id);
    tokens.push(signAccessToken({ sub: id, role: "AGENT" }));
  }
  const client = await prisma.client.create({
    data: { fullName: "Речь Клиент", phone: `+992${Math.floor(Math.random() * 900_000_000) + 100_000_000}`, assignedAgentId: agentIds[2], acceptedAt: new Date(), source: "WALK_IN" },
  });
  clientId = client.id;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: clientId } });
  await deleteAgentsWithTraces(agentIds);
});

describe("ограничитель платной речи на сотрудника", () => {
  it("POST /transcribe: после 30 запросов за окно — 429 по-русски", async () => {
    const send = () =>
      request(app)
        .post("/api/v1/transcribe")
        .set("Authorization", `Bearer ${tokens[0]}`)
        .attach("audio", Buffer.from("abc"), { filename: "v.webm", contentType: "audio/webm" });
    for (let i = 0; i < LIMIT; i++) expect((await send()).status).toBe(200);
    const res = await send();
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/[а-я]/i);
  });

  it("чужой лимит не задевает другого сотрудника", async () => {
    const res = await request(app)
      .post("/api/v1/transcribe")
      .set("Authorization", `Bearer ${tokens[1]}`)
      .attach("audio", Buffer.from("abc"), { filename: "v.webm", contentType: "audio/webm" });
    expect(res.status).toBe(200);
  });

  it("POST /me/voice-notes: после 30 запросов за окно — 429", async () => {
    const send = () =>
      request(app)
        .post("/api/v1/me/voice-notes")
        .set("Authorization", `Bearer ${tokens[1]}`)
        .attach("audio", Buffer.from("abc"), { filename: "v.webm", contentType: "audio/webm" });
    let last = 0;
    for (let i = 0; i < LIMIT + 1; i++) last = (await send()).status;
    expect(last).toBe(429);
  });

  it("POST /ai/parse-note: после 30 запросов за окно — 429", async () => {
    const send = () =>
      request(app)
        .post("/api/v1/ai/parse-note")
        .set("Authorization", `Bearer ${tokens[2]}`)
        .send({ text: "звонил, хочет трёшку", clientId });
    for (let i = 0; i < LIMIT; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
  });
});
