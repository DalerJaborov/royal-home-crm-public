import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { signAccessToken } from "../src/auth/jwt.js";
import { createTestAgent } from "./helpers/ownAgent.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";
import { encodePcmChunks } from "../src/routes/liveVoiceListen.js";
import {
  publishAudio,
  publishTranscript,
  resetLiveVoiceMonitorForTests,
  sessionEnded,
  sessionStarted,
} from "../src/lib/telephony/liveVoiceMonitor.js";

/**
 * Прослушка робота: список и поток — только тому, кому положено слушать записи
 * разговоров робота (settings.manage + calls.transcripts + calls.hearRecording);
 * остальным 403. Поток проверяется живым соединением.
 */

const SESSION_ID = "6f1c1b0e-6a5d-4f0e-9b1e-0a7d4c3b2a10";
const ids: string[] = [];
const tokens: Record<string, string> = {};
let server: http.Server;
let port = 0;

async function agentWith(name: string, granted: string[], revoked: string[] = []) {
  const id = await createTestAgent(name);
  ids.push(id);
  await prisma.agent.update({ where: { id }, data: { permissions: { granted, revoked } } });
  return signAccessToken({ sub: id, role: "AGENT" });
}

beforeAll(async () => {
  const adminId = await createTestAgent("Администратор Прослушки");
  ids.push(adminId);
  await prisma.agent.update({ where: { id: adminId }, data: { role: "ADMIN" } });
  tokens.admin = signAccessToken({ sub: adminId, role: "ADMIN" });
  tokens.listener = await agentWith("Слушатель Полный", [
    "settings.manage",
    "calls.transcripts",
    "calls.hearRecording",
    "clients.viewPhone",
  ]);
  tokens.noPhone = await agentWith(
    "Слушатель Без Номера",
    ["settings.manage", "calls.transcripts", "calls.hearRecording"],
    ["clients.viewPhone"]
  );
  tokens.noHear = await agentWith("Без Прослушки", ["settings.manage", "calls.transcripts"], ["calls.hearRecording"]);
  tokens.plain = await agentWith("Рядовой", [], ["settings.manage", "calls.transcripts", "calls.hearRecording"]);
  server = http.createServer(app).listen(0);
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.close();
  await deleteAgentsWithTraces(ids);
});

afterEach(() => resetLiveVoiceMonitorForTests());

const startCall = (transcript: string[] = [], investigationOnly = false) =>
  sessionStarted({
    key: SESSION_ID,
    channelId: "ch-route",
    investigationOnly,
    callerNumber: "+992901234567",
    direction: "inbound",
    backlog: () => transcript.map((t) => ({ role: "client" as const, text: t })),
  });

describe("доступ к прослушке", () => {
  it("права на обычные звонки не открывают проверку: список и прямой поток закрыты", async () => {
    startCall(["Закрытая проверка"], true);
    const list = await request(app).get("/api/v1/live-voice/active").set("Authorization", `Bearer ${tokens.listener}`);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toEqual([]);
    const stream = await request(app).get(`/api/v1/live-voice/${SESSION_ID}/listen`).set("Authorization", `Bearer ${tokens.listener}`);
    expect(stream.status).toBe(404);
    expect(stream.text).not.toContain("Закрытая проверка");
  });

  it("администратор видит текущую закрытую проверку", async () => {
    startCall([], true);
    const list = await request(app).get("/api/v1/live-voice/active").set("Authorization", `Bearer ${tokens.admin}`);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toHaveLength(1);
    expect(list.body.sessions[0].id).toBe(SESSION_ID);
  });
  it("без входа — 401", async () => {
    expect((await request(app).get("/api/v1/live-voice/active")).status).toBe(401);
  });

  it.each(["plain", "noHear"])("без права слушать (%s) — 403 на список и на поток", async (who) => {
    startCall();
    const list = await request(app).get("/api/v1/live-voice/active").set("Authorization", `Bearer ${tokens[who]}`);
    expect(list.status).toBe(403);
    const stream = await request(app)
      .get(`/api/v1/live-voice/${SESSION_ID}/listen`)
      .set("Authorization", `Bearer ${tokens[who]}`);
    expect(stream.status).toBe(403);
  });

  it("руководство видит список; номер маскируется без права на телефоны", async () => {
    startCall();
    const full = await request(app).get("/api/v1/live-voice/active").set("Authorization", `Bearer ${tokens.listener}`);
    expect(full.status).toBe(200);
    expect(full.body.sessions).toHaveLength(1);
    expect(full.body.sessions[0]).toMatchObject({ id: SESSION_ID, direction: "inbound", callerNumber: "+992901234567" });

    const masked = await request(app).get("/api/v1/live-voice/active").set("Authorization", `Bearer ${tokens.noPhone}`);
    expect(masked.status).toBe(200);
    expect(masked.body.sessions[0].callerNumber).not.toBe("+992901234567");
  });

  it("неверный номер разговора — 400, закончившийся — 404", async () => {
    const bad = await request(app).get("/api/v1/live-voice/не-uuid/listen").set("Authorization", `Bearer ${tokens.listener}`);
    expect(bad.status).toBe(400);
    const gone = await request(app)
      .get(`/api/v1/live-voice/${SESSION_ID}/listen`)
      .set("Authorization", `Bearer ${tokens.listener}`);
    expect(gone.status).toBe(404);
  });
});

describe("поток событий", () => {
  it("закрывает уже открытый поток проверки после понижения администратора", async () => {
    const id = await createTestAgent("Отозванная Прослушка");
    ids.push(id);
    await prisma.agent.update({ where: { id }, data: { role: "ADMIN" } });
    const token = signAccessToken({ sub: id, role: "ADMIN" });
    startCall(["До отзыва"], true);
    const chunks: string[] = [];
    let demoted = false;
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { port, path: `/api/v1/live-voice/${SESSION_ID}/listen`, headers: { Authorization: `Bearer ${token}` } },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            chunks.push(chunk);
            if (!demoted && chunks.join("").includes("event: backlog")) {
              demoted = true;
              void prisma.agent.update({ where: { id }, data: { role: "AGENT" } }).catch(reject);
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        }
      );
      req.on("error", reject);
    });
    expect(demoted).toBe(true);
    publishTranscript(SESSION_ID, "bot", "После отзыва");
    expect(chunks.join("")).not.toContain("После отзыва");
  }, 25_000);

  it("отдаёт накопленное, потом живые реплики и звук, в конце — end и закрытие", async () => {
    startCall(["Алло"]);
    const chunks: string[] = [];
    let published = false;
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        { port, path: `/api/v1/live-voice/${SESSION_ID}/listen`, headers: { Authorization: `Bearer ${tokens.listener}` } },
        (res) => {
          expect(res.statusCode).toBe(200);
          expect(res.headers["content-type"]).toContain("text/event-stream");
          res.setEncoding("utf8");
          res.on("data", (c: string) => {
            chunks.push(c);
            // Поток открыт и накопленное пришло — публикуем живое и заканчиваем разговор.
            if (!published && chunks.join("").includes("event: backlog")) {
              published = true;
              publishTranscript(SESSION_ID, "bot", "Здравствуйте");
              publishAudio(SESSION_ID, "bot", new Int16Array([100, -100, 200]));
              setTimeout(() => sessionEnded(SESSION_ID, "hangup"), 250);
            }
          });
          res.on("end", resolve);
          res.on("error", reject);
        }
      );
      req.on("error", reject);
    });
    const text = chunks.join("");
    expect(text).toContain("event: ready");
    expect(text).toContain("event: backlog");
    expect(text).toContain("Алло");
    expect(text).toContain('event: transcript\ndata: {"role":"bot","text":"Здравствуйте"');
    expect(text).toContain("event: audio");
    expect(text).toContain('"side":"bot"');
    expect(text).toContain('event: end\ndata: {"reason":"hangup"}');
    expect(text.indexOf("event: backlog")).toBeLessThan(text.indexOf("event: transcript"));
  });

  it("закрытие соединения клиентом отписывает слушателя", async () => {
    startCall();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("поток не открылся")), 3000);
      const req = http.get(
        { port, path: `/api/v1/live-voice/${SESSION_ID}/listen`, headers: { Authorization: `Bearer ${tokens.listener}` } },
        (res) => {
          res.on("data", () => {
            clearTimeout(timer);
            req.destroy();
            resolve();
          });
        }
      );
      req.on("error", () => {});
    });
    // Закрытие доходит до сервера не мгновенно.
    let listeners = 1;
    for (let i = 0; i < 30 && listeners > 0; i++) {
      const list = await request(app).get("/api/v1/live-voice/active").set("Authorization", `Bearer ${tokens.listener}`);
      listeners = list.body.sessions[0].listeners;
      if (listeners > 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(listeners).toBe(0);
  });
});

describe("кодирование звука", () => {
  it("кадры склеиваются в один кусок PCM16 LE", () => {
    const b64 = encodePcmChunks([new Int16Array([1, 2]), new Int16Array([-1])]);
    expect([...Buffer.from(b64, "base64")]).toEqual([1, 0, 2, 0, 255, 255]);
  });
});
