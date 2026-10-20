import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/**
 * РАСШИРЕНИЕ ВИДЕО ЧЕРНОВИКА — ИЗ БЕЛОГО СПИСКА (глубокая проверка 02.10.2026, D15).
 *
 * Карточка объекта отвергала неизвестные расширения ещё с находки №189, а
 * черновик мастера брал расширение из имени файла как есть: «.html»/«.svg»
 * ложился в хранилище с этим расширением и при создании объекта переезжал в
 * PropertyVideo.storageKey.
 */

const runId = Date.now();
const tail = String(runId).slice(-7);
let agentId = "";
let token = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Черновик видео ${runId}`, phone: `+992964${tail}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password: "testpass123" });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.propertyDraft.deleteMany({ where: { agentId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

const start = (filename: string) =>
  request(app)
    .post("/api/v1/properties/drafts/current/videos/sessions")
    .set("Authorization", `Bearer ${token}`)
    .send({ uploadKey: `draft-ext-${runId}-${filename}`, filename, sizeBytes: 1024, contentType: "video/mp4" });

describe("POST /drafts/current/videos/sessions", () => {
  it("«.html» под видом видео — 400 до начала загрузки", async () => {
    const res = await start("tour.html");
    expect(res.status).toBe(400);
    expect(await prisma.propertyDraftMedia.count({ where: { uploadKey: `draft-ext-${runId}-tour.html` } })).toBe(0);
  });

  it("обычный .mov принимается, ключ хранения с тем же расширением", async () => {
    const res = await start("IMG_0001.MOV");
    expect(res.status).toBe(201);
    const media = await prisma.propertyDraftMedia.findUniqueOrThrow({ where: { uploadKey: `draft-ext-${runId}-IMG_0001.MOV` } });
    expect(media.storageKey?.endsWith(".mov")).toBe(true);
  });
});
