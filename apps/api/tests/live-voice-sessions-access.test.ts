import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";

vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  r2PresignDownloadUrl: vi.fn(async () => "https://r2.example/signed"),
}));

import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Живой голос: запись и превью расшифровки закрыты теми же правами, что и
 * обычные записи звонков (находка №225, ночная проверка 24.09.2026):
 *  - /live-voice/sessions/:id/recording требует ещё и calls.hearRecording;
 *  - превью расшифровки без clients.viewPhone приходит с замаскированными номерами.
 */

const runId = Date.now();
let sessionId = "";
const ids: string[] = [];
const tokens: Record<string, string> = {};

async function agentWith(name: string, granted: string[], revoked: string[] = []) {
  const id = await createTestAgent(name);
  ids.push(id);
  await prisma.agent.update({ where: { id }, data: { permissions: { granted, revoked } } });
  return signAccessToken({ sub: id, role: "AGENT" });
}

beforeAll(async () => {
  // calls.transcripts — общий вход к сессиям живого голоса с 02.10.2026 (#1044);
  // здесь проверяются права СВЕРХ него: прослушивание и номера.
  tokens.noHear = await agentWith("Голос Без Записи", ["settings.manage", "calls.transcripts"]);
  tokens.hear = await agentWith("Голос С Записью", ["settings.manage", "calls.transcripts", "calls.hearRecording"]);
  tokens.noPhone = await agentWith("Голос Без Номера", ["settings.manage", "calls.transcripts"], ["clients.viewPhone"]);
  tokens.phone = await agentWith("Голос С Номером", ["settings.manage", "calls.transcripts", "clients.viewPhone"]);
  sessionId = (
    await prisma.liveVoiceSession.create({
      data: {
        channelId: `lv-access-${runId}`,
        transcript: "Клиент: перезвоните на +992901234567, пожалуйста",
        recordingUrl: `live-voice/${runId}.wav`,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.liveVoiceSession.deleteMany({ where: { id: sessionId } });
  await deleteAgentsWithTraces(ids);
});

const recording = (token: string) =>
  request(app).get(`/api/v1/settings/live-voice/sessions/${sessionId}/recording`).set("Authorization", `Bearer ${token}`);

describe("запись живого голоса", () => {
  it("без calls.hearRecording — 403, ссылка не выдаётся", async () => {
    const res = await recording(tokens.noHear);
    expect(res.status).toBe(403);
    expect(res.body.url).toBeUndefined();
  });

  it("с calls.hearRecording — ссылка выдаётся", async () => {
    const res = await recording(tokens.hear);
    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://r2.example/signed");
  });
});

describe("превью расшифровки живого голоса", () => {
  const preview = async (token: string) => {
    const res = await request(app).get("/api/v1/settings/live-voice/sessions").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body.sessions as { id: string; transcriptPreview: string | null }[]).find((s) => s.id === sessionId)!
      .transcriptPreview!;
  };

  it("без clients.viewPhone номер закрыт маской", async () => {
    const text = await preview(tokens.noPhone);
    expect(text).not.toContain("901234567");
    expect(text).toContain("•");
  });

  it("с clients.viewPhone текст как есть", async () => {
    expect(await preview(tokens.phone)).toContain("+992901234567");
  });
});
