import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { savePrivateFile } from "../src/lib/privateFiles.js";

/**
 * ГОЛОСОВЫЕ ЗАМЕТКИ АГЕНТА (заморозка/отказ/итог звонка и т.п.) — ДО 02.09.2026
 * файл лежал в публичной /uploads/voice-notes и раздавался статикой БЕЗ единой
 * проверки прав, вопреки собственному докблоку («слушает только агент/руководитель»).
 * Стережём здесь: (1) файл больше не пишется в публичную папку/URL-паттерн;
 * (2) выдача требует Authorization; (3) с валидным токеном файл действительно
 * читается; (4) имя из URL не даёт обойти путь.
 */

const runId = Date.now();
const password = "testpass123";
const agentPhone = `+99296${String(runId).slice(-7)}`;

let agentId = "";
let token = "";

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент голосовых заметок ${runId}`,
      phone: agentPhone,
      role: "AGENT",
      passwordHash: await bcrypt.hash(password, 10),
      isActive: true,
    },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agentPhone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken;
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("POST /me/voice-notes — приватное хранение", () => {
  it("сохраняет файл и отдаёт URL через /me/voice-notes/:name, а не публичную /uploads", async () => {
    const res = await request(app)
      .post("/api/v1/me/voice-notes")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", Buffer.from("тестовая запись"), { filename: "note.webm", contentType: "audio/webm" });

    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^\/me\/voice-notes\/[0-9a-f-]{36}\.webm$/i);
    expect(res.body.url).not.toMatch(/uploads/);
  });

  it("без audio-поля — 400", async () => {
    const res = await request(app).post("/api/v1/me/voice-notes").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /me/voice-notes/:name — выдача только под авторизацией", () => {
  it("без Authorization — 401, файл не отдаётся анонимно", async () => {
    const upload = await request(app)
      .post("/api/v1/me/voice-notes")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", Buffer.from("тестовая запись 2"), { filename: "note.webm", contentType: "audio/webm" });
    const name = (upload.body.url as string).split("/").pop()!;

    const res = await request(app).get(`/api/v1/me/voice-notes/${name}`);
    expect(res.status).toBe(401);
  });

  it("с Authorization — 200 и те же байты, что записали", async () => {
    const bytes = Buffer.from("проверка содержимого файла");
    const upload = await request(app)
      .post("/api/v1/me/voice-notes")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", bytes, { filename: "note.webm", contentType: "audio/webm" });
    const name = (upload.body.url as string).split("/").pop()!;

    const res = await request(app).get(`/api/v1/me/voice-notes/${name}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("audio/webm");
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it("выдуманное/чужое имя файла — 404, не 500 и не обход пути", async () => {
    const res = await request(app)
      .get("/api/v1/me/voice-notes/../../etc/passwd")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);

    const res2 = await request(app)
      .get("/api/v1/me/voice-notes/00000000-0000-0000-0000-000000000000.webm")
      .set("Authorization", `Bearer ${token}`);
    expect(res2.status).toBe(404);
  });
});

describe("GET /me/voice-notes/:name — вложения клиентов этим путём не отдаются (23.09.2026)", () => {
  it("фото клиента из переписки — 404, у вложений свой маршрут с правом и сверкой владельца", async () => {
    const file = (await savePrivateFile(Buffer.from("фото паспорта клиента"), "image/jpeg"))!;
    const conv = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `vn-attach-${runId}`,
        messages: [{ role: "user", content: "[фото]", attachments: [{ kind: "image", file, mime: "image/jpeg" }] }],
      },
    });
    try {
      const res = await request(app).get(`/api/v1/me/voice-notes/${file}`).set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(404);
    } finally {
      await prisma.botConversation.delete({ where: { id: conv.id } });
    }
  });
});
