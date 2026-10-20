import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Загрузка видео: тип и размер проверяются на СТАРТЕ (находки №189 и №163).
 *
 * Расширение берётся из имени файла и попадает в ключ хранения; неподдерживаемое
 * отвергалось только после полной загрузки (502 «Не удалось собрать файл»).
 * Размер сессии «монтаж» не проверялся вовсе — до 10 000 частей по 32 МБ на диск.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992941${String(runId).slice(-7)}`;
let agentId: string;
let districtId: string;
let propertyId: string;
let token: string;
let n = 0;

const start = (extra: Record<string, unknown>) =>
  request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ uploadKey: `ext-${runId}-${n++}`, filename: "clip.mp4", sizeBytes: 2048, contentType: "video/mp4", ...extra });

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Агент типов видео", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })).id;
  districtId = (await prisma.district.create({ data: { name: `Район типов видео ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Типы видео ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 10",
        condition: "GOOD",
        status: "EDITING",
        intakeAgentId: agentId,
        createdById: agentId,
      },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.videoUploadSession.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([agentId]);
});

describe("№189 — расширение файла проверяется на старте сессии", () => {
  it("clip.webmv12 → 400 сразу, сессия не заводится", async () => {
    const res = await start({ filename: "clip.webmv12" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/не поддерживается/);
    expect(await prisma.videoUploadSession.count({ where: { propertyId } })).toBe(0);
  });

  it("исполняемый файл под видом видео → 400", async () => {
    expect((await start({ filename: "clip.exe" })).status).toBe(400);
  });

  it("обычные расширения принимаются, регистр не важен", async () => {
    for (const filename of ["a.mp4", "b.MOV", "c.webm", "d.m4v", "без-расширения"]) {
      const res = await start({ filename });
      expect(res.status, filename).toBe(201);
    }
  });
});

describe("№163 — размер сессии ограничен для любой цели", () => {
  it("«монтаж» на 300 ГБ → 400", async () => {
    const res = await start({ purpose: "handoff", sizeBytes: 300e9 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/больше/);
  });

  it("сырое видео на 3 ГБ → 400", async () => {
    expect((await start({ purpose: "raw", sizeBytes: 3e9 })).status).toBe(400);
  });
});
