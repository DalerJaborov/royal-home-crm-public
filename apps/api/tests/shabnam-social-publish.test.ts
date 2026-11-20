import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { SOCIAL_VIDEO_LIMITS, SOCIAL_VIDEO_CHANNEL_LABELS, type SocialVideoChannel } from "@royal-home/shared";
import { waitFor } from "./helpers/waitFor.js";

/**
 * ШАБНАМ: ПОСТ БЕЗ ОБЪЕКТА И РАСПОЗНАВАНИЕ ОБЪЕКТА РОЛИКА (21.11.2026). База и ffmpeg настоящие;
 * Telegram, площадки соцсетей, ИИ подписи, расшифровка звука и очередь публикации подменены —
 * ни одного настоящего поста и ни одного платного вызова.
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  sendMessageWithButtons: vi.fn(async () => ({ message_id: 2 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  editMessageText: vi.fn(async () => undefined),
  sendChatAction: vi.fn(async () => undefined),
  file: null as Buffer | null,
}));
vi.mock("../src/telegram/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/api.js")>()),
  sendMessage: tg.sendMessage, sendMessageWithButtons: tg.sendMessageWithButtons, answerCallbackQuery: tg.answerCallbackQuery,
  editMessageText: tg.editMessageText, sendChatAction: tg.sendChatAction, isTelegramEnabled: () => true,
  resolveTelegramFileMaterialization: vi.fn(async () => (tg.file ? { kind: "buffer", buffer: tg.file } : null)),
}));
const photoBuffers = vi.hoisted(() => ({ byFileId: new Map<string, Buffer>() }));
vi.mock("../src/telegram/assistantMedia.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/assistantMedia.js")>()),
  downloadAssistantMedia: vi.fn(async (fileId: string) => {
    const b = photoBuffers.byFileId.get(fileId);
    if (!b) throw new Error("media_download_failed");
    return b;
  }),
}));
const speech = vi.hoisted(() => ({ transcribe: vi.fn(async (): Promise<{ transcript: string } | { skipped: "no_audio" }> => ({ skipped: "no_audio" })) }));
vi.mock("../src/telegram/staffClipSpeech.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telegram/staffClipSpeech.js")>()),
  transcribeClipSpeech: speech.transcribe,
}));
const READY: SocialVideoChannel[] = ["INSTAGRAM", "FACEBOOK", "TELEGRAM"];
vi.mock("../src/lib/socialVideoChannels.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialVideoChannels.js")>()),
  loadChannelInfos: vi.fn(async () => (["INSTAGRAM", "FACEBOOK", "YOUTUBE", "TIKTOK", "TELEGRAM", "THREADS"] as SocialVideoChannel[]).map((channel) => ({
    channel, label: SOCIAL_VIDEO_CHANNEL_LABELS[channel], connected: READY.includes(channel), ready: READY.includes(channel),
    problem: READY.includes(channel) ? null : "не подключён", limits: SOCIAL_VIDEO_LIMITS[channel], accounts: [],
  }))),
  loadChannelLive: vi.fn(async () => []),
}));
const ai = vi.hoisted(() => ({ captions: vi.fn(async () => ["Новый ролик Royal Home\n\nПодпись от ИИ"]) }));
vi.mock("../src/lib/socialVideoAi.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socialVideoAi.js")>()),
  generateSocialVideoCaptions: ai.captions,
}));
const jobs = vi.hoisted(() => ({ enqueue: vi.fn(async () => ({ enqueued: true as const })) }));
vi.mock("../src/jobs/enqueue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/enqueue.js")>()),
  enqueueBackgroundJob: jobs.enqueue,
}));
vi.mock("../src/push.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/push.js")>()),
  sendPushToAgent: vi.fn(async () => 0), sendPushToAgents: vi.fn(async () => 0),
}));

const ffmpegReady = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const { prisma } = await import("../src/db.js");
const { handleStaffClipMessage, handleStaffClipCallback, handleStaffClipText } = await import("../src/telegram/staffClip.js");
const social = await import("../src/telegram/staffSocialPost.js");
const { uploadsDir } = await import("../src/upload.js");

const runId = Date.now();
const tail = runId.toString().slice(-6);
const tmp = path.join(os.tmpdir(), `shabnam-social-${runId}`);
const clipPath = path.join(tmp, "vertical.mp4");
let districtId: string, marketingId: string, agentId: string;
const marketingChat = `-7${tail}1`;
const agentChat = `-7${tail}2`;
const propertyIds: string[] = [];
let settingsBefore: { shabnamSocialPublishEnabled: boolean; staffClipIntakeEnabled: boolean } | null = null;

const msg = (chat: string, extra: Record<string, unknown>) => ({ message_id: Math.floor(Math.random() * 1e6), chat: { id: Number(chat), type: "private" }, from: { id: Number(chat) }, ...extra }) as never;
const press = (chat: string, data: string) => (data.startsWith("clip:") ? handleStaffClipCallback : social.handleStaffSocialCallback)(
  { id: randomUUID(), data, from: { id: Number(chat) }, message: { message_id: 2, chat: { id: Number(chat), type: "private" } } } as never);
const marketing = () => ({ id: marketingId, fullName: "Маркетолог Шабнам" });
const plainAgent = () => ({ id: agentId, fullName: "Агент Шабнам" });
const sentTexts = () => [...tg.sendMessage.mock.calls, ...tg.sendMessageWithButtons.mock.calls].map((c) => String((c as unknown[])[1]));
const lastButtons = () => {
  const call = tg.sendMessageWithButtons.mock.calls.at(-1) as unknown[] | undefined;
  return ((call?.[2] ?? []) as Array<Array<{ text: string; callback_data: string }>>).flat();
};
async function setSwitch(on: boolean) {
  await prisma.settings.update({ where: { id: "singleton" }, data: { shabnamSocialPublishEnabled: on } });
}
async function seedProperty(data: Record<string, unknown> = {}) {
  const p = await prisma.property.create({ data: { title: `Шабнам пост-${runId}`, type: "APARTMENT", areaSqm: 64, price: 61000, currency: "TJS", districtId,
    address: `Тест ${propertyIds.length + 1}`, condition: "GOOD", status: "AVAILABLE", assignedAgentId: agentId, ...data } });
  propertyIds.push(p.id);
  return p;
}

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true });
  if (ffmpegReady) {
    const r = spawnSync(process.env.FFMPEG_BIN || "ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=25:duration=4",
      "-f", "lavfi", "-i", `sine=frequency=${300 + (runId % 500)}:duration=4`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clipPath], { stdio: "ignore" });
    if (r.status !== 0) throw new Error("ffmpeg: тестовый ролик не собрался");
  }
  districtId = (await prisma.district.create({ data: { name: `Шабнампост${tail}` } })).id;
  marketingId = (await prisma.agent.create({ data: { fullName: "Маркетолог Шабнам", phone: `+99293${tail}1`, role: "MARKETING", passwordHash: "x", telegramChatId: marketingChat } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент Шабнам", phone: `+99293${tail}2`, role: "AGENT", passwordHash: "x", telegramChatId: agentChat } })).id;
  settingsBefore = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { shabnamSocialPublishEnabled: true, staffClipIntakeEnabled: true } });
  await prisma.settings.update({ where: { id: "singleton" }, data: { shabnamSocialPublishEnabled: true, staffClipIntakeEnabled: true } });
  social.setStaffSocialAlbumQuietForTests(30);
});
beforeEach(() => { vi.clearAllMocks(); tg.file = null; });
afterAll(async () => {
  social.setStaffSocialAlbumQuietForTests(null);
  if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore }).catch(() => {});
  const posts = await prisma.socialVideoPost.findMany({ where: { createdById: { in: [marketingId, agentId] } }, select: { videoPath: true, imagePaths: true } });
  for (const p of posts) for (const f of [p.videoPath, ...p.imagePaths]) {
    if (f?.startsWith("/uploads/")) await fs.rm(path.join(uploadsDir, f.slice("/uploads/".length)), { force: true });
  }
  await prisma.staffSocialPost.deleteMany({ where: { agentId: { in: [marketingId, agentId] } } });
  await prisma.socialVideoPost.deleteMany({ where: { createdById: { in: [marketingId, agentId] } } });
  await prisma.staffClipIntake.deleteMany({ where: { agentId: { in: [marketingId, agentId] } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.auditLog.deleteMany({ where: { agentId: { in: [marketingId, agentId] } } });
  await prisma.agentAiActionCounter.deleteMany({ where: { agentId: { in: [marketingId, agentId] } } });
  await prisma.agent.deleteMany({ where: { id: { in: [marketingId, agentId] } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await fs.rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!ffmpegReady)("ролик без объекта", () => {
  it("«опубликуй без объекта в инстаграм» — превью с подписью и кнопками; в сети ничего не ушло", async () => {
    tg.file = await fs.readFile(clipPath);
    const unique = `v1-${runId}`;
    expect(await handleStaffClipMessage(msg(marketingChat, { caption: "опубликуй без объекта в инстаграм, новый ЖК", document: { file_id: "fv1", file_unique_id: unique, file_name: "promo.mp4", mime_type: "video/mp4" } }), marketing())).toBe(true);
    const post = await prisma.staffSocialPost.findFirstOrThrow({ where: { agentId: marketingId, kind: "VIDEO" }, orderBy: { createdAt: "desc" } });
    expect(post.status).toBe("PREVIEW");
    const draft = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } });
    expect(draft.status).toBe("DRAFT");
    expect(draft.channels).toEqual(["INSTAGRAM"]);
    expect(draft.caption).toContain("Подпись от ИИ");
    expect(ai.captions).toHaveBeenCalledWith(expect.objectContaining({ brief: "новый ЖК", language: "RU", channels: ["INSTAGRAM"] }));
    const preview = sentTexts().find((t) => t.startsWith("📣"))!;
    expect(preview).toContain("Куда: Instagram");
    expect(preview).toContain("Когда: сразу после кнопки «Опубликовать»");
    expect(lastButtons().map((b) => b.text)).toEqual(["✅ Опубликовать", "✏️ Изменить подпись", "🔄 Другая подпись", "📡 Выбрать сети", "Отмена"]);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect((await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: unique } })).status).toBe("FREE");
  });

  it("чужой чат не может нажать «Опубликовать»; двойное нажатие публикует один раз; в журнале — кто и куда", async () => {
    const post = await prisma.staffSocialPost.findFirstOrThrow({ where: { agentId: marketingId, kind: "VIDEO", status: "PREVIEW" }, orderBy: { createdAt: "desc" } });
    await press(agentChat, `spub:p:${post.id}`);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).status).toBe("DRAFT");
    await Promise.all([press(marketingChat, `spub:p:${post.id}`), press(marketingChat, `spub:p:${post.id}`)]);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    // Второе нажатие погашено своим захватом, а не отказом площадки: сотрудник не видит «не началась».
    expect(sentTexts().filter((t) => t.includes("не началась"))).toEqual([]);
    expect(sentTexts().filter((t) => t.startsWith("Отправила в публикацию"))).toHaveLength(1);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).status).toBe("PUBLISHING");
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "SOCIAL_VIDEO_PUBLISH", entityId: post.socialVideoPostId!, agentId: marketingId } }));
    expect(audit?.meta).toMatchObject({ source: "telegram-shabnam", channels: ["INSTAGRAM"] });
    // Повтор того же апдейта после публикации — ничего нового.
    await press(marketingChat, `spub:p:${post.id}`);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("сети, подпись словами, отмена: черновик удалён, в сети ничего", async () => {
    tg.file = await fs.readFile(clipPath);
    await handleStaffClipMessage(msg(marketingChat, { caption: "без объекта", document: { file_id: "fv2", file_unique_id: `v2-${runId}`, file_name: "promo2.mp4", mime_type: "video/mp4" } }), marketing());
    const post = await prisma.staffSocialPost.findFirstOrThrow({ where: { agentId: marketingId, status: "PREVIEW" }, orderBy: { createdAt: "desc" } });
    // Без названных сетей — все подключённые.
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).channels).toEqual(READY);
    await press(marketingChat, `spub:n:${post.id}`);
    await press(marketingChat, `spub:t:${post.id}:1`); // Facebook выкл
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).channels).toEqual(["INSTAGRAM", "TELEGRAM"]);
    await press(marketingChat, `spub:e:${post.id}`);
    expect(await social.handleStaffSocialText(msg(marketingChat, { text: "Мой текст поста" }), marketing())).toBe(true);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).caption).toBe("Мой текст поста");
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PREVIEW");
    await press(marketingChat, `spub:x:${post.id}`);
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("CANCELLED");
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).deletedAt).not.toBeNull();
    await press(marketingChat, `spub:p:${post.id}`);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("без права маркетинга — «без объекта» не публикует, кнопки нет, нажатие — вежливый отказ", async () => {
    tg.file = await fs.readFile(clipPath);
    await handleStaffClipMessage(msg(agentChat, { caption: "опубликуй без объекта", document: { file_id: "fv3", file_unique_id: `v3-${runId}`, file_name: "IMG_0001.MOV", mime_type: "video/mp4" } }), plainAgent());
    expect(await prisma.staffSocialPost.count({ where: { agentId } })).toBe(0);
    expect(lastButtons().some((b) => b.callback_data.startsWith("clip:f:"))).toBe(false);
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `v3-${runId}` } });
    await press(agentChat, `clip:f:${intake.id}`);
    expect(String((tg.sendMessage.mock.calls.at(-1) as unknown[] | undefined)?.[1])).toContain("доступом к маркетингу");
    expect(await prisma.staffSocialPost.count({ where: { agentId } })).toBe(0);
    expect((await prisma.staffClipIntake.findUniqueOrThrow({ where: { id: intake.id } })).status).toBe("ASKING");
  });

  it("рубильник выключен — пост без объекта не готовится, фото с «опубликуй» идут своим путём", async () => {
    await setSwitch(false);
    try {
      tg.file = await fs.readFile(clipPath);
      const before = await prisma.staffSocialPost.count({ where: { agentId: marketingId } });
      await handleStaffClipMessage(msg(marketingChat, { caption: "без объекта", document: { file_id: "fv4", file_unique_id: `v4-${runId}`, file_name: "x.mp4", mime_type: "video/mp4" } }), marketing());
      expect(await prisma.staffSocialPost.count({ where: { agentId: marketingId } })).toBe(before);
      expect(lastButtons().some((b) => b.callback_data.startsWith("clip:f:"))).toBe(false);
      photoBuffers.byFileId.set("ph-off", await sharp({ create: { width: 600, height: 800, channels: 3, background: "#88a" } }).jpeg().toBuffer());
      expect(await social.handleStaffSocialPhoto(msg(marketingChat, { caption: "опубликуй", photo: [{ file_id: "ph-off" }] }), marketing())).toBe(false);
    } finally {
      await setSwitch(true);
    }
  });
});

describe("альбом фото — один пост", () => {
  it("три фото одним альбомом с «опубликуй» → один фото-пост на три фото; повтор доставки — не второй", async () => {
    for (const id of ["a1", "a2", "a3"]) {
      photoBuffers.byFileId.set(`${id}-${runId}`, await sharp({ create: { width: 900, height: 1200, channels: 3, background: id === "a2" ? "#a55" : "#5a5" } }).jpeg().toBuffer());
    }
    const group = `g-${runId}`;
    const parts = [
      msg(marketingChat, { message_id: 101, media_group_id: group, caption: "Опубликуй в инстаграм и фейсбук: двор нового дома", photo: [{ file_id: `a1-${runId}` }] }),
      msg(marketingChat, { message_id: 102, media_group_id: group, photo: [{ file_id: `a2-${runId}` }] }),
      msg(marketingChat, { message_id: 103, media_group_id: group, photo: [{ file_id: `a3-${runId}` }] }),
    ];
    for (const m of parts) expect(await social.handleStaffSocialPhoto(m, marketing())).toBe(true);
    await social.flushStaffSocialAlbumsForTests();
    const posts = await prisma.staffSocialPost.findMany({ where: { agentId: marketingId, kind: "PHOTO" } });
    expect(posts).toHaveLength(1);
    const draft = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: posts[0]!.socialVideoPostId! } });
    expect(draft.mediaKind).toBe("PHOTO");
    expect(draft.imagePaths).toHaveLength(3);
    expect(draft.channels).toEqual(["INSTAGRAM", "FACEBOOK"]);
    for (const m of parts) await social.handleStaffSocialPhoto(m, marketing());
    await social.flushStaffSocialAlbumsForTests();
    expect(await prisma.staffSocialPost.count({ where: { agentId: marketingId, kind: "PHOTO" } })).toBe(1);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
  it("фото без слов о публикации — не наше", async () => {
    expect(await social.handleStaffSocialPhoto(msg(marketingChat, { photo: [{ file_id: "nothing" }] }), marketing())).toBe(false);
  });
});

describe("к какому объекту ролик: распознавание", () => {
  it("номер в имени файла — кнопка «Да, это …», звук не расшифровываем, сами не прикрепляем", async () => {
    const p = await seedProperty();
    await handleStaffClipMessage(msg(agentChat, { document: { file_id: "r1", file_unique_id: `r1-${runId}`, file_name: `${p.shortId}.mp4`, mime_type: "video/mp4" } }), plainAgent());
    // Явный номер в имени файла — сразу «Готов к выпуску / Нужен монтаж» по выбранному объекту (кнопкой).
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r1-${runId}` } });
    expect(intake.status).toBe("CHOSEN");
    expect(speech.transcribe).not.toHaveBeenCalled();
    expect(await prisma.property.findUniqueOrThrow({ where: { id: p.id }, select: { videoHandoffFinalPath: true } })).toEqual({ videoHandoffFinalPath: null });
  });

  it("по подписи: район и цена — кандидат с причиной; прикрепление только кнопкой", async () => {
    const price = 900_000 + Number(tail.slice(-4));
    const p = await seedProperty({ price, rooms: 3 });
    const name = (await prisma.district.findUniqueOrThrow({ where: { id: districtId } })).name;
    await handleStaffClipMessage(msg(agentChat, { caption: `${name}, 3 комнаты, цена ${price}`, document: { file_id: "r2", file_unique_id: `r2-${runId}`, file_name: "IMG_7777.MOV", mime_type: "video/mp4" } }), plainAgent());
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r2-${runId}` } });
    expect(intake.status).toBe("ASKING");
    expect(intake.propertyId).toBeNull();
    const text = sentTexts().at(-1)!;
    expect(text).toContain("по подписи совпали");
    expect(text).toContain(`район ${name}`);
    expect(lastButtons()[0]).toEqual({ text: `✅ Да, это ОБ-${String(p.shortId).padStart(6, "0")}`, callback_data: `clip:p:${intake.id}:${p.shortId}` });
    expect(speech.transcribe).not.toHaveBeenCalled();
  });

  it("по озвучке: расшифровка находит цену, сохраняется для подписи; «нет, это №…» словами", async () => {
    const price = 700_000 + Number(tail.slice(-4));
    const p = await seedProperty({ price });
    const other = await seedProperty();
    speech.transcribe.mockResolvedValueOnce({ transcript: `Продаётся квартира, цена ${price} сомони` });
    await handleStaffClipMessage(msg(agentChat, { document: { file_id: "r3", file_unique_id: `r3-${runId}`, file_name: "VID_20261121.mp4", mime_type: "video/mp4" } }), plainAgent());
    expect(speech.transcribe).toHaveBeenCalledTimes(1);
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r3-${runId}` } });
    expect(intake.transcript).toContain(String(price));
    expect(sentTexts().at(-1)).toContain("по озвучке совпали");
    expect(lastButtons()[0]?.callback_data).toBe(`clip:p:${intake.id}:${p.shortId}`);
    expect(await handleStaffClipText(msg(agentChat, { text: `нет, это №${other.shortId}` }), plainAgent())).toBe(true);
    const after = await prisma.staffClipIntake.findUniqueOrThrow({ where: { id: intake.id } });
    expect(after.status).toBe("CHOSEN");
    expect(after.propertyId).toBe(other.id);
  });

  it("ничего не узнала — маркетологу «Опубликовать без объекта», агенту — выбор объекта", async () => {
    await handleStaffClipMessage(msg(marketingChat, { document: { file_id: "r4", file_unique_id: `r4-${runId}`, file_name: "IMG_0002.MOV", mime_type: "video/mp4" } }), marketing());
    expect(sentTexts().at(-1)).toContain("объект не узнала");
    expect(lastButtons().some((b) => b.text === "📣 Опубликовать без объекта")).toBe(true);
    await handleStaffClipMessage(msg(agentChat, { document: { file_id: "r5", file_unique_id: `r5-${runId}`, file_name: "IMG_0003.MOV", mime_type: "video/mp4" } }), plainAgent());
    expect(lastButtons().some((b) => b.text === "📣 Опубликовать без объекта")).toBe(false);
  });
});
