import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * ГОТОВЫЙ РОЛИК НА ПРОВЕРКУ МОДЕРАТОРУ (25.09.2026, lib/clipReview.ts,
 * telegram/clipReviewBot.ts). Владелец: «ролики от монтажёра пусть проходят
 * модерацию в Telegram Нурмухаммада, но отправка не файлом, а просто видео».
 *
 * Приём при clipReviewEnabled → RECEIVED + PENDING без слота, место монтажёра
 * свободно, модератору — sendVideo с кнопками; «Одобрить» (Telegram и CRM) —
 * слот и задание публикации, кнопки у копий сняты, повтор — «Уже решено»;
 * «Вернуть» — REJECTED, объект в начале очереди, монтажёру причина; сторож
 * 3 ч — один раз в 6 ч; выключено — приём как раньше. База, файлы и очередь —
 * настоящие; Telegram, ffprobe, соцсети и пуши подменены.
 */

const tg = vi.hoisted(() => {
  let nextId = 9000;
  return {
    sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ message_id: nextId++ })),
    sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: nextId++ })),
    sendVideoFromDisk: vi.fn(async (_chatId: string, _path: string, _caption?: string, _t?: number, _buttons?: unknown) => ({
      message_id: nextId++,
    })),
    editMessageCaption: vi.fn(async (_chatId: string, _messageId: number, _caption: string, _buttons?: unknown) => {}),
    editMessageText: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => ({})),
    sendDocumentFile: vi.fn(async (_chatId: string, _file: unknown, _name: string, _caption?: string) => ({ message_id: nextId++ })),
    sendDocument: vi.fn(async () => ({})),
  };
});
const { sendPushToAgents } = vi.hoisted(() => ({ sendPushToAgents: vi.fn(async () => 0) }));

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  ...tg,
  isTelegramEnabled: () => true,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents,
  sendPushToAgent: vi.fn(async () => {}),
}));
vi.mock("../src/lib/socialPublish.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialPublish.js")>()),
  publishApprovedPost: vi.fn(async () => []),
}));
vi.mock("../src/lib/ffmpeg.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ffmpeg.js")>()),
  probeMediaInfo: vi.fn(async () => ({
    hasVideo: true,
    hasAudio: true,
    videoCodec: "h264",
    audioCodec: "aac",
    width: 1080,
    height: 1920,
    rotation: 0,
    durationSec: 42,
    sizeBytes: 400 * 1024,
  })),
}));

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const vh = await import("../src/lib/videoHandoff.js");
const { handoffReceiptText } = await import("../src/telegram/montajerReceive.js");
const bot = await import("../src/telegram/clipReviewBot.js");
const { videoHandoffPublishJob } = await import("../src/jobs/videoHandoffPublish.js");
const { runVideoHandoffUnfinishedPublishWatchdogTick } = await import("../src/lib/videoHandoffUnfinishedPublishWatchdog.js");

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
let montajer: { id: string; chatId: string };
let reviewer: { id: string; chatId: string };
let plainAgentId: string;
let reviewerToken: string;
let plainToken: string;
const propertyIds: string[] = [];
const files: string[] = [];
const rawDirs = new Set<string>();
let cbSeq = 0;
let savedSettings: Record<string, unknown> | null = null;

const SETTINGS_KEYS = {
  clipReviewEnabled: true,
  videoHandoffEnabled: true,
  videoMontajerAgentId: true,
  autoPublishEnabled: true,
  videoHandoffQueuePaused: true,
  alarmHoursStart: true,
  alarmHoursEnd: true,
} as const;

async function setClipReview(enabled: boolean) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { clipReviewEnabled: enabled } });
}

async function makeAgent(suffix: string, role: "ADMIN" | "AGENT", extra: Record<string, unknown> = {}) {
  const phone = `+99296${runId}${suffix}`;
  const chatId = `79${runId}${suffix}`;
  await prisma.agent.deleteMany({ where: { OR: [{ phone }, { telegramChatId: chatId }] } });
  const a = await prisma.agent.create({
    data: { fullName: `Проверка ролика ${suffix}`, phone, role, passwordHash: await bcrypt.hash(password, 4), telegramChatId: chatId, ...extra },
  });
  return { id: a.id, chatId, phone };
}

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

/** Объект у монтажёра (держит место) с настоящим сырым файлом на диске. */
async function makeHolder(label: string) {
  const p = await prisma.property.create({
    data: {
      title: `Проверка ролика ${label} ${runId}`,
      type: "APARTMENT",
      areaSqm: 61,
      rooms: 2,
      price: 420000,
      currency: "TJS",
      address: "Монтажная, 7",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: plainAgentId,
      videoHandoffStatus: "SENT_TO_EDITOR",
      videoHandoffSentAt: new Date(),
    },
  });
  propertyIds.push(p.id);
  const storageKey = `${p.id}/${randomUUID()}.mp4`;
  const filePath = localVideoFilePath(storageKey)!;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const raw = randomBytes(8 * 1024);
  await fs.writeFile(filePath, raw);
  rawDirs.add(path.dirname(filePath));
  await prisma.propertyVideo.create({ data: { propertyId: p.id, storageKey, filename: "IMG_1.MOV", sizeBytes: raw.length, uploadedById: plainAgentId } });
  return p;
}

async function receive(propertyId: string) {
  const result = await vh.receiveEditedVideo(propertyId, randomBytes(vh.SAME_FINAL_MIN_BYTES + 4096), "final.mp4");
  const row = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { videoHandoffFinalPath: true } });
  if (row.videoHandoffFinalPath) files.push(path.join(videoHandoffDir, path.basename(row.videoHandoffFinalPath)));
  return result;
}

function tap(chatId: string, data: string) {
  return bot.handleClipReviewCallback({ id: `cr-${runId}-${++cbSeq}`, data, message: { chat: { id: Number(chatId) }, message_id: 1 } } as never);
}

const allTexts = () =>
  [
    ...tg.sendMessage.mock.calls.map((c) => [c[0], c[1]]),
    ...tg.sendMessageWithButtons.mock.calls.map((c) => [c[0], c[1]]),
    ...tg.sendDocumentFile.mock.calls.map((c) => [c[0], c[3] ?? ""]),
  ].map(([chat, text]) => ({ chat: String(chat), text: String(text) }));

const jobFor = (propertyId: string) => prisma.backgroundJob.findUnique({ where: { dedupeKey: vh.videoHandoffPublishDedupeKey(propertyId) } });

/** Ролик на проверке — приём с включённой проверкой, место свободно заранее. */
async function pendingClip(label: string) {
  await setClipReview(true);
  const p = await makeHolder(label);
  const result = await receive(p.id);
  expect(result.ok).toBe(true);
  await vh.settleBackgroundHandoffDispatches();
  // Рассылка модераторам идёт в отрыве — дождаться её здесь, чтобы она не
  // досылала в следующий тест.
  await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: p.id, kind: "CLIP" } }));
  return p;
}

beforeAll(async () => {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: SETTINGS_KEYS });
  savedSettings = s as Record<string, unknown> | null;
  const m = await makeAgent("1", "AGENT");
  montajer = { id: m.id, chatId: m.chatId };
  const r = await makeAgent("2", "ADMIN", { clipReviewTelegram: true });
  reviewer = { id: r.id, chatId: r.chatId };
  const plain = await makeAgent("3", "AGENT");
  plainAgentId = plain.id;
  reviewerToken = await login(r.phone);
  plainToken = await login(plain.phone);
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      videoHandoffEnabled: true,
      videoMontajerAgentId: montajer.id,
      autoPublishEnabled: true,
      videoHandoffQueuePaused: false,
      alarmHoursStart: "00:00",
      alarmHoursEnd: "23:59",
    },
  });
  vh.setMontajerSendPauseMsForTests(0);
});

beforeEach(() => {
  for (const fn of Object.values(tg)) fn.mockClear();
  sendPushToAgents.mockClear();
});

afterAll(async () => {
  await vh.settleBackgroundHandoffDispatches();
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  vh.setMontajerSendPauseMsForTests();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(vh.videoHandoffPublishDedupeKey) } } });
  await prisma.telegramModerationMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: { in: [reviewer.chatId, montajer.chatId] } } });
  await waitForSettled(() => prisma.auditLog.count({ where: { entityId: { in: propertyIds } } }));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.notification.deleteMany({ where: { tag: { in: propertyIds.map((id) => `clip-review-stale-${id}`) } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const f of files) await fs.rm(f, { force: true }).catch(() => {});
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: [montajer.id, reviewer.id, plainAgentId] } } }).catch(() => {});
});

describe("подпись модератору (юнит)", () => {
  it("номер объекта, монтажёр, факты карточки и факты ролика — без дубля «Объект №N»", () => {
    const text = bot.clipReviewCaption({
      shortId: 133,
      facts: "Объект №133\nАгент: Сурайё\nРайон: Сино\nЦена: 420 000 сомони",
      montajerName: "Фаридун",
      durationSec: 42,
      sizeBytes: 38 * 1024 * 1024,
      hasAudio: false,
    });
    expect(text.split("\n")[0]).toBe("🎬 Ролик на проверку · Объект №133");
    expect(text).toContain("Агент: Сурайё");
    expect(text).toContain("Район: Сино");
    expect(text).toContain("Монтажёр: Фаридун");
    expect(text).toContain("38 МБ");
    expect(text).toContain("без звука");
    expect(text.match(/Объект №133/g)).toHaveLength(1);
  });
});

describe("приём ролика при включённой проверке", () => {
  it("RECEIVED + PENDING, слота и задания нет, монтажёру «ушёл на проверку», модератору видео с кнопками, место освобождено", async () => {
    await setClipReview(true);
    const holder = await makeHolder("приём");
    const next = await makeHolder("следующий");
    await prisma.property.update({
      where: { id: next.id },
      data: { videoHandoffStatus: "QUEUED", videoHandoffSentAt: null, videoHandoffQueueOrder: -1000 },
    });

    const result = await receive(holder.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clipReviewPending).toBe(true);
    expect(result.scheduledPublishAt).toBeUndefined();

    const after = await prisma.property.findUniqueOrThrow({ where: { id: holder.id } });
    expect(after.videoHandoffStatus).toBe("RECEIVED");
    expect(after.clipReviewStatus).toBe("PENDING");
    expect(after.clipReviewRequestedAt).not.toBeNull();
    expect(after.scheduledPublishAt).toBeNull();
    expect(await jobFor(holder.id)).toBeNull();

    // Квитанция монтажёру — честно про проверку, без «публикую».
    const receipt = handoffReceiptText(result, holder.shortId);
    expect(receipt).toContain(`Ролик по объекту №${holder.shortId} принят, ушёл на проверку модератору`);
    expect(receipt).not.toContain("публикую");

    // Модератору — ВИДЕО (не документ) с кнопками cr:*.
    const call = await waitFor(() => tg.sendVideoFromDisk.mock.calls.find((c) => c[0] === reviewer.chatId) ?? null);
    expect(String(call[2])).toContain(`Объект №${holder.shortId}`);
    expect(String(call[2])).toContain("Монтажёр: Проверка ролика 1");
    expect(JSON.stringify(call[4])).toContain(`cr:a:${holder.shortId}`);
    expect(JSON.stringify(call[4])).toContain(`cr:r:${holder.shortId}`);
    // Размеры и длительность — Telegram иначе показывает чёрный кадр «00:00» или ролик боком (26.10.2026).
    expect(call[5]).toMatchObject({ width: 1080, height: 1920, durationSec: 42 });
    await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: holder.id, kind: "CLIP" } }));

    // Место монтажёра освобождено — следующий из очереди его занял.
    await vh.settleBackgroundHandoffDispatches();
    const seated = await prisma.property.findUniqueOrThrow({ where: { id: next.id }, select: { videoHandoffStatus: true } });
    expect(seated.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    // Освободить место для следующих тестов.
    await prisma.property.update({ where: { id: next.id }, data: { videoHandoffStatus: "NONE" } });
  });

  it("непроверенный ролик не уходит ни заданием, ни сторожем, ни «Опубликовать сейчас»", async () => {
    const p = await pendingClip("обход");
    expect(await vh.publishHandoffNow(p.id)).toMatchObject({ ok: false, error: vh.CLIP_REVIEW_PENDING_ERROR });
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffReceivedAt: new Date(Date.now() - 60 * 60_000) } });
    await runVideoHandoffUnfinishedPublishWatchdogTick();
    expect(await jobFor(p.id)).toBeNull();
    // Задание, дожившее до своей минуты (поставлено до включения проверки), ничего не публикует.
    const { publishApprovedPost } = await import("../src/lib/socialPublish.js");
    await videoHandoffPublishJob.run({ propertyId: p.id });
    expect(publishApprovedPost).not.toHaveBeenCalled();
     // Ручная кнопка TikTok — тоже нет.
    const tiktok = await request(app).post(`/api/v1/properties/${p.id}/tiktok-publish`).set("Authorization", `Bearer ${reviewerToken}`);
    expect(tiktok.status).toBe(409);
    expect(tiktok.body.error).toBe(vh.CLIP_REVIEW_PENDING_ERROR);
  });

  it("монтажёр переслал исправленный ролик — кнопки под прежним видео гаснут, новый приходит на проверку", async () => {
    const p = await pendingClip("пересылка");
    const first = await prisma.telegramModerationMessage.findFirstOrThrow({ where: { propertyId: p.id, kind: "CLIP" } });
    // Пересылка в окне трёх часов (reopenForResend) — объект снова ждёт файл.
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "SENT_TO_EDITOR" } });
    const again = await receive(p.id);
    expect(again.ok).toBe(true);
    const oldRow = await waitFor(async () => {
      const row = await prisma.telegramModerationMessage.findUniqueOrThrow({ where: { id: first.id } });
      return row.resolvedAt ? row : null;
    });
    expect(oldRow.resolvedAt).not.toBeNull();
    expect(tg.editMessageCaption.mock.calls.some((c) => c[1] === first.messageId && String(c[2]).includes("прислал новый ролик"))).toBe(true);
    await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: p.id, kind: "CLIP", resolvedAt: null } }));
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE" } });
  });
});

describe("решение в Telegram", () => {
  it("cr:a — APPROVED, слот и задание появились, кнопки у копий сняты; второе нажатие — «Уже решено»", async () => {
    const p = await pendingClip("одобрить");
    await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: p.id, kind: "CLIP" } }));

    await tap(reviewer.chatId, `cr:a:${p.shortId}`);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("APPROVED");
    expect(after.clipReviewDecidedById).toBe(reviewer.id);
    expect(after.scheduledPublishAt).not.toBeNull();
    const job = await jobFor(p.id);
    expect(job?.status).toBe("PENDING");
    expect(job?.runAt.getTime()).toBe(after.scheduledPublishAt!.getTime());

    const edit = await waitFor(() => tg.editMessageCaption.mock.calls.find((c) => c[0] === reviewer.chatId) ?? null);
    expect(String(edit[2])).toContain("✅ Одобрил Проверка ролика 2");
    expect(edit[3]).toBeNull();
    expect(await prisma.telegramModerationMessage.count({ where: { propertyId: p.id, resolvedAt: null } })).toBe(0);

    tg.sendMessage.mockClear();
    await tap(reviewer.chatId, `cr:a:${p.shortId}`);
    expect(allTexts().some((t) => t.chat === reviewer.chatId && t.text.startsWith("Уже решено: одобрил"))).toBe(true);
    const audits = await waitFor(async () => {
      const n = await prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_CLIP_APPROVED" } });
      return n >= 1 ? n : null;
    });
    expect(audits).toBe(1);
  });

  it("cr:r + причина + комментарий — REJECTED, объект снова у монтажёра, ему ушла причина", async () => {
    const p = await pendingClip("вернуть");
    await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: p.id, kind: "CLIP" } }));

    await tap(reviewer.chatId, `cr:r:${p.shortId}`);
    const menu = tg.sendMessageWithButtons.mock.calls.find((c) => c[0] === reviewer.chatId && String(c[1]).includes("Почему возвращаем"));
    expect(JSON.stringify(menu?.[2])).toContain(`cr:rr:${p.shortId}:3`);
    await tap(reviewer.chatId, `cr:rr:${p.shortId}:3`); // POOR_EDIT
    expect(await bot.handleClipReviewText(reviewer.chatId, "склейки дёргаются на 12-й секунде")).toBe(true);
    await vh.settleBackgroundHandoffDispatches();

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("REJECTED");
    expect(after.clipReviewComment).toContain("склейки дёргаются");
    expect(["QUEUED", "SENT_TO_EDITOR"]).toContain(after.videoHandoffStatus);
    const remake = await prisma.videoRemakeRequest.findFirst({ where: { propertyId: p.id } });
    expect(remake?.reason).toBe("POOR_EDIT");
    expect(remake?.comment).toBe("склейки дёргаются на 12-й секунде");
    // Место свободно — объект сразу у монтажёра, и причина ушла ему.
    expect(after.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    expect(allTexts().some((t) => t.chat === montajer.chatId && t.text.includes("Плохой монтаж"))).toBe(true);

    const edit = await waitFor(() => tg.editMessageCaption.mock.calls.find((c) => c[0] === reviewer.chatId) ?? null);
    expect(String(edit[2])).toContain("↩️ Вернул Проверка ролика 2");
    expect(String(edit[2])).toContain("склейки дёргаются");
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE" } });
  });

  it("вернули, пока место занято, — объект первым в очереди", async () => {
    const p = await pendingClip("очередь");
    const busy = await makeHolder("держатель"); // место занято
    const tail = await makeHolder("хвост");
    await prisma.property.update({ where: { id: tail.id }, data: { videoHandoffStatus: "QUEUED", videoHandoffQueueOrder: -2000 } });

    await tap(reviewer.chatId, `cr:r:${p.shortId}`);
    await tap(reviewer.chatId, `cr:rr:${p.shortId}:1`); // NO_MUSIC — комментарий не обязателен
    await tap(reviewer.chatId, `cr:rx:${p.shortId}`);

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("REJECTED");
    expect(after.videoHandoffStatus).toBe("QUEUED");
    const queue = await vh.orderedQueue();
    expect(queue[0]?.id).toBe(p.id);
    await prisma.property.updateMany({ where: { id: { in: [p.id, busy.id, tail.id] } }, data: { videoHandoffStatus: "NONE" } });
  });
});

describe("решение в CRM", () => {
  it("approve — слот и задание; повтор — 409 «Уже решено»; без права — 403", async () => {
    const p = await pendingClip("crm-одобрить");
    const denied = await request(app).post(`/api/v1/properties/${p.id}/clip-review/approve`).set("Authorization", `Bearer ${plainToken}`);
    expect(denied.status).toBe(403);

    const res = await request(app).post(`/api/v1/properties/${p.id}/clip-review/approve`).set("Authorization", `Bearer ${reviewerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.scheduledPublishAt).toBeTruthy();
    expect((await jobFor(p.id))?.status).toBe("PENDING");
    await waitFor(() => tg.editMessageCaption.mock.calls.find((c) => String(c[2]).includes("✅ Одобрил")) ?? null);

    const again = await request(app).post(`/api/v1/properties/${p.id}/clip-review/approve`).set("Authorization", `Bearer ${reviewerToken}`);
    expect(again.status).toBe(409);
    expect(again.body.error).toContain("Уже решено");
  });

  it("reject — REJECTED и возврат монтажёру; обычное «Вернуть монтажёру» тоже закрывает проверку", async () => {
    const a = await pendingClip("crm-вернуть");
    const bad = await request(app)
      .post(`/api/v1/properties/${a.id}/clip-review/reject`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ reason: "OTHER" });
    expect(bad.status).toBe(400); // «Другое» без комментария — та же схема, что у возврата

    const res = await request(app)
      .post(`/api/v1/properties/${a.id}/clip-review/reject`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ reason: "WRONG_OBJECT" });
    expect(res.status).toBe(200);
    await vh.settleBackgroundHandoffDispatches();
    const afterA = await prisma.property.findUniqueOrThrow({ where: { id: a.id } });
    expect(afterA.clipReviewStatus).toBe("REJECTED");
    expect(afterA.videoHandoffStatus).toBe("SENT_TO_EDITOR");
    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: a.id, action: "PROPERTY_CLIP_REJECTED" } }));
    await prisma.property.update({ where: { id: a.id }, data: { videoHandoffStatus: "NONE" } });

    const b = await pendingClip("crm-обычный-возврат");
    await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: b.id, kind: "CLIP" } }));
    const plain = await request(app)
      .post(`/api/v1/properties/${b.id}/send-back-to-montajer`)
      .set("Authorization", `Bearer ${reviewerToken}`)
      .send({ reason: "NO_MUSIC" });
    expect(plain.status).toBe(200);
    await vh.settleBackgroundHandoffDispatches();
    const afterB = await prisma.property.findUniqueOrThrow({ where: { id: b.id } });
    expect(afterB.clipReviewStatus).toBe("REJECTED");
    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: b.id, action: "PROPERTY_CLIP_REJECTED" } }));
    // Закрытие сообщений модераторам идёт следом за решением, не в одной
    // транзакции с ним — под нагрузкой полного прогона отстаёт на мгновение.
    await waitFor(
      async () => ((await prisma.telegramModerationMessage.count({ where: { propertyId: b.id, resolvedAt: null } })) === 0 ? true : null),
      { label: "сообщения модераторам по объекту закрыты" }
    );
    await prisma.property.update({ where: { id: b.id }, data: { videoHandoffStatus: "NONE" } });
  });
});

describe("ролик загружен из CRM (26.10.2026)", () => {
  async function uploadFromCrm(propertyId: string, token: string) {
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/video-handoff/upload`)
      .set("Authorization", `Bearer ${token}`)
      .attach("video", randomBytes(vh.SAME_FINAL_MIN_BYTES + 4096), "final.mp4");
    const row = await prisma.property.findUniqueOrThrow({ where: { id: propertyId }, select: { videoHandoffFinalPath: true } });
    if (row.videoHandoffFinalPath) files.push(path.join(videoHandoffDir, path.basename(row.videoHandoffFinalPath)));
    return res;
  }

  it("модератор загрузил сам — одобрено на его имя, слот и задание сразу, на проверку не рассылается", async () => {
    await setClipReview(true);
    const p = await makeHolder("crm-модератор");
    const res = await uploadFromCrm(p.id, reviewerToken);
    expect(res.status).toBe(200);
    expect(res.body.clipReviewPending).toBe(false);
    expect(res.body.scheduledPublishAt).toBeTruthy();

    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("APPROVED");
    expect(after.clipReviewDecidedById).toBe(reviewer.id);
    expect((await jobFor(p.id))?.status).toBe("PENDING");
    await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_CLIP_APPROVED" } }));

    await vh.settleBackgroundHandoffDispatches();
    await new Promise((r) => setTimeout(r, 200));
    expect(tg.sendVideoFromDisk.mock.calls.some((c) => String(c[2]).includes(`Объект №${p.shortId}`))).toBe(false);
    expect(await prisma.telegramModerationMessage.count({ where: { propertyId: p.id } })).toBe(0);
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE" } });
  });

  it("монтажёр загрузил через CRM — проверка остаётся", async () => {
    await setClipReview(true);
    const p = await makeHolder("crm-монтажёр");
    const montajerToken = await login(`+99296${runId}1`);
    const res = await uploadFromCrm(p.id, montajerToken);
    expect(res.status).toBe(200);
    expect(res.body.clipReviewPending).toBe(true);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("PENDING");
    await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: p.id, kind: "CLIP" } }));
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE" } });
  });
});

describe("сторож «ролик ждёт проверки»", () => {
  it("дольше 3 часов — напоминание один раз, повтор не раньше чем через 6 часов", async () => {
    // Окно тревог по умолчанию — 09:50–14:45 по Душанбе (workingHours.ts): «сейчас» и
    // «сейчас + 7 ч» в него вместе не попадают никогда, тест был зелёным только утром
    // (25.09.2026, красный в дневном полном прогоне). На время теста окно — круглые сутки.
    const saved = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { alarmHoursStart: true, alarmHoursEnd: true } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { alarmHoursStart: "00:00", alarmHoursEnd: "23:59" } });
    const p = await pendingClip("сторож");
    const now = new Date();
    await prisma.property.update({ where: { id: p.id }, data: { clipReviewRequestedAt: new Date(now.getTime() - 4 * 3_600_000) } });
    tg.sendMessageWithButtons.mockClear();

    const remindedTo = () => tg.sendMessageWithButtons.mock.calls.filter((c) => String(c[1]).includes(`объекту №${p.shortId} ждёт проверки`));

    await bot.runClipReviewStaleAlarmTick(now);
    expect(remindedTo()).toHaveLength(1);
    // Решить можно прямо из напоминания (26.10.2026) — те же кнопки, что под видео,
    // и сообщение записано: решение или новый ролик гасят его кнопки вместе с видео.
    expect(JSON.stringify(remindedTo()[0][2])).toContain(`cr:a:${p.shortId}`);
    expect(JSON.stringify(remindedTo()[0][2])).toContain(`cr:r:${p.shortId}`);
    expect(await prisma.telegramModerationMessage.count({ where: { propertyId: p.id, kind: "CLIP_TEXT", resolvedAt: null } })).toBe(1);
    expect(sendPushToAgents).toHaveBeenCalledWith(expect.arrayContaining([reviewer.id]), expect.objectContaining({ tag: `clip-review-stale-${p.id}` }));

    await bot.runClipReviewStaleAlarmTick(new Date(now.getTime() + 60 * 60_000));
    expect(remindedTo()).toHaveLength(1);

    await bot.runClipReviewStaleAlarmTick(new Date(now.getTime() + 7 * 3_600_000));
    expect(remindedTo()).toHaveLength(2);
    await prisma.settings.update({ where: { id: "singleton" }, data: saved });
  });

  it("свежий ролик (меньше 3 часов) — тишина", async () => {
    const p = await pendingClip("свежий");
    tg.sendMessageWithButtons.mockClear();
    await bot.runClipReviewStaleAlarmTick(new Date());
    expect(tg.sendMessageWithButtons.mock.calls.some((c) => String(c[1]).includes(`объекту №${p.shortId}`))).toBe(false);
  });
});

describe("проверка выключена — приём как раньше", () => {
  it("RECEIVED без проверки, слот и задание сразу, квитанция «публикую», модератору ничего", async () => {
    await setClipReview(false);
    const p = await makeHolder("без-проверки");
    const result = await receive(p.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.clipReviewPending).toBeUndefined();
    expect(result.scheduledPublishAt).toBeInstanceOf(Date);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("NONE");
    expect(after.scheduledPublishAt?.getTime()).toBe(result.scheduledPublishAt!.getTime());
    expect((await jobFor(p.id))?.runAt.getTime()).toBe(result.scheduledPublishAt!.getTime());
    expect(handoffReceiptText(result, p.shortId)).toContain("публикую по каналам");
    await vh.settleBackgroundHandoffDispatches();
    await new Promise((r) => setTimeout(r, 200));
    expect(tg.sendVideoFromDisk.mock.calls.some((c) => String(c[2]).includes(`Объект №${p.shortId}`))).toBe(false);
    expect(await prisma.telegramModerationMessage.count({ where: { propertyId: p.id } })).toBe(0);
  });
});
