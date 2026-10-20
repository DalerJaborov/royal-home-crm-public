import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { UPLOAD_VIDEO_MAX_BYTES, VIDEO_TOO_LARGE_CODE } from "@royal-home/shared";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * ЕДИНЫЙ ПРЕДЕЛ ВИДЕО (владелец 07.10.2026). Живой случай: IMG_9854.MOV на
 * 746,6 МБ мастер отверг («больше лимита 700 МБ») ещё до первого байта, а
 * подсказка обещала другое. Теперь и мастер, и карточка объекта сверяются с
 * одним числом из packages/shared: ровно предел проходит, предел + 1 байт — 400
 * с машинным кодом и числом предела; 746 МБ (раньше падало) сессию открывает.
 */

const runId = Date.now();
const password = "testpass123";
const phone = `+992942${String(runId).slice(-7)}`;
let agentId = "";
let districtId = "";
let propertyId = "";
let token = "";
let n = 0;

const draftStart = (sizeBytes: number) =>
  request(app)
    .post("/api/v1/properties/drafts/current/videos/sessions")
    .set("Authorization", `Bearer ${token}`)
    .send({ uploadKey: `lim-draft-${runId}-${n++}`, filename: "IMG_9854.MOV", sizeBytes, contentType: "video/quicktime" });

const cardStart = (sizeBytes: number) =>
  request(app)
    .post(`/api/v1/properties/${propertyId}/videos/upload-sessions`)
    .set("Authorization", `Bearer ${token}`)
    .send({ uploadKey: `lim-card-${runId}-${n++}`, filename: "IMG_9854.MOV", sizeBytes, contentType: "video/quicktime", purpose: "raw" });

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: "Агент предела видео", phone, role: "AGENT", passwordHash: await bcrypt.hash(password, 10) } })).id;
  districtId = (await prisma.district.create({ data: { name: `Район предела видео ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Предел видео ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 11",
        condition: "GOOD",
        status: "EDITING",
        intakeAgentId: agentId,
        createdById: agentId,
      },
    })
  ).id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.videoUploadSession.deleteMany({ where: { propertyId } });
  await prisma.propertyDraft.deleteMany({ where: { agentId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await deleteAgentsWithTraces([agentId]);
});

describe("мастер: POST /properties/drafts/current/videos/sessions", () => {
  it("746 МБ (раньше отказ «больше 700 МБ») — сессия открывается", async () => {
    const res = await draftStart(Math.round(746.6 * 1024 * 1024));
    expect(res.status).toBe(201);
  });

  it("ровно предел проходит", async () => {
    expect((await draftStart(UPLOAD_VIDEO_MAX_BYTES)).status).toBe(201);
  });

  it("предел + 1 байт — 400 с code и limitBytes, строка в черновике не заводится", async () => {
    const key = `lim-draft-${runId}-${n}`;
    const res = await draftStart(UPLOAD_VIDEO_MAX_BYTES + 1);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(VIDEO_TOO_LARGE_CODE);
    expect(res.body.limitBytes).toBe(UPLOAD_VIDEO_MAX_BYTES);
    expect(res.body.error).toMatch(/предела 2 ГБ/);
    expect(await prisma.propertyDraftMedia.count({ where: { uploadKey: key } })).toBe(0);
  });
});

describe("карточка объекта: POST /properties/:id/videos/upload-sessions", () => {
  it("746 МБ сырого видео (раньше мешала настройка 600 МБ) — сессия открывается", async () => {
    const res = await cardStart(Math.round(746.6 * 1024 * 1024));
    expect(res.status).toBe(201);
  });

  it("ровно предел проходит", async () => {
    expect((await cardStart(UPLOAD_VIDEO_MAX_BYTES)).status).toBe(201);
  });

  it("предел + 1 байт — 400 с code и limitBytes", async () => {
    const res = await cardStart(UPLOAD_VIDEO_MAX_BYTES + 1);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(VIDEO_TOO_LARGE_CODE);
    expect(res.body.limitBytes).toBe(UPLOAD_VIDEO_MAX_BYTES);
  });
});
