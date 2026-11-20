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
 * ни одного настоящего поста и ни одного платного вызова. Сообщения превью получают растущие номера,
 * как в Telegram: так проверяется «публикуется только с последнего превью».
 */
const tg = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => ({ message_id: 1 })),
  mid: 100,
  sendMessageWithButtons: vi.fn(async (): Promise<{ message_id: number }> => ({ message_id: 0 })),
  answerCallbackQuery: vi.fn(async () => ({})),
  editMessageText: vi.fn(async () => undefined),
  sendChatAction: vi.fn(async () => undefined),
  file: null as Buffer | null,
}));
tg.sendMessageWithButtons.mockImplementation(async () => ({ message_id: ++tg.mid }));
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
const { sweepStaffSocialPosts } = await import("../src/lib/staffSocialPostSweep.js");
const { updateSocialVideo } = await import("../src/lib/socialVideoPosts.js");
const { SocialVideoAiError } = await import("../src/lib/socialVideoAi.js");
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

type Defer = (work: () => Promise<void>) => Promise<void>;
const msg = (chat: string, extra: Record<string, unknown>) => ({ message_id: Math.floor(Math.random() * 1e6), chat: { id: Number(chat), type: "private" }, from: { id: Number(chat) }, ...extra }) as never;
const query = (chat: string, data: string, messageId: number) => ({ id: randomUUID(), data, from: { id: Number(chat) }, message: { message_id: messageId, chat: { id: Number(chat), type: "private" } } }) as never;
const press = (chat: string, data: string, messageId = 2, defer?: Defer) => (data.startsWith("clip:")
  ? handleStaffClipCallback(query(chat, data, messageId), defer)
  : social.handleStaffSocialCallback(query(chat, data, messageId), defer));
/** Нажатие по ПОСЛЕДНЕМУ превью поста: его сообщение и номер. */
async function pressPost(chat: string, action: string, postId: string, opts: { arg?: number; defer?: Defer; messageId?: number } = {}) {
  const row = await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: postId } });
  const arg = opts.arg ?? (action === "p" ? row.previewVersion : undefined);
  return press(chat, `spub:${action}:${postId}${arg !== undefined ? `:${arg}` : ""}`, opts.messageId ?? row.previewMessageId ?? 0, opts.defer);
}
const answers = () => tg.answerCallbackQuery.mock.calls.map((c) => String((c as unknown[])[1] ?? ""));
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
/** Свежий пост без объекта из ролика маркетолога, в превью. */
async function freshVideoPost(tag: string, caption = "опубликуй без объекта") {
  tg.file = await fs.readFile(clipPath);
  await handleStaffClipMessage(msg(marketingChat, { caption, document: { file_id: `f-${tag}`, file_unique_id: `${tag}-${runId}`, file_name: "promo.mp4", mime_type: "video/mp4" } }), marketing());
  const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `${tag}-${runId}` } });
  return prisma.staffSocialPost.findUniqueOrThrow({ where: { staffClipIntakeId: intake.id } });
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
  it("«опубликуй без объекта в инстаграм» — превью с подписью и кнопками; в сети ничего не ушло; ИИ не видит имени сотрудника", async () => {
    const post = await freshVideoPost("v1", "опубликуй без объекта в инстаграм, новый ЖК");
    expect(post.status).toBe("PREVIEW");
    const draft = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } });
    expect(draft.status).toBe("DRAFT");
    expect(draft.channels).toEqual(["INSTAGRAM"]);
    expect(draft.caption).toContain("Подпись от ИИ");
    expect(draft.title).not.toContain("Маркетолог");
    const [request, opts] = ai.captions.mock.calls[0] as unknown as [Record<string, unknown>, { forbiddenWords: string[] }];
    expect(request).toMatchObject({ brief: "новый ЖК", language: "RU", channels: ["INSTAGRAM"] });
    expect(request.title).toBeUndefined();
    expect(opts.forbiddenWords).toContain("Шабнам");
    expect(opts.forbiddenWords).not.toContain("Маркетолог"); // слово учётки, не имя
    const preview = sentTexts().find((t) => t.startsWith("📣"))!;
    expect(preview).toContain("Куда: Instagram");
    expect(preview).toContain("Когда: сразу после кнопки «Опубликовать»");
    expect(preview).toContain(draft.caption);
    expect(lastButtons().map((b) => b.text)).toEqual(["✅ Опубликовать", "✏️ Изменить подпись", "🔄 Другая подпись", "📡 Выбрать сети", "Отмена"]);
    expect(lastButtons()[0]!.callback_data).toBe(`spub:p:${post.id}:${post.previewVersion}`);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect((await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `v1-${runId}` } })).status).toBe("FREE");
  });

  it("чужой чат не может нажать «Опубликовать»; двойное нажатие публикует один раз; в журнале — кто и куда", async () => {
    const post = await prisma.staffSocialPost.findFirstOrThrow({ where: { agentId: marketingId, kind: "VIDEO", status: "PREVIEW" }, orderBy: { createdAt: "desc" } });
    await press(agentChat, `spub:p:${post.id}:${post.previewVersion}`, post.previewMessageId!);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).status).toBe("DRAFT");
    await Promise.all([pressPost(marketingChat, "p", post.id), pressPost(marketingChat, "p", post.id)]);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    // Второе нажатие погашено своим захватом, а не отказом площадки: сотрудник не видит «не началась».
    expect(sentTexts().filter((t) => t.includes("не началась"))).toEqual([]);
    expect(sentTexts().filter((t) => t.startsWith("Отправила в публикацию"))).toHaveLength(1);
    expect(sentTexts().filter((t) => t.startsWith("Не получилось"))).toEqual([]);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).status).toBe("PUBLISHING");
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
    const audit = await waitFor(() => prisma.auditLog.findFirst({ where: { action: "SOCIAL_VIDEO_PUBLISH", entityId: post.socialVideoPostId!, agentId: marketingId } }));
    expect(audit?.meta).toMatchObject({ source: "telegram-shabnam", channels: ["INSTAGRAM"] });
    // Повтор того же апдейта после публикации и «Другая подпись» по старому превью — ничего нового.
    await pressPost(marketingChat, "p", post.id);
    await pressPost(marketingChat, "g", post.id);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(ai.captions).not.toHaveBeenCalled();
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PUBLISHED");
  });

  it("кнопка отвечает сразу, долгое — в очереди чата: до запуска очереди в сети ничего", async () => {
    const post = await freshVideoPost("v-lane");
    const queued: Array<() => Promise<void>> = [];
    const lane: Defer = async (work) => { queued.push(work); };
    await pressPost(marketingChat, "p", post.id, { defer: lane });
    expect(answers()).toContain("✅ Отправлено в публикацию");
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(queued).toHaveLength(1);
    await queued[0]!();
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("«Другая подпись» и «Опубликовать» наперегонки: пока пишется подпись — «подождите»; после — публикуется только новое превью", async () => {
    const post = await freshVideoPost("v-race");
    const queued: Array<() => Promise<void>> = [];
    const lane: Defer = async (work) => { queued.push(work); };
    ai.captions.mockResolvedValueOnce(["Совсем другая подпись"]);
    await pressPost(marketingChat, "g", post.id, { defer: lane });
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PREPARING");
    // Нажатие «Опубликовать» на показанном превью, пока ИИ пишет: не публикует ни старое, ни новое.
    await press(marketingChat, `spub:p:${post.id}:${post.previewVersion}`, post.previewMessageId!);
    expect(answers().at(-1)).toBe("Подождите, готовлю подпись");
    expect(jobs.enqueue).not.toHaveBeenCalled();
    await queued[0]!();
    const after = await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.status).toBe("PREVIEW");
    expect(after.previewVersion).toBe(post.previewVersion + 1);
    expect(after.previewMessageId).not.toBe(post.previewMessageId);
    // Старое превью (старый номер и старое сообщение) больше не публикует.
    await press(marketingChat, `spub:p:${post.id}:${post.previewVersion}`, post.previewMessageId!);
    expect(answers().at(-1)).toBe("Это старое превью, смотрите последнее ниже");
    expect(jobs.enqueue).not.toHaveBeenCalled();
    // Новое — публикует ровно ту подпись, что в нём показана.
    await pressPost(marketingChat, "p", post.id);
    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).caption).toBe("Совсем другая подпись");
  });

  it("подпись поменяли мимо превью (в «Роликах» CRM) — не публикуем, показываем заново", async () => {
    const post = await freshVideoPost("v-hash");
    await updateSocialVideo(post.socialVideoPostId!, { caption: "Чужая правка подписи" });
    await pressPost(marketingChat, "p", post.id);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    expect(answers().at(-1)).toBe("Подпись или сети изменились, показываю заново");
    const after = await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(after.status).toBe("PREVIEW");
    expect(after.previewVersion).toBe(post.previewVersion + 1);
    expect(sentTexts().filter((t) => t.startsWith("📣")).at(-1)).toContain("Чужая правка подписи");
  });

  it("сети, подпись словами (без длинного тире), отмена: черновик удалён, в сети ничего", async () => {
    const post = await freshVideoPost("v2", "без объекта");
    // Без названных сетей — все подключённые.
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).channels).toEqual(READY);
    await pressPost(marketingChat, "n", post.id);
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PICKING");
    // Пока выбираются сети, «Опубликовать» на этом же сообщении не срабатывает.
    await press(marketingChat, `spub:p:${post.id}:${post.previewVersion}`, post.previewMessageId!);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    await pressPost(marketingChat, "t", post.id, { arg: 1 }); // Facebook выкл
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).channels).toEqual(["INSTAGRAM", "TELEGRAM"]);
    await pressPost(marketingChat, "b", post.id);
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PREVIEW");
    await pressPost(marketingChat, "e", post.id);
    expect(await social.handleStaffSocialText(msg(marketingChat, { text: "Мой текст — без тире" }), marketing())).toBe(true);
    const caption = (await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).caption;
    expect(caption).not.toMatch(/[—–]/u);
    expect(caption).toContain("Мой текст");
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("PREVIEW");
    await pressPost(marketingChat, "x", post.id);
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("CANCELLED");
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).deletedAt).not.toBeNull();
    await pressPost(marketingChat, "p", post.id);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });

  it("«Изменить подпись» ждёт 10 минут, потом текст — обычный вопрос Шабнам", async () => {
    const post = await freshVideoPost("v-edit");
    await pressPost(marketingChat, "e", post.id);
    await prisma.$executeRaw`UPDATE "StaffSocialPost" SET "updatedAt" = now() - interval '11 minutes' WHERE id = ${post.id}`;
    expect(await social.handleStaffSocialText(msg(marketingChat, { text: "Сколько клиентов сегодня?" }), marketing())).toBe(false);
  });

  it("ИИ не ответил: запасная подпись из слов сотрудника, но без имён сотрудников", async () => {
    const colleague = await prisma.agent.create({ data: { fullName: "Зулфия Каримова", phone: `+99293${tail}7`, role: "AGENT", passwordHash: "x" } });
    try {
      ai.captions.mockRejectedValueOnce(new SocialVideoAiError("нет"));
      const post = await freshVideoPost("v-name", "без объекта, Зулфия покажет квартиру");
      expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: post.socialVideoPostId! } })).caption).toBe("Royal Home, агентство недвижимости в Душанбе");
      // Без имени — слова сотрудника остаются подписью.
      ai.captions.mockRejectedValueOnce(new SocialVideoAiError("нет"));
      const plain = await freshVideoPost("v-name2", "без объекта, светлая квартира у парка");
      expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: plain.socialVideoPostId! } })).caption).toBe("светлая квартира у парка");
    } finally {
      await prisma.agent.delete({ where: { id: colleague.id } });
    }
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
  it("мастер объекта разбирает фото раньше поста без объекта (порядок в assistantBot.ts)", async () => {
    const source = await fs.readFile(new URL("../src/telegram/assistantBot.ts", import.meta.url), "utf8");
    const draftAt = source.indexOf("await handleTelegramPropertyDraft(msg, agent, transcribeVoice)");
    const socialAt = source.indexOf("await handleStaffSocialPhoto(msg, agent)");
    expect(draftAt).toBeGreaterThan(0);
    expect(socialAt).toBeGreaterThan(draftAt);
  });
});

describe("имена сотрудников в публичной подписи", () => {
  it("слово целиком, без регистра, ё = е; часть слова не считается", async () => {
    const { containsForbiddenWord } = await import("../src/lib/socialVideoAi.js");
    expect(containsForbiddenWord("Звоните Нозе!", ["Ноза"])).toBe(false);
    expect(containsForbiddenWord("Агент НОЗА покажет", ["Ноза"])).toBe(true);
    expect(containsForbiddenWord("Фёдор на связи", ["Федор"])).toBe(true);
    expect(containsForbiddenWord("#Шабнам", ["Шабнам"])).toBe(true);
    expect(containsForbiddenWord("Шабнамова", ["Шабнам"])).toBe(false);
  });
});

describe("превью показывает подпись целиком", () => {
  it("длинная подпись уходит отдельным сообщением выше, превью на неё ссылается; ничего не обрезано", () => {
    const caption = `${"Очень длинная подпись. ".repeat(220)}конец`;
    const item = { mediaKind: "VIDEO", imagePaths: [], durationSec: 42, channels: ["YOUTUBE"], caption } as never;
    const parts = social.socialPostPreviewParts(item, "ru", []);
    expect(parts.captionAlone).toBe(caption);
    expect(parts.text).toContain(`в сообщении выше ↑ (${caption.length} знаков, уйдёт целиком)`);
    const short = social.socialPostPreviewParts({ ...(item as object), caption: "Коротко" } as never, "ru", []);
    expect(short.captionAlone).toBeNull();
    expect(short.text).toContain("Коротко");
  });
});

describe.skipIf(!ffmpegReady)("уборка брошенного (cron, раз в 15 минут)", () => {
  it("уборка стоит в расписании cron.ts (запуск расписания целиком сторожит cron-schedule-registry.test.ts)", async () => {
    const source = await fs.readFile(new URL("../src/cron.ts", import.meta.url), "utf8");
    expect(source).toMatch(/scheduleTracked\("staff-social-post-sweep", "\*\/15 \* \* \* \*", async \(\) => \{\s+try \{\s+const r = await sweepStaffSocialPosts\(\);/u);
  });
  it("превью старше суток — отменено и черновик удалён; PREPARING больше часа — убран; WORKING ролика — освобождён; старые временные файлы — удалены", async () => {
    const old = await freshVideoPost("s-old");
    await prisma.staffSocialPost.update({ where: { id: old.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const live = await freshVideoPost("s-live");
    const stuckDraft = await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: live.socialVideoPostId! } });
    const stuck = await prisma.staffSocialPost.create({ data: {
      chatId: marketingChat, agentId: marketingId, kind: "PHOTO", status: "PREPARING", expiresAt: new Date(Date.now() + 3_600_000), socialVideoPostId: null,
    } });
    await prisma.$executeRaw`UPDATE "StaffSocialPost" SET "updatedAt" = now() - interval '2 hours' WHERE id = ${stuck.id}`;
    const p = await seedProperty();
    const working = await prisma.staffClipIntake.create({ data: {
      chatId: agentChat, agentId, fileId: "w", filename: "w.mp4", status: "WORKING", propertyId: p.id, expiresAt: new Date(Date.now() + 3_600_000),
    } });
    await prisma.$executeRaw`UPDATE "StaffClipIntake" SET "updatedAt" = now() - interval '3 hours' WHERE id = ${working.id}`;
    const dir = path.join(tmp, "handoff");
    await fs.mkdir(dir, { recursive: true });
    const oldFile = path.join(dir, "staff-social-old.mp4");
    const newFile = path.join(dir, "staff-clip-new.mp4");
    const foreign = path.join(dir, "promo-keep.mp4");
    for (const f of [oldFile, newFile, foreign]) await fs.writeFile(f, "x");
    const longAgo = new Date(Date.now() - 3 * 3_600_000);
    await fs.utimes(oldFile, longAgo, longAgo);
    await fs.utimes(foreign, longAgo, longAgo);

    const result = await sweepStaffSocialPosts(new Date(), { handoff: dir, tmp: dir });
    expect(result.cancelled).toBeGreaterThanOrEqual(1);
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: old.id } })).status).toBe("CANCELLED");
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: old.socialVideoPostId! } })).deletedAt).not.toBeNull();
    expect(await prisma.staffSocialPost.findUnique({ where: { id: stuck.id } })).toBeNull();
    expect((await prisma.staffClipIntake.findUniqueOrThrow({ where: { id: working.id } })).status).toBe("CHOSEN");
    // Живое не тронуто.
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: live.id } })).status).toBe("PREVIEW");
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: stuckDraft.id } })).deletedAt).toBeNull();
    await expect(fs.access(oldFile)).rejects.toThrow();
    await fs.access(newFile);
    await fs.access(foreign);
    // Черновик, который уже опубликовали из «Роликов» CRM, уборка не удаляет.
    const viaCrm = await freshVideoPost("s-crm");
    await prisma.socialVideoPost.update({ where: { id: viaCrm.socialVideoPostId! }, data: { status: "DONE" } });
    await prisma.staffSocialPost.update({ where: { id: viaCrm.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await sweepStaffSocialPosts(new Date(), { handoff: dir, tmp: dir });
    expect((await prisma.staffSocialPost.findUniqueOrThrow({ where: { id: viaCrm.id } })).status).toBe("CANCELLED");
    expect((await prisma.socialVideoPost.findUniqueOrThrow({ where: { id: viaCrm.socialVideoPostId! } })).deletedAt).toBeNull();
    // Кнопка отменённого уборкой превью — «устарела», в сети ничего.
    await pressPost(marketingChat, "p", old.id);
    expect(jobs.enqueue).not.toHaveBeenCalled();
  });
});

describe("к какому объекту ролик: распознавание", () => {
  it("номер только в имени файла — кандидат с кнопкой «Да, это …», сразу не принимаем", async () => {
    const p = await seedProperty();
    await handleStaffClipMessage(msg(agentChat, { document: { file_id: "r1", file_unique_id: `r1-${runId}`, file_name: `${p.shortId}.mp4`, mime_type: "video/mp4" } }), plainAgent());
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r1-${runId}` } });
    expect(intake.status).toBe("ASKING");
    expect(lastButtons()[0]).toEqual({ text: `✅ Да, это ОБ-${String(p.shortId).padStart(6, "0")}`, callback_data: `clip:p:${intake.id}:${p.shortId}` });
    expect(speech.transcribe).not.toHaveBeenCalled();
  });

  it("номер в имени файла + район в подписи + свой объект — сразу «Готов к выпуску / Нужен монтаж»", async () => {
    const p = await seedProperty();
    const name = (await prisma.district.findUniqueOrThrow({ where: { id: districtId } })).name;
    await handleStaffClipMessage(msg(agentChat, { caption: name, document: { file_id: "r1b", file_unique_id: `r1b-${runId}`, file_name: `${p.shortId}.mp4`, mime_type: "video/mp4" } }), plainAgent());
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r1b-${runId}` } });
    expect(intake.status).toBe("CHOSEN");
    expect(intake.propertyId).toBe(p.id);
  });

  it("номер в имени файла и район, но объект ведёт другой сотрудник — только кандидат", async () => {
    const p = await seedProperty();
    const name = (await prisma.district.findUniqueOrThrow({ where: { id: districtId } })).name;
    // Маркетолог может вести любой объект, но этот — агента: сам не принимаем, спрашиваем кнопкой.
    await handleStaffClipMessage(msg(marketingChat, { caption: name, document: { file_id: "r1c", file_unique_id: `r1c-${runId}`, file_name: `${p.shortId}.mp4`, mime_type: "video/mp4" } }), marketing());
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r1c-${runId}` } });
    expect(intake.status).toBe("ASKING");
    expect(lastButtons()[0]?.callback_data).toBe(`clip:p:${intake.id}:${p.shortId}`);
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

  it("цена объекта в долларах узнаётся по сумме в сомони (общий пересчёт по курсу)", async () => {
    const usd = 80_000 + Number(tail.slice(-3));
    const rate = Number((await prisma.settings.findUnique({ where: { id: "singleton" }, select: { usdToTjsRate: true } }))?.usdToTjsRate ?? 11) || 11;
    const p = await seedProperty({ price: usd, currency: "USD" });
    await handleStaffClipMessage(msg(agentChat, { caption: `цена ${Math.round(usd * rate)} сомони`, document: { file_id: "r2u", file_unique_id: `r2u-${runId}`, file_name: "IMG_7778.MOV", mime_type: "video/mp4" } }), plainAgent());
    const intake = await prisma.staffClipIntake.findFirstOrThrow({ where: { fileUniqueId: `r2u-${runId}` } });
    expect(lastButtons()[0]?.callback_data).toBe(`clip:p:${intake.id}:${p.shortId}`);
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
