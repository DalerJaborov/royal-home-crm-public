import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * «УДАЛИТЬ С КАРТОЧКИ ОШИБОЧНО ПРИНЯТЫЙ РОЛИК» (09.10.2026) —
 * POST /properties/:id/final-video/discard. Ролик для №153 приняли на №154;
 * №153 отказывал «уже сдан по №154», потому что совпадение ищется по файлу
 * на диске, а «Вернуть монтажёру» путь не стирает. Кнопка снимает готовый
 * ролик с карточки и ждущее задание публикации; посты в сетях не трогает.
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

async function receivedProperty(title: string, jobStatus?: "PENDING" | "RUNNING", finalPath: string | null = "/uploads/handoff/discard-me.mp4") {
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
      videoHandoffStatus: finalPath ? "RECEIVED" : "NONE",
      videoHandoffFinalPath: finalPath,
      videoHandoffReceivedAt: finalPath ? new Date() : null,
      scheduledPublishAt: finalPath ? new Date(Date.now() + 3_600_000) : null,
      clipReviewStatus: finalPath ? "APPROVED" : "NONE",
      publishedChannels: ["TELEGRAM", "INSTAGRAM"],
      publishedPostIds: { TELEGRAM: "11", INSTAGRAM: "ig_old" },
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

function discard(id: string, token: string) {
  return request(app).post(`/api/v1/properties/${id}/final-video/discard`).set("Authorization", `Bearer ${token}`).send({});
}

function fresh(id: string) {
  return prisma.property.findUniqueOrThrow({
    where: { id },
    select: {
      videoHandoffFinalPath: true,
      videoHandoffReceivedAt: true,
      videoHandoffStatus: true,
      videoHandoffManualSince: true,
      scheduledPublishAt: true,
      clipReviewStatus: true,
      publishedChannels: true,
    },
  });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Тест-район-discard-${runId}` } })).id;
  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог discard", phone: `+992981${runId}`, role: "MARKETING", passwordHash },
  });
  const plain = await prisma.agent.create({
    data: { fullName: "Агент discard", phone: `+992982${runId}`, role: "AGENT", passwordHash },
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

describe("POST /properties/:id/final-video/discard", () => {
  it("ролик снят с карточки, задание публикации удалено, объект снова ждёт ролик; сети не тронуты", async () => {
    const p = await receivedProperty("Ошибочный ролик", "PENDING");
    const res = await discard(p.id, marketingToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, publishedChannels: ["TELEGRAM", "INSTAGRAM"] });

    const after = await fresh(p.id);
    expect(after.videoHandoffFinalPath).toBeNull();
    expect(after.videoHandoffReceivedAt).toBeNull();
    expect(after.scheduledPublishAt).toBeNull();
    expect(after.clipReviewStatus).toBe("NONE");
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(after.videoHandoffManualSince).not.toBeNull();
    expect(after.publishedChannels.sort()).toEqual(["INSTAGRAM", "TELEGRAM"]);
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: videoHandoffPublishDedupeKey(p.id) } })).toBe(0);
  });

  it("публикация идёт прямо сейчас — 409, ролик и задание на месте", async () => {
    const p = await receivedProperty("Идёт публикация", "RUNNING");
    const res = await discard(p.id, marketingToken);
    expect(res.status).toBe(409);
    expect((await fresh(p.id)).videoHandoffFinalPath).not.toBeNull();
    expect(await prisma.backgroundJob.count({ where: { dedupeKey: videoHandoffPublishDedupeKey(p.id) } })).toBe(1);
  });

  it("ролика на карточке нет — 409; обычный агент — 403; объект не найден — 404", async () => {
    const empty = await receivedProperty("Без ролика", undefined, null);
    expect((await discard(empty.id, marketingToken)).status).toBe(409);

    const p = await receivedProperty("Права");
    expect((await discard(p.id, plainAgentToken)).status).toBe(403);
    expect((await fresh(p.id)).videoHandoffFinalPath).not.toBeNull();

    expect((await discard("00000000-0000-0000-0000-000000000000", marketingToken)).status).toBe(404);
  });
});
