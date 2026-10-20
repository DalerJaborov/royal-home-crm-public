import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * ПРОВЕРКА ИСХОДНИКОВ ВЫКЛЮЧЕНА (25.09.2026, владелец: «выключи временно
 * одобрение роликов от агентов — пусть сразу идут монтажёру»).
 *
 * Settings.rawReviewRequired = false: объект на проверке с фото, получивший
 * видео, CRM одобряет сама тем же approveReviewAll (source "auto"), переводит в
 * EDITING и ставит монтажёру; модераторам ни пуша «ждёт проверки», ни карточки
 * в Telegram. true — всё как раньше. Загрузка видео — настоящим HTTP-роутом;
 * Telegram, пуши и постановка монтажёру подменены (у них свои тесты).
 */

const tg = vi.hoisted(() => {
  let nextId = 5000;
  return {
    sendMessage: vi.fn(async () => ({ message_id: nextId++ })),
    sendMessageWithButtons: vi.fn(async () => ({ message_id: nextId++ })),
    sendMediaGroupFiles: vi.fn(async () => [{ message_id: nextId++ }]),
    sendPhotoFromDisk: vi.fn(async () => ({ message_id: nextId++ })),
    sendVideoFromDisk: vi.fn(async () => ({ message_id: nextId++ })),
  };
});
const { sendPushToAgents, queueVideoHandoff } = vi.hoisted(() => ({
  sendPushToAgents: vi.fn(async () => 0),
  queueVideoHandoff: vi.fn(async () => {}),
}));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  ...tg,
  isTelegramEnabled: () => true,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
}));
vi.mock("../src/lib/videoHandoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/videoHandoff.js")>()),
  queueVideoHandoff,
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const { AUTO_APPROVE_NOTE, autoApproveIfRawReviewOff } = await import("../src/lib/propertyReview.js");

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
let agentId: string;
let moderatorId: string;
let token: string;
const propertyIds: string[] = [];
let savedRawReview: boolean | null = null;

async function setRawReview(required: boolean) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { rawReviewRequired: required },
    create: { id: "singleton", rawReviewRequired: required },
  });
}

async function makePending() {
  const p = await prisma.property.create({
    data: {
      title: `Без проверки исходников ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 300000,
      currency: "TJS",
      address: "Автоодобрения, 1",
      condition: "GOOD",
      status: "PENDING_REVIEW",
      intakeAgentId: agentId,
      createdById: agentId,
      photos: { create: [{ url: "/uploads/rro-a.webp", thumbUrl: "/uploads/thumbs/rro-a.webp", order: 0 }] },
    },
  });
  propertyIds.push(p.id);
  return p;
}

function uploadVideo(propertyId: string, tag: string) {
  return request(app)
    .post(`/api/v1/properties/${propertyId}/videos`)
    .set("Authorization", `Bearer ${token}`)
    .attach("videos", Buffer.from(`видео ${tag} ${runId}`), { filename: `${tag}.mp4`, contentType: "video/mp4" });
}

const pendingReviewPushes = () =>
  sendPushToAgents.mock.calls.filter((c) => (c as unknown[])[1] && String((c as [unknown, { title?: string }])[1].title).includes("ждёт проверки"));

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 4);
  const phone = `+99295${runId}1`;
  await prisma.agent.deleteMany({ where: { phone: { in: [phone, `+99295${runId}2`] } } });
  agentId = (await prisma.agent.create({ data: { fullName: "Агент автоодобрения", phone, role: "AGENT", passwordHash } })).id;
  // Модератор с Telegram-модерацией: при выключенной проверке ему не должно прийти ничего.
  moderatorId = (
    await prisma.agent.create({
      data: {
        fullName: "Модератор автоодобрения",
        phone: `+99295${runId}2`,
        role: "ADMIN",
        passwordHash,
        telegramChatId: `78${runId}2`,
        telegramModeration: true,
      },
    })
  ).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { rawReviewRequired: true } });
  savedRawReview = s?.rawReviewRequired ?? null;
});

beforeEach(() => {
  for (const fn of Object.values(tg)) fn.mockClear();
  sendPushToAgents.mockClear();
  queueVideoHandoff.mockClear();
});

afterAll(async () => {
  await setRawReview(savedRawReview ?? true);
  const videos = await prisma.propertyVideo.findMany({ where: { propertyId: { in: propertyIds } }, select: { storageKey: true } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  for (const v of videos) {
    const p = localVideoFilePath(v.storageKey);
    if (p) fs.rmSync(p, { force: true });
  }
  await waitForSettled(() => prisma.auditLog.count({ where: { entityId: { in: propertyIds } } }));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.telegramModerationMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, moderatorId] } } }).catch(() => {});
});

describe("проверка исходников выключена", () => {
  it("загрузка видео → фото и видео одобрены сами, EDITING, в очередь монтажёру, журнал с пометкой", async () => {
    await setRawReview(false);
    const p = await makePending();

    const res = await uploadVideo(p.id, "a");
    expect(res.status).toBe(201);

    const after = await waitFor(async () => {
      const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
      return row.status === "EDITING" ? row : null;
    });
    expect(after.photosApprovedAt).not.toBeNull();
    expect(after.videoApprovedAt).not.toBeNull();
    await waitFor(() => (queueVideoHandoff.mock.calls.some((c) => (c as unknown[])[0] === p.id) ? true : null));

    const audits = await waitFor(async () => {
      const rows = await prisma.auditLog.findMany({
        where: { entityId: p.id, action: { in: ["PROPERTY_PHOTOS_APPROVED", "PROPERTY_VIDEO_APPROVED"] } },
      });
      return rows.length === 2 ? rows : null;
    });
    for (const a of audits) {
      expect(a.agentId).toBeNull();
      expect(a.agentName).toBe("Система");
      expect(a.meta).toMatchObject({ source: "auto", note: AUTO_APPROVE_NOTE });
    }
  });

  it("модераторам ничего не уходит: ни пуша «ждёт проверки», ни карточки в Telegram", async () => {
    await setRawReview(false);
    const p = await makePending();
    // Вход на проверку (создание/возврат) — тот же путь, что зовут роуты.
    const { notifyPendingReview } = await import("../src/lib/propertyPipeline.js");
    await notifyPendingReview(p.id, p.shortId, p.title);
    expect(pendingReviewPushes()).toHaveLength(0);
    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
    // Видео ещё нет — объект молча ждёт загрузки, а не висит у модераторов.
    const still = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(still.status).toBe("PENDING_REVIEW");

    const res = await uploadVideo(p.id, "b");
    expect(res.status).toBe(201);
    await waitFor(async () => ((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).status === "EDITING" ? true : null));
    expect(pendingReviewPushes()).toHaveLength(0);
    expect(tg.sendMessageWithButtons).not.toHaveBeenCalled();
    expect(await prisma.telegramModerationMessage.count({ where: { propertyId: p.id } })).toBe(0);
  });

  it("повторный вызов после одобрения ничего не ломает (гонка двух загрузок)", async () => {
    await setRawReview(false);
    const p = await makePending();
    await prisma.propertyVideo.create({
      data: { propertyId: p.id, storageKey: `rro/${p.id}.mp4`, filename: "v.mp4", sizeBytes: 1000, uploadedById: agentId },
    });
    const [a, b] = await Promise.all([autoApproveIfRawReviewOff(p.id), autoApproveIfRawReviewOff(p.id)]);
    expect([a, b].sort()).toEqual(["approved", "waiting"]);
    const approvals = await waitFor(async () => {
      const n = await prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_VIDEO_APPROVED" } });
      return n >= 1 ? n : null;
    });
    expect(approvals).toBe(1);
  });
});

describe("проверка исходников включена — как раньше", () => {
  it("загрузка видео объекту на проверке не одобряет его сама, пуш модераторам при входе на проверку уходит", async () => {
    await setRawReview(true);
    const p = await makePending();
    const res = await uploadVideo(p.id, "c");
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.status).toBe("PENDING_REVIEW");
    expect(after.videoApprovedAt).toBeNull();
    expect(queueVideoHandoff).not.toHaveBeenCalled();
    expect(await autoApproveIfRawReviewOff(p.id)).toBe("review_on");

    const { notifyPendingReview } = await import("../src/lib/propertyPipeline.js");
    await notifyPendingReview(p.id, p.shortId, p.title);
    expect(pendingReviewPushes().length).toBeGreaterThan(0);
  });
});
