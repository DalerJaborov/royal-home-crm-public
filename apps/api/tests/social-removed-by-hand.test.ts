import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * «УДАЛЕНО В ПРИЛОЖЕНИИ» (24.09.2026) — POST /properties/:id/social-removed-by-hand.
 * TikTok (и Instagram без ключа удаления) не дают снять пост программой, канал
 * оставался в publishedChannels навсегда, и при замене ролика новый туда уже не
 * уходил. Кнопка вычёркивает канал; публикация, идущая прямо сейчас, этому мешает.
 */

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { deleteAgentsWithTraces } = await import("./helpers/cleanupAgents.js");
const { videoHandoffPublishDedupeKey, VIDEO_HANDOFF_PUBLISH_JOB_TYPE } = await import("../src/lib/videoHandoff.js");

const runId = Date.now();
const password = "testpass123";

let districtId: string;
let marketingToken: string;
let plainAgentToken: string;
const agentIds: string[] = [];
const propertyIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function publishedProperty(title: string, jobStatus?: "PENDING" | "RUNNING" | "DONE") {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      videoHandoffStatus: "RECEIVED",
      videoHandoffFinalPath: "/uploads/handoff/by-hand.mp4",
      publishedChannels: ["TELEGRAM", "TIKTOK", "INSTAGRAM"],
      publishedPostIds: { TELEGRAM: "11", TIKTOK: "v_old", INSTAGRAM: "ig_old" },
      instagramUrl: "https://www.instagram.com/reel/old/",
    },
  });
  propertyIds.push(p.id);
  if (jobStatus) {
    await prisma.backgroundJob.create({
      data: {
        type: VIDEO_HANDOFF_PUBLISH_JOB_TYPE,
        payload: { propertyId: p.id },
        dedupeKey: videoHandoffPublishDedupeKey(p.id),
        maxAttempts: 3,
        status: jobStatus,
        runAt: new Date(Date.now() + 3_600_000),
      },
    });
  }
  return p;
}

function mark(id: string, token: string, body: unknown) {
  return request(app).post(`/api/v1/properties/${id}/social-removed-by-hand`).set("Authorization", `Bearer ${token}`).send(body);
}

function fresh(id: string) {
  return prisma.property.findUniqueOrThrow({
    where: { id },
    select: { publishedChannels: true, publishedPostIds: true, instagramUrl: true },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-by-hand-${runId}` } })).id;
  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог by-hand", phone: `+992979${runId}`, role: "MARKETING", passwordHash },
  });
  const plain = await prisma.agent.create({
    data: { fullName: "Агент by-hand", phone: `+992980${runId}`, role: "AGENT", passwordHash },
  });
  agentIds.push(marketing.id, plain.id);
  marketingToken = await login(marketing.phone);
  plainAgentToken = await login(plain.phone);
});

afterAll(async () => {
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(videoHandoffPublishDedupeKey) } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await deleteAgentsWithTraces(agentIds);
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.$disconnect();
});

describe("POST /properties/:id/social-removed-by-hand", () => {
  it("TikTok удалён руками — канал и id поста вычеркнуты, остальные на месте; новый ролик уйдёт в свой час", async () => {
    const p = await publishedProperty("TikTok удалён", "PENDING");
    const res = await mark(p.id, marketingToken, { channel: "TIKTOK" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changed: true, willPublish: true, publishRunning: false });
    const after = await fresh(p.id);
    expect(after.publishedChannels.sort()).toEqual(["INSTAGRAM", "TELEGRAM"]);
    expect(after.publishedPostIds).toEqual({ TELEGRAM: "11", INSTAGRAM: "ig_old" });
    expect(after.instagramUrl).not.toBeNull();
  });

  it("Instagram удалён руками — ссылка на пост тоже очищается", async () => {
    const p = await publishedProperty("Instagram удалён", "DONE");
    const res = await mark(p.id, marketingToken, { channel: "INSTAGRAM" });
    expect(res.status).toBe(200);
    expect(res.body.willPublish).toBe(false);
    const after = await fresh(p.id);
    expect(after.publishedChannels).not.toContain("INSTAGRAM");
    expect(after.instagramUrl).toBeNull();
  });

  it("повторное нажатие — ничего не ломает, changed: false", async () => {
    const p = await publishedProperty("Дважды");
    expect((await mark(p.id, marketingToken, { channel: "TIKTOK" })).body.changed).toBe(true);
    const again = await mark(p.id, marketingToken, { channel: "TIKTOK" });
    expect(again.status).toBe(200);
    expect(again.body.changed).toBe(false);
  });

  it("публикация идёт прямо сейчас — отметка проходит (#1098), publishRunning: true", async () => {
    const p = await publishedProperty("Идёт публикация", "RUNNING");
    const res = await mark(p.id, marketingToken, { channel: "TIKTOK" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, publishRunning: true });
    expect((await fresh(p.id)).publishedChannels).not.toContain("TIKTOK");
  });

  it("площадка, которую программа снимает сама, — 400; обычный агент — 403", async () => {
    const p = await publishedProperty("Проверки");
    expect((await mark(p.id, marketingToken, { channel: "TELEGRAM" })).status).toBe(400);
    expect((await mark(p.id, plainAgentToken, { channel: "TIKTOK" })).status).toBe(403);
    expect((await fresh(p.id)).publishedChannels).toContain("TIKTOK");
  });

  it("объект не найден — 404", async () => {
    const res = await mark("00000000-0000-0000-0000-000000000000", marketingToken, { channel: "TIKTOK" });
    expect(res.status).toBe(404);
  });
});
