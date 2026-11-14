import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { VIDEO_REMAKE_REASONS, VIDEO_REMAKE_REASONS_REQUIRING_COMMENT } from "@royal-home/shared";
import { waitFor, waitForSettled } from "./helpers/waitFor.js";

/**
 * ГОТОВЫЙ РОЛИК ПОДТВЕРЖДАЕТ ХОЗЯИН ОБЪЕКТА (11.11.2026, lib/clipReview.ts,
 * telegram/clipReviewBot.ts). Владелец: «все ролики что от монтажера обратно идут
 * после монтажа пусть идут к своим хозяином с кнопками подтвердить и они сразу
 * добавятся»; страховка — «автоматически поститься но не ночью с 12 по 7 утра».
 *
 * Подтверждение хозяином, возврат монтажёру хозяином, чужой агент без права,
 * двойное нажатие, автопубликация через 3 ч (и повторный тик), ночной перенос на
 * 07:00, хозяин без Telegram. База, файлы и очередь настоящие; Telegram, ffprobe,
 * соцсети и пуши подменены.
 */

const tg = vi.hoisted(() => {
  let nextId = 19000;
  return {
    sendMessage: vi.fn(async (_chatId: string, _text: string) => ({ message_id: nextId++ })),
    sendMessageWithButtons: vi.fn(async (_chatId: string, _text: string, _buttons: unknown) => ({ message_id: nextId++ })),
    sendVideoFromDisk: vi.fn(async (_chatId: string, _path: string, _caption?: string, _t?: number, _buttons?: unknown) => ({
      message_id: nextId++,
    })),
    editMessageCaption: vi.fn(async () => {}),
    editMessageText: vi.fn(async () => {}),
    answerCallbackQuery: vi.fn(async () => ({})),
    sendDocumentFile: vi.fn(async () => ({ message_id: nextId++ })),
    sendDocument: vi.fn(async () => ({})),
  };
});

vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  ...tg,
  isTelegramEnabled: () => true,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgents: vi.fn(async () => 0),
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
    durationSec: 30,
    sizeBytes: 400 * 1024,
  })),
}));

const { prisma } = await import("../src/db.js");
const { videoHandoffDir } = await import("../src/upload.js");
const { localVideoFilePath } = await import("../src/lib/localVideoStorage.js");
const vh = await import("../src/lib/videoHandoff.js");
const cr = await import("../src/lib/clipReview.js");
const bot = await import("../src/telegram/clipReviewBot.js");

const runId = String(Date.now()).slice(-7);
let montajer: { id: string; chatId: string };
let reviewer: { id: string; chatId: string };
let owner: { id: string; chatId: string };
let stranger: { id: string; chatId: string };
let ownerNoTgId: string;
const agentIds: string[] = [];
const propertyIds: string[] = [];
const files: string[] = [];
const rawDirs = new Set<string>();
let cbSeq = 0;
let savedSettings: Record<string, unknown> | null = null;

const SETTINGS_KEYS = {
  clipReviewEnabled: true,
  clipOwnerApproveEnabled: true,
  clipOwnerAutoPublishHours: true,
  videoHandoffEnabled: true,
  videoMontajerAgentId: true,
  autoPublishEnabled: true,
  videoHandoffQueuePaused: true,
  alarmHoursStart: true,
  alarmHoursEnd: true,
} as const;

/** Момент по Душанбе «ГГГГ-ММ-ДД ЧЧ:ММ» → настоящий Date. */
const dushanbe = (s: string) => new Date(`${s.replace(" ", "T")}:00+05:00`);

async function makeAgent(suffix: string, role: "ADMIN" | "AGENT", extra: Record<string, unknown> = {}, withChat = true) {
  const phone = `+99297${runId}${suffix}`;
  const chatId = `78${runId}${suffix}`;
  await prisma.agent.deleteMany({ where: { OR: [{ phone }, { telegramChatId: chatId }] } });
  const a = await prisma.agent.create({
    data: {
      fullName: `Хозяин ролика ${suffix}`,
      phone,
      role,
      passwordHash: await bcrypt.hash("testpass123", 4),
      telegramChatId: withChat ? chatId : null,
      ...extra,
    },
  });
  agentIds.push(a.id);
  return { id: a.id, chatId };
}

/** Объект у монтажёра с настоящим сырым файлом; хозяин — `ownerId` (интейкер). */
async function makeHolder(label: string, ownerId: string) {
  const p = await prisma.property.create({
    data: {
      title: `Хозяин ролика ${label} ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      rooms: 2,
      price: 380000,
      currency: "TJS",
      address: "Хозяйская, 3",
      condition: "GOOD",
      status: "EDITING",
      intakeAgentId: ownerId,
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
  await prisma.propertyVideo.create({ data: { propertyId: p.id, storageKey, filename: "IMG_2.MOV", sizeBytes: raw.length, uploadedById: ownerId } });
  return p;
}

async function pendingClip(label: string, ownerId: string, expectOwnerChat: string | null) {
  const p = await makeHolder(label, ownerId);
  const result = await vh.receiveEditedVideo(p.id, randomBytes(vh.SAME_FINAL_MIN_BYTES + 4096), "final.mp4");
  expect(result.ok).toBe(true);
  const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffFinalPath: true, clipReviewStatus: true } });
  expect(row.clipReviewStatus).toBe("PENDING");
  if (row.videoHandoffFinalPath) files.push(path.join(videoHandoffDir, path.basename(row.videoHandoffFinalPath)));
  await vh.settleBackgroundHandoffDispatches();
  // Рассылка идёт в отрыве — дождаться копии руководству (и хозяину, если ждём).
  await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: p.id, kind: "CLIP", chatId: reviewer.chatId } }), {
    timeoutMs: 10_000,
  });
  if (expectOwnerChat) {
    await waitFor(() => prisma.telegramModerationMessage.findFirst({ where: { propertyId: p.id, kind: "CLIP", chatId: expectOwnerChat } }), {
      timeoutMs: 10_000,
    });
  }
  return p;
}

function tap(chatId: string, data: string) {
  return bot.handleClipReviewCallback({ id: `co-${runId}-${++cbSeq}`, data, message: { chat: { id: Number(chatId) }, message_id: 1 } } as never);
}

const textsTo = (chatId: string) =>
  [...tg.sendMessage.mock.calls, ...tg.sendMessageWithButtons.mock.calls].filter((c) => String(c[0]) === chatId).map((c) => String(c[1]));

const jobFor = (propertyId: string) => prisma.backgroundJob.findUnique({ where: { dedupeKey: vh.videoHandoffPublishDedupeKey(propertyId) } });

beforeAll(async () => {
  savedSettings = (await prisma.settings.findUnique({ where: { id: "singleton" }, select: SETTINGS_KEYS })) as Record<string, unknown> | null;
  montajer = await makeAgent("1", "AGENT");
  reviewer = await makeAgent("2", "ADMIN", { clipReviewTelegram: true });
  owner = await makeAgent("3", "AGENT");
  stranger = await makeAgent("4", "AGENT");
  ownerNoTgId = (await makeAgent("5", "AGENT", {}, false)).id;
  await prisma.settings.update({
    where: { id: "singleton" },
    data: {
      clipReviewEnabled: false,
      clipOwnerApproveEnabled: true,
      clipOwnerAutoPublishHours: 3,
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
});

afterAll(async () => {
  await vh.settleBackgroundHandoffDispatches();
  if (savedSettings) await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  vh.setMontajerSendPauseMsForTests();
  await prisma.backgroundJob.deleteMany({ where: { dedupeKey: { in: propertyIds.map(vh.videoHandoffPublishDedupeKey) } } });
  await prisma.telegramModerationMessage.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.telegramDialogState.deleteMany({ where: { chatId: { in: [reviewer.chatId, owner.chatId, stranger.chatId, montajer.chatId] } } });
  await waitForSettled(() => prisma.auditLog.count({ where: { entityId: { in: propertyIds } } }));
  await prisma.auditLog.deleteMany({ where: { entityId: { in: propertyIds } } });
  await prisma.videoRemakeRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.propertyVideo.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  for (const f of files) await fs.rm(f, { force: true }).catch(() => {});
  for (const d of rawDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: { in: agentIds } } }).catch(() => {});
});

describe("срок автопубликации (юнит)", () => {
  it("днём — ровно через N часов", () => {
    expect(cr.clipOwnerAutoPublishAt(dushanbe("2026-11-11 10:00"), 3).toISOString()).toBe(dushanbe("2026-11-11 13:00").toISOString());
  });
  it("срок попал на 00:00–07:00 по Душанбе — переносится на 07:00 того же утра", () => {
    expect(cr.clipOwnerAutoPublishAt(dushanbe("2026-11-11 22:30"), 3).toISOString()).toBe(dushanbe("2026-11-12 07:00").toISOString());
    expect(cr.clipOwnerAutoPublishAt(dushanbe("2026-11-11 21:00"), 3).toISOString()).toBe(dushanbe("2026-11-12 07:00").toISOString());
    // 20:59 + 3 ч = 23:59 — ещё не ночь, без переноса.
    expect(cr.clipOwnerAutoPublishAt(dushanbe("2026-11-11 20:59"), 3).toISOString()).toBe(dushanbe("2026-11-11 23:59").toISOString());
  });
  it("ночь — с 00:00 до 07:00 по Душанбе, не по UTC", () => {
    expect(cr.isClipOwnerNight(dushanbe("2026-11-11 00:00"))).toBe(true);
    expect(cr.isClipOwnerNight(dushanbe("2026-11-11 06:59"))).toBe(true);
    expect(cr.isClipOwnerNight(dushanbe("2026-11-11 07:00"))).toBe(false);
    expect(cr.isClipOwnerNight(dushanbe("2026-11-11 23:59"))).toBe(false);
  });
});

describe("ролик идёт хозяину объекта", () => {
  it("хозяину — видео с «Подтвердить» и сроком автопубликации; руководству — своя копия", async () => {
    const p = await pendingClip("рассылка", owner.id, owner.chatId);
    const toOwner = tg.sendVideoFromDisk.mock.calls.find((c) => String(c[0]) === owner.chatId);
    expect(toOwner).toBeTruthy();
    expect(String(toOwner![2])).toContain(`Готов ролик по вашему объекту №${p.shortId}`);
    expect(String(toOwner![2])).toMatch(/Не ответите до \d{4}-\d{2}-\d{2} \d{2}:\d{2} — опубликуется сам/);
    expect(String(toOwner![2])).toContain("ночью с 00:00 до 07:00 не публикуем");
    expect(JSON.stringify(toOwner![4])).toContain("Подтвердить");
    expect(JSON.stringify(toOwner![4])).toContain(`cr:a:${p.shortId}`);
    expect(tg.sendVideoFromDisk.mock.calls.some((c) => String(c[0]) === reviewer.chatId)).toBe(true);
    // Посторонний агент ничего не получил.
    expect(tg.sendVideoFromDisk.mock.calls.some((c) => String(c[0]) === stranger.chatId)).toBe(false);
  });

  it("«Подтвердить» хозяином — ролик сразу в публикации; повторное нажатие не публикует второй раз", async () => {
    const p = await pendingClip("подтвердить", owner.id, owner.chatId);
    await tap(owner.chatId, `cr:a:${p.shortId}`);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("APPROVED");
    expect(after.clipReviewDecidedById).toBe(owner.id);
    const job = await jobFor(p.id);
    expect(job).not.toBeNull();

    // Двойное нажатие (вторым — уже другой callback id) и нажатие руководства после.
    await tap(owner.chatId, `cr:a:${p.shortId}`);
    await tap(reviewer.chatId, `cr:a:${p.shortId}`);
    expect(textsTo(owner.chatId).some((t) => t.startsWith("Уже решено: одобрил"))).toBe(true);
    expect(textsTo(reviewer.chatId).some((t) => t.startsWith("Уже решено: одобрил"))).toBe(true);
    const jobAgain = await jobFor(p.id);
    expect(jobAgain?.id).toBe(job!.id);
    const audits = await waitFor(async () => {
      const rows = await prisma.auditLog.findMany({ where: { entityId: p.id, action: "PROPERTY_CLIP_APPROVED" } });
      return rows.length ? rows : null;
    });
    await waitForSettled(() => prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_CLIP_APPROVED" } }));
    expect(await prisma.auditLog.count({ where: { entityId: p.id, action: "PROPERTY_CLIP_APPROVED" } })).toBe(1);
    expect(audits[0].meta).toMatchObject({ decidedAs: "owner", source: "telegram" });
    expect(typeof (audits[0].meta as { waitedMinutes: unknown }).waitedMinutes).toBe("number");
  });

  it("«Вернуть монтажёру» хозяином — причина, ролик уходит на доработку", async () => {
    const p = await pendingClip("вернуть", owner.id, owner.chatId);
    const idx = VIDEO_REMAKE_REASONS.findIndex((code) => !VIDEO_REMAKE_REASONS_REQUIRING_COMMENT.includes(code));
    expect(idx).toBeGreaterThanOrEqual(0);
    await tap(owner.chatId, `cr:r:${p.shortId}`);
    expect(textsTo(owner.chatId).some((t) => t.includes(`Почему возвращаем ролик №${p.shortId}`))).toBe(true);
    await tap(owner.chatId, `cr:rr:${p.shortId}:${idx}`);
    await tap(owner.chatId, `cr:rx:${p.shortId}`);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("REJECTED");
    expect(after.clipReviewDecidedById).toBe(owner.id);
    expect(await jobFor(p.id)).toBeNull();
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_CLIP_REJECTED" } }));
    expect(audit.meta).toMatchObject({ decidedAs: "owner" });
    // Автопубликация вернутый ролик не тронет.
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: dushanbe("2026-11-11 09:00") } });
    await cr.runClipOwnerAutoPublishTick(dushanbe("2026-11-11 12:00"));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("REJECTED");
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE" } });
  });

  it("чужой агент не может решить по ролику не своего объекта", async () => {
    const p = await pendingClip("чужой", owner.id, owner.chatId);
    await tap(stranger.chatId, `cr:a:${p.shortId}`);
    expect(textsTo(stranger.chatId).some((t) => t.startsWith("Нет права решать"))).toBe(true);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");
    // Выключили подтверждение хозяином и у ролика нет срока автопубликации —
    // кнопки хозяина больше не решают (со сроком решают: таймер ведь идёт).
    await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: false } });
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: null } });
    try {
      await tap(owner.chatId, `cr:a:${p.shortId}`);
      expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: true } });
    }
  });
});

describe("решение хозяина в карточке CRM (14.11.2026)", () => {
  it("хозяин видит «Одобрить» и вправе решить; чужой — нет; модератор — всегда", async () => {
    const p = await pendingClip("карточка", owner.id, owner.chatId);
    const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    const card = await vh.videoHandoffCardForProperty(row);
    expect(card?.clipReview.ownerAgentId).toBe(owner.id);
    expect(await cr.canDecideClipInCrm(owner.id, false, p.id)).toBe(true);
    expect(await cr.canDecideClipInCrm(stranger.id, false, p.id)).toBe(false);
    expect(await cr.canDecideClipInCrm(stranger.id, true, p.id)).toBe(true);
    // Хозяин без Telegram тоже решает из карточки: ролик ему в чат не уходит, но кнопка в CRM есть.
    const p2 = await pendingClip("карточка-без-тг", ownerNoTgId, null);
    expect(await cr.canDecideClipInCrm(ownerNoTgId, false, p2.id)).toBe(true);
    // Решено — кнопка гаснет (ownerAgentId только у ждущего ролика).
    const approved = await cr.approveClip(p.id, owner.id, "crm");
    expect(approved.ok).toBe(true);
    const after = await vh.videoHandoffCardForProperty(await prisma.property.findUniqueOrThrow({ where: { id: p.id } }));
    expect(after?.clipReview.ownerAgentId).toBeNull();
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_CLIP_APPROVED" } }));
    expect(audit.meta).toMatchObject({ decidedAs: "owner", source: "crm" });
  });

  it("рубильник выключен и срока нет — хозяин в CRM не решает, кнопки не видит", async () => {
    const p = await pendingClip("карточка-выкл", owner.id, owner.chatId);
    await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: false } });
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: null } });
    try {
      expect(await cr.canDecideClipInCrm(owner.id, false, p.id)).toBe(false);
      const card = await vh.videoHandoffCardForProperty(await prisma.property.findUniqueOrThrow({ where: { id: p.id } }));
      expect(card?.clipReview.ownerAgentId).toBeNull();
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: true } });
    }
  });
});

describe("автопубликация без ответа", () => {
  it("через 3 ч — ролик публикуется сам, журнал «автоматически», повторный тик ничего не делает", async () => {
    const p = await pendingClip("авто", owner.id, owner.chatId);
    const now = dushanbe("2026-11-11 12:00");
    // Срок поставлен приёмом: ровно 3 ч от прихода ролика.
    const received = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(received.clipOwnerDueAt?.toISOString()).toBe(cr.clipOwnerAutoPublishAt(received.clipReviewRequestedAt!, 3).toISOString());
    // Ещё рано: до срока 10 минут.
    await prisma.property.update({
      where: { id: p.id },
      data: { clipReviewRequestedAt: new Date(now.getTime() - 170 * 60_000), clipOwnerDueAt: new Date(now.getTime() + 10 * 60_000) },
    });
    await cr.runClipOwnerAutoPublishTick(now);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");

    await prisma.property.update({
      where: { id: p.id },
      data: { clipReviewRequestedAt: new Date(now.getTime() - 181 * 60_000), clipOwnerDueAt: new Date(now.getTime() - 60_000) },
    });
    const first = await cr.runClipOwnerAutoPublishTick(now);
    expect(first.published).toBeGreaterThanOrEqual(1);
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("APPROVED");
    expect(after.clipReviewDecidedById).toBeNull();
    const job = await jobFor(p.id);
    expect(job).not.toBeNull();
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { entityId: p.id, action: "PROPERTY_CLIP_AUTO_APPROVED" } }));
    expect(audit.meta).toMatchObject({ decidedAs: "auto", source: "auto" });
    expect((audit.meta as { waitedMinutes: number }).waitedMinutes).toBeGreaterThanOrEqual(180);

    // Кнопки у хозяина и руководства погашены строкой «автоматически».
    await waitFor(async () => {
      const live = await prisma.telegramModerationMessage.count({ where: { propertyId: p.id, resolvedAt: null } });
      return live === 0 ? true : null;
    });

    // Повторный тик и запоздалое нажатие — без второй публикации.
    await cr.runClipOwnerAutoPublishTick(now);
    await tap(owner.chatId, `cr:a:${p.shortId}`);
    expect(textsTo(owner.chatId).some((t) => t.includes("ушёл в публикацию автоматически"))).toBe(true);
    expect((await jobFor(p.id))?.id).toBe(job!.id);
    await waitForSettled(() => prisma.auditLog.count({ where: { entityId: p.id, action: { in: ["PROPERTY_CLIP_AUTO_APPROVED", "PROPERTY_CLIP_APPROVED"] } } }));
    expect(
      await prisma.auditLog.count({ where: { entityId: p.id, action: { in: ["PROPERTY_CLIP_AUTO_APPROVED", "PROPERTY_CLIP_APPROVED"] } } })
    ).toBe(1);
  });

  it("ночью не публикует: срок в 01:30 → ждёт до 07:00", async () => {
    const p = await pendingClip("ночь", owner.id, owner.chatId);
    // Ролик пришёл в 22:30 по Душанбе — срок 01:30, ночь.
    const requestedAt = dushanbe("2026-11-11 22:30");
    await prisma.property.update({ where: { id: p.id }, data: { clipReviewRequestedAt: requestedAt, clipOwnerDueAt: cr.clipOwnerAutoPublishAt(requestedAt, 3) } });
    await cr.runClipOwnerAutoPublishTick(dushanbe("2026-11-12 02:00"));
    await cr.runClipOwnerAutoPublishTick(dushanbe("2026-11-12 06:55"));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");
    await cr.runClipOwnerAutoPublishTick(dushanbe("2026-11-12 07:00"));
    const after = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(after.clipReviewStatus).toBe("APPROVED");
    expect(after.clipReviewDecidedById).toBeNull();
  });

  it("у хозяина нет Telegram — ему ничего не уходит, ролик закрывает тот же таймер", async () => {
    const p = await pendingClip("без телеграма", ownerNoTgId, null);
    const recipients = new Set(tg.sendVideoFromDisk.mock.calls.map((c) => String(c[0])));
    expect([...recipients]).toEqual([reviewer.chatId]);
    const now = dushanbe("2026-11-11 15:00");
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipOwnerDueAt).not.toBeNull();
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: new Date(now.getTime() - 60_000) } });
    await cr.runClipOwnerAutoPublishTick(now);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("APPROVED");
  });

  it("рубильник выключили, пока ролик ждал: решают модераторы, а если и их проверка выключена — срок в силе", async () => {
    const p = await pendingClip("выключено", owner.id, owner.chatId);
    const now = dushanbe("2026-11-11 12:00");
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: new Date(now.getTime() - 60_000) } });
    await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: false, clipReviewEnabled: true } });
    try {
      await cr.runClipOwnerAutoPublishTick(now);
      expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");
      // Проверка модератором тоже выключена — решать некому, ролик не виснет.
      await prisma.settings.update({ where: { id: "singleton" }, data: { clipReviewEnabled: false } });
      await cr.runClipOwnerAutoPublishTick(now);
      expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("APPROVED");
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: true, clipReviewEnabled: false } });
    }
  });

  it("ролик ждал модератора ДО включения рубильника — хозяину не уходит, таймер его не публикует", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: false, clipReviewEnabled: true } });
    let p: Awaited<ReturnType<typeof pendingClip>>;
    try {
      p = await pendingClip("до включения", owner.id, null);
    } finally {
      await prisma.settings.update({ where: { id: "singleton" }, data: { clipOwnerApproveEnabled: true } });
    }
    const row = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(row.clipOwnerDueAt).toBeNull();
    expect(tg.sendVideoFromDisk.mock.calls.some((c) => String(c[0]) === owner.chatId)).toBe(false);
    await prisma.property.update({ where: { id: p.id }, data: { clipReviewRequestedAt: new Date(Date.now() - 10 * 3_600_000) } });
    await cr.runClipOwnerAutoPublishTick(dushanbe("2026-11-11 12:00"));
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");
    // Ревью 12.11.2026: срока у такого ролика нет — напоминание модераторам о нём не молчит.
    await prisma.property.update({ where: { id: p.id }, data: { clipReviewRequestedAt: dushanbe("2026-11-11 01:00") } });
    const remind = vi.fn(async () => {});
    await cr.runClipReviewStaleTick(remind, dushanbe("2026-11-11 12:00"));
    expect(remind.mock.calls.some((c) => c[0] === p.id)).toBe(true);
    await prisma.settings.update({ where: { id: "singleton" }, data: { clipReviewEnabled: false } });
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE", clipReviewStatus: "NONE" } });
  });

  it("автопубликация перепроверяет срок в самой записи: срок отодвинули после выборки тика — не одобряет", async () => {
    const p = await pendingClip("срок отодвинут", owner.id, null);
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: new Date(Date.now() + 15 * 60_000) } });
    const result = await cr.approveClip(p.id, null, "auto", new Date());
    expect(result.ok).toBe(false);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE", clipReviewStatus: "NONE" } });
  });

  it("хозяин пишет причину возврата — таймер не перебивает его, возврат проходит", async () => {
    const p = await pendingClip("пишет причину", owner.id, owner.chatId);
    const idx = VIDEO_REMAKE_REASONS.findIndex((code) => !VIDEO_REMAKE_REASONS_REQUIRING_COMMENT.includes(code));
    // Срок вот-вот наступит, хозяин жмёт «Вернуть» — срок отодвинут на 15 минут.
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: new Date(Date.now() + 60_000) } });
    await tap(owner.chatId, `cr:r:${p.shortId}`);
    const held = await prisma.property.findUniqueOrThrow({ where: { id: p.id } });
    expect(held.clipOwnerDueAt!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    await tap(owner.chatId, `cr:rr:${p.shortId}:${idx}`);
    await prisma.property.update({ where: { id: p.id }, data: { clipOwnerDueAt: new Date(Date.now() - 60_000) } });
    // Тик с реальным «сейчас», но ночь его не должна выключить — берём день тем же часом минут.
    const dayNow = new Date(Date.now());
    const now = cr.isClipOwnerNight(dayNow) ? new Date(dayNow.getTime() + 8 * 3_600_000) : dayNow;
    if (now.getTime() !== dayNow.getTime()) {
      // Сдвиг на дневное время — продлить диалог, чтобы он был жив и в этот момент.
      await prisma.telegramDialogState.update({ where: { chatId: owner.chatId }, data: { expiresAt: new Date(now.getTime() + 15 * 60_000) } });
    }
    await cr.runClipOwnerAutoPublishTick(now);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("PENDING");
    expect(await bot.handleClipReviewText(owner.chatId, "Звук тихий, переделайте")).toBe(true);
    expect((await prisma.property.findUniqueOrThrow({ where: { id: p.id } })).clipReviewStatus).toBe("REJECTED");
    await prisma.property.update({ where: { id: p.id }, data: { videoHandoffStatus: "NONE" } });
  });
});
