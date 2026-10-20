import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * АУДИТ CODEX 04.10.2026, пакет E (публикации), срочные находки S1.
 *
 * PUB09: ручная кнопка «Выложить в истории» выпускала ролик, который ещё ждёт
 *        «Одобрить» (lib/clipReview.ts), в Stories Instagram и Facebook.
 * PUB10: фото-пост закрытого (offSite) объекта уходил в три канала через ручную
 *        кнопку и фоновое задание (force обходил всё, кроме статуса AVAILABLE).
 * PUB11: кнопка «Одобрить» под СТАРЫМ видео в Telegram одобряла новый ролик.
 *
 * Meta, Telegram и соцсети подменены целиком, база настоящая.
 */

const { publishPropertyInstagramStoriesSpy } = vi.hoisted(() => ({ publishPropertyInstagramStoriesSpy: vi.fn() }));
vi.mock("../src/lib/instagramStories.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/instagramStories.js")>();
  publishPropertyInstagramStoriesSpy.mockImplementation(actual.publishPropertyInstagramStories);
  return { ...actual, publishPropertyInstagramStories: publishPropertyInstagramStoriesSpy };
});

const { loadCredentials, instagramTokenIdentity } = vi.hoisted(() => ({
  loadCredentials: vi.fn(async () => ({ igToken: "test-ig-token", pageToken: "test-page-token", pageId: "page-1" })),
  instagramTokenIdentity: vi.fn(async () => ({ ok: true as const, id: "ig-user-1" })),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/messengers/meta.js")>()),
  loadCredentials,
  instagramTokenIdentity,
}));

const tg = vi.hoisted(() => ({
  sendMediaGroupFiles: vi.fn(async (_chatId: string, items: unknown[]) => (items as unknown[]).map((_x, i) => ({ message_id: 1000 + i }))),
  deleteChannelMessage: vi.fn(async () => {}),
  answerCallbackQuery: vi.fn(async () => ({})),
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async () => ({ message_id: 1 })),
  editMessageCaption: vi.fn(async () => {}),
  editMessageText: vi.fn(async () => {}),
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  ...tg,
  isTelegramEnabled: () => true,
}));

const { publishApprovedPostSpy } = vi.hoisted(() => ({ publishApprovedPostSpy: vi.fn(async () => []) }));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost: publishApprovedPostSpy,
}));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { uploadsDir, photoPostsDir } = await import("../src/upload.js");
const { publishPropertyPhotoPost } = await import("../src/lib/photoPosts.js");
const { handleClipReviewCallback } = await import("../src/telegram/clipReviewBot.js");

const runId = Date.now().toString(36);
const password = "testpass123";
let districtId: string;
let marketingToken: string;
let marketingId: string;
let reviewerId: string;
const reviewerChatId = String(7900000000 + (Date.now() % 100000000));
const propertyIds: string[] = [];
const files: string[] = [];
let settingsBefore: Record<string, unknown> | null = null;
let cbSeq = 0;

async function makeProperty(data: Record<string, unknown> = {}, withPhotos = 0) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-аудит-E-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 60,
      price: 55000,
      currency: "USD",
      districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      ...data,
    },
  });
  propertyIds.push(p.id);
  for (let i = 0; i < withPhotos; i++) {
    const buf = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 40 * (i + 1), g: 80, b: 120 } } }).webp().toBuffer();
    const name = `audit2-e-src-${runId}-${propertyIds.length}-${i}.webp`;
    await fs.writeFile(path.join(uploadsDir, name), buf);
    files.push(path.join(uploadsDir, name));
    await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: `/uploads/${name}`, thumbUrl: `/uploads/${name}`, order: i } });
  }
  return p;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-аудит-E-${runId}` } })).id;
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as unknown as Record<string, unknown>;
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { photoPostsEnabled: true, telegramChannelId: "-100test", instagramStoriesEnabled: false },
    create: { id: "singleton", photoPostsEnabled: true, telegramChannelId: "-100test" },
  });
  const passwordHash = await bcrypt.hash(password, 4);
  const marketing = await prisma.agent.create({
    data: { fullName: "Маркетолог аудита E", phone: `+99297${runId.slice(-7)}1`, role: "MARKETING", passwordHash },
  });
  marketingId = marketing.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: marketing.phone, password });
  expect(login.status).toBe(200);
  marketingToken = login.body.accessToken as string;
  const reviewer = await prisma.agent.create({
    data: {
      fullName: "Модератор роликов аудита E",
      phone: `+99297${runId.slice(-7)}2`,
      role: "ADMIN",
      passwordHash,
      telegramChatId: reviewerChatId,
      clipReviewTelegram: true,
    },
  });
  reviewerId = reviewer.id;
});

afterAll(async () => {
  await prisma.telegramModerationMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhotoPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyStoryPost.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: { in: [marketingId, reviewerId] } } }).catch(() => {});
  for (const f of files) await fs.rm(f, { force: true });
  await fs.rm(photoPostsDir, { recursive: true, force: true }).catch(() => {});
  if (settingsBefore) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        photoPostsEnabled: settingsBefore.photoPostsEnabled as boolean,
        telegramChannelId: settingsBefore.telegramChannelId as string | null,
        instagramStoriesEnabled: settingsBefore.instagramStoriesEnabled as boolean,
      },
    });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  publishPropertyInstagramStoriesSpy.mockClear();
  loadCredentials.mockClear();
  instagramTokenIdentity.mockClear();
  for (const fn of Object.values(tg)) fn.mockClear();
  publishApprovedPostSpy.mockClear();
});

// ---------------------------------------------------------------------------
describe("PUB09: ручная публикация в истории не обходит проверку ролика", () => {
  const post = (id: string) => request(app).post(`/api/v1/properties/${id}/instagram-stories-publish`).set("Authorization", `Bearer ${marketingToken}`);

  it("ролик ждёт «Одобрить» (PENDING) — 409, историю не публикуем", async () => {
    const p = await makeProperty({ videoHandoffFinalPath: "/uploads/handoff/pub09.mp4", clipReviewStatus: "PENDING", videoHandoffStatus: "RECEIVED" });
    const res = await post(p.id);
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("проверк");
    expect(publishPropertyInstagramStoriesSpy).not.toHaveBeenCalled();
  });

  it("ролик одобрен — путь не закрыт, публикация вызвана с force", async () => {
    const p = await makeProperty({ videoHandoffFinalPath: "/uploads/handoff/pub09b.mp4", clipReviewStatus: "APPROVED", videoHandoffStatus: "RECEIVED" });
    const res = await post(p.id);
    expect(res.status).toBe(200);
    expect(publishPropertyInstagramStoriesSpy).toHaveBeenCalledTimes(1);
    expect(publishPropertyInstagramStoriesSpy.mock.calls[0][2]).toEqual({ force: true });
  });

  it("сам помощник при force тоже не публикует ролик на проверке (будущий вызывающий не обойдёт гейт)", async () => {
    const p = await makeProperty({ videoHandoffFinalPath: "/uploads/handoff/pub09c.mp4", clipReviewStatus: "PENDING", videoHandoffStatus: "RECEIVED" });
    const actual = await vi.importActual<typeof import("../src/lib/instagramStories.js")>("../src/lib/instagramStories.js");
    const summary = await actual.publishPropertyInstagramStories(p.id, "/uploads/handoff/pub09c.mp4", { force: true });
    expect(summary.publishedParts).toBe(0);
    expect(summary.error).toBeTruthy();
    // До сети не дошли: токен Instagram даже не запрашивался.
    expect(loadCredentials).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("PUB10: фото-пост закрытого (offSite) объекта не выходит", () => {
  it("publishPropertyPhotoPost(force) по offSite — отказ, в Telegram/Meta не идём, ждущие слоты погашены", async () => {
    const p = await makeProperty({ offSite: true }, 2);
    await prisma.propertyPhotoPost.create({
      data: { propertyId: p.id, channel: "TELEGRAM", status: "SCHEDULED", scheduledAt: new Date(Date.now() + 3_600_000) },
    });
    const summary = await publishPropertyPhotoPost(p.id, { force: true });
    expect(summary.ok).toBe(false);
    expect(summary.reason).toContain("закрыт");
    expect(tg.sendMediaGroupFiles).not.toHaveBeenCalled();
    expect(loadCredentials).not.toHaveBeenCalled();
    const slots = await prisma.propertyPhotoPost.findMany({ where: { propertyId: p.id } });
    expect(slots.every((s) => s.status === "REMOVED")).toBe(true);
    expect(slots[0].error).toContain("закрыт");
  });

  it("ручной POST /:id/photo-post по offSite — ok:false, Telegram не вызван", async () => {
    const p = await makeProperty({ offSite: true }, 1);
    const res = await request(app).post(`/api/v1/properties/${p.id}/photo-post`).set("Authorization", `Bearer ${marketingToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(tg.sendMediaGroupFiles).not.toHaveBeenCalled();
  });

  it("обычный (не закрытый) объект с фото публикуется как раньше", async () => {
    const p = await makeProperty({ offSite: false }, 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("/media_publish") ? { id: "media-1" } : url.includes("fields=permalink") ? { permalink: "https://www.instagram.com/p/X/" } : url.includes("status_code") ? { status_code: "FINISHED" } : { id: "c-1" };
        const text = JSON.stringify(body);
        return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text } as unknown as Response;
      })
    );
    try {
      const summary = await publishPropertyPhotoPost(p.id, { force: true });
      expect(summary.results.TELEGRAM?.ok).toBe(true);
      expect(tg.sendMediaGroupFiles).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
describe("PUB11: кнопка под старым видео не решает за новый ролик", () => {
  function tap(data: string, messageId: number) {
    return handleClipReviewCallback({
      id: `cr-pub11-${runId}-${++cbSeq}`,
      data,
      message: { chat: { id: Number(reviewerChatId) }, message_id: messageId },
    } as never);
  }

  async function pendingWithTwoMessages() {
    const p = await makeProperty({ videoHandoffStatus: "RECEIVED", clipReviewStatus: "PENDING", clipReviewRequestedAt: new Date() });
    const base = { kind: "CLIP", propertyId: p.id, agentId: reviewerId, chatId: reviewerChatId, text: "ролик", propertyVersion: p.version };
    const oldMsgId = 51000 + Math.floor(Math.random() * 1000) * 2;
    const newMsgId = oldMsgId + 1;
    // Старое сообщение A уже помечено решённым (рассылка B), но edit кнопок упал.
    await prisma.telegramModerationMessage.create({ data: { ...base, messageId: oldMsgId, resolvedAt: new Date() } });
    await prisma.telegramModerationMessage.create({ data: { ...base, messageId: newMsgId } });
    return { p, oldMsgId, newMsgId };
  }

  it("«Одобрить» под устаревшим сообщением — ролик остаётся PENDING, модератору ответ про устаревшую кнопку", async () => {
    const { p, oldMsgId } = await pendingWithTwoMessages();
    await tap(`cr:a:${p.shortId}`, oldMsgId);
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { clipReviewStatus: true } });
    expect(fresh.clipReviewStatus).toBe("PENDING");
    const sent = [...tg.sendMessage.mock.calls, ...tg.sendMessageWithButtons.mock.calls].map((c) => String(c[1]));
    expect(sent.some((t) => t.includes("устарела"))).toBe(true);
  });

  it("«Вернуть монтажёру» под устаревшим сообщением — вопроса про причину нет", async () => {
    const { p, oldMsgId } = await pendingWithTwoMessages();
    await tap(`cr:r:${p.shortId}`, oldMsgId);
    const sent = [...tg.sendMessage.mock.calls, ...tg.sendMessageWithButtons.mock.calls].map((c) => String(c[1]));
    expect(sent.some((t) => t.includes("Почему возвращаем"))).toBe(false);
    expect(sent.some((t) => t.includes("устарела"))).toBe(true);
  });

  it("«Одобрить» под живым сообщением нового ролика — одобряет как раньше", async () => {
    const { p, newMsgId } = await pendingWithTwoMessages();
    await tap(`cr:a:${p.shortId}`, newMsgId);
    const fresh = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { clipReviewStatus: true } });
    expect(fresh.clipReviewStatus).toBe("APPROVED");
  });
});
