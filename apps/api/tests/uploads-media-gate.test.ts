import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { clipVideoDir, uploadsDir } from "../src/upload.js";
import { signMediaToken, verifyMediaToken } from "../src/auth/jwt.js";
import { publicUploadUrl } from "../src/lib/crmPublicUrl.js";

/**
 * К11 (аудит безопасности 11.09.2026): /uploads/video, /uploads/automontage и
 * /uploads/handoff больше не отдаются голой статикой — нужен подписанный токен
 * в query (`?t=`) либо валидный access-токен CRM. Фото объектов (обычная статика
 * /uploads) остаются открыты как были — проверяем и это, чтобы гейт не расползся
 * на то, что должно быть публичным.
 */

const runId = Date.now();
const password = "testpass123";
const agentPhone = `+99296${String(runId).slice(-7)}`;

let agentToken: string;
const createdAgentIds: string[] = [];
const createdFiles: string[] = [];

async function login(phone: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken;
}

beforeAll(async () => {
  const agent = await prisma.agent.create({
    data: { fullName: `Агент Гейта ${runId}`, phone: agentPhone, passwordHash: await bcrypt.hash(password, 10), role: "AGENT", isActive: true },
  });
  createdAgentIds.push(agent.id);
  agentToken = await login(agentPhone);

  fs.mkdirSync(clipVideoDir, { recursive: true });
  const name = `gate-test-${runId}.mp4`;
  fs.writeFileSync(path.join(clipVideoDir, name), `video-bytes-${runId}`);
  createdFiles.push(path.join(clipVideoDir, name));
});

afterAll(async () => {
  await prisma.agent.deleteMany({ where: { id: { in: createdAgentIds } } });
  for (const full of createdFiles) fs.rmSync(full, { force: true });
});

const relPath = () => `/uploads/video/gate-test-${runId}.mp4`;

describe("Гейт /uploads/video|automontage|handoff (К7-соседний, К11)", () => {
  it("без токена и без авторизации — 403, не файл", async () => {
    const res = await request(app).get(relPath());
    expect(res.status).toBe(403);
  });

  it("с подписанным токеном на ЭТОТ путь — файл отдаётся", async () => {
    const token = signMediaToken(relPath());
    const res = await request(app).get(`${relPath()}?t=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(`video-bytes-${runId}`);
  });

  it("токен, подписанный на ДРУГОЙ путь, не подходит сюда", async () => {
    const token = signMediaToken("/uploads/video/some-other-file.mp4");
    const res = await request(app).get(`${relPath()}?t=${token}`);
    expect(res.status).toBe(403);
  });

  it("токен, подделанный лишней буквой, невалиден", async () => {
    const token = signMediaToken(relPath());
    const res = await request(app).get(`${relPath()}?t=${token}x`);
    expect(res.status).toBe(403);
  });

  it("действующий access-токен CRM тоже пропускает — без ссылки из ответа API", async () => {
    const res = await request(app).get(relPath()).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
  });

  it("verifyMediaToken отдельно: путь должен совпасть буквально", () => {
    const token = signMediaToken("/uploads/video/a.mp4");
    expect(verifyMediaToken(token, "/uploads/video/a.mp4")).toBe(true);
    expect(verifyMediaToken(token, "/uploads/video/b.mp4")).toBe(false);
  });
});

describe("Фото объектов остаются открытой статикой — гейт их не касается", () => {
  const photoName = `photo-gate-${runId}.jpg`;
  const photoPath = path.join(uploadsDir, photoName);

  beforeAll(() => {
    fs.writeFileSync(photoPath, `photo-bytes-${runId}`);
    createdFiles.push(photoPath);
  });

  it("без токена и без авторизации — файл всё равно отдаётся", async () => {
    const res = await request(app).get(`/uploads/${photoName}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(`photo-bytes-${runId}`);
  });
});

describe("publicUploadUrl подписывает только три закрытых подкаталога", () => {
  const prevBase = process.env.CRM_PUBLIC_URL;

  beforeAll(() => {
    process.env.CRM_PUBLIC_URL = "https://crm.example.test";
  });
  afterAll(() => {
    if (prevBase === undefined) delete process.env.CRM_PUBLIC_URL;
    else process.env.CRM_PUBLIC_URL = prevBase;
  });

  it("видео получает ?t=, фото — нет", () => {
    const video = publicUploadUrl("/uploads/video/x.mp4");
    const automontage = publicUploadUrl("/uploads/automontage/x.mp4");
    const handoff = publicUploadUrl("/uploads/handoff/x.mp4");
    const photo = publicUploadUrl("/uploads/x.jpg");

    expect(video).toMatch(/\?t=/);
    expect(automontage).toMatch(/\?t=/);
    expect(handoff).toMatch(/\?t=/);
    expect(photo).not.toMatch(/\?t=/);
    expect(photo).toBe("https://crm.example.test/uploads/x.jpg");
  });
});

describe("Подпись прямо в JSON-ответе (res.json), не только у publicUploadUrl", () => {
  it("незакрытые ссылки (avatarUrl и т.п.) подпись не трогает", async () => {
    const me = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${agentToken}`);
    expect(me.status).toBe(200);
    if (me.body.avatarUrl) expect(me.body.avatarUrl).not.toMatch(/\?t=/);
  });

  it("объект с clipVideoUrl из закрытого подкаталога получает ?t= прямо в ответе GET", async () => {
    const district = await prisma.district.create({ data: { name: `Район гейта ${runId}` } });
    const property = await prisma.property.create({
      data: {
        title: `Объект гейта ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 100000,
        currency: "TJS",
        districtId: district.id,
        address: "Тестовая гейта, 1",
        condition: "GOOD",
        status: "AVAILABLE",
        createdById: createdAgentIds[0],
        assignedAgentId: createdAgentIds[0],
        clipVideoStatus: "READY",
        clipVideoUrl: relPath(),
      },
    });
    const res = await request(app).get(`/api/v1/properties/${property.shortId}`).set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
    expect(res.body.clipVideoUrl).toContain(relPath());
    expect(res.body.clipVideoUrl).toMatch(/\?t=/);
    await prisma.property.delete({ where: { id: property.id } });
    await prisma.district.delete({ where: { id: district.id } });
  });
});
