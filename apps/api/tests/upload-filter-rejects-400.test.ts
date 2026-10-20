import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * Отказ по типу файла — понятный 400, а не «Внутренняя ошибка сервера» (G11, 02.10.2026).
 *
 * Так было: загрузчики отклоняли неподходящий файл обычной ошибкой, обработчик
 * узнавал только два точных текста, и остальные отказы (документ сделки в .docx,
 * музыка ожидания в .txt, видео с пустым типом) уходили в общий хвост: 500,
 * «Внутренняя ошибка сервера» и новая строка в журнале ошибок, будившая директора.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const phone = `+992990${runId}`;
let directorId = "";
let token = "";

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone } });
  directorId = (
    await prisma.agent.create({
      data: { fullName: "Директор загрузок", phone, role: "DIRECTOR", passwordHash: await bcrypt.hash(password, 4) },
    })
  ).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone, password })).body.accessToken;
});

afterAll(async () => {
  await prisma.session.deleteMany({ where: { agentId: directorId } });
  await prisma.agent.deleteMany({ where: { id: directorId } });
  await prisma.$disconnect();
});

describe("Неподходящий тип файла", () => {
  it("документ сделки в .docx — 400 с текстом, что допустимо", async () => {
    const res = await request(app)
      .post(`/api/v1/deals/${randomUUID()}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .field("kind", "CONTRACT")
      .attach("file", Buffer.from("PK docx"), {
        filename: "договор.docx",
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PDF/);
  });

  it("музыка ожидания в .txt — 400 с текстом, что допустимо", async () => {
    grantElevation(directorId);
    const res = await request(app)
      .post("/api/v1/settings/telephony-audio/hold")
      .set("Authorization", `Bearer ${token}`)
      .attach("audio", Buffer.from("не звук"), { filename: "music.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/mp3|wav/);
  });
});
