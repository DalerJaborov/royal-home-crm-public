/**
 * МОДЕРАЦИЯ ИЗ TELEGRAM (владелец 22.09.2026: «админ модерирует полностью из
 * Telegram, без CRM»).
 *
 * Что приходит модератору (Agent.telegramModeration + право properties.moderate +
 * привязанный чат):
 *  - объект на проверке: альбом фото (главное первым), видео, карточка с
 *    предпросмотром подписи и кнопками Одобрить / Вернуть / Поправить / CRM;
 *  - досланные фото к уже проверенному объекту: альбом и «Все ✅» / «Отклонить
 *    все» / «По одному».
 *
 * Решения идут ТЕМ ЖЕ путём, что и в CRM (lib/propertyReview.ts,
 * lib/propertyPhotoRemoval.ts, PATCH /properties/:id), а не копией логики.
 *
 * ГРАНИЧНЫЕ СЛУЧАИ (каждый покрыт тестом, tests/telegramModeration.test.ts):
 *  1. гонка админов — атомарный переход в сервисе, проигравшему «Уже решил …»;
 *  2. решение где угодно гасит кнопки у всех — отправленные сообщения лежат в
 *     TelegramModerationMessage, слушатель onReviewDecision их правит;
 *  3. повтор callback — TelegramCallbackSeen, answerCallbackQuery первым делом;
 *  4. права — чат → активный сотрудник с правом модерации, в callback_data
 *     только короткий номер;
 *  5. карточка изменилась, пока висела, — «устарело» и свежая карточка;
 *     объект удалён — «Объект удалён»;
 *  6. видео не ушло — ссылка на карточку в CRM, остальное продолжается;
 *  7. пауза между отправками, 429 разбирает telegram/api.ts::call;
 *  8. бот заблокирован / нет чата — logSystemError, пуш CRM не зависит от этого;
 *  9. аудит каждого решения с source "telegram";
 * 10. все вызовы Telegram — с таймаутом (telegram/api.ts).
 */
import path from "node:path";
import { stat } from "node:fs/promises";
import {
  parsePermissionOverrides,
  PROPERTY_TYPE_LABELS,
  propertyUpdateSchema,
  propertyFieldShown,
  propertyFloorsLabel,
  resolvePermissions,
  type Role,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { uploadsDir } from "../upload.js";
import {
  answerCallbackQuery,
  editMessageCaption,
  editMessageText,
  isTelegramEnabled,
  sendMediaGroupFiles,
  sendMessage,
  sendPhotoFromDisk,
  sendMessageWithButtons,
  sendVideoFromDisk,
  TELEGRAM_BOT_SEND_LIMIT_BYTES,
  type TelegramCallbackQuery,
  type TelegramInlineButton,
} from "../telegram/api.js";
import { logSystemError } from "./systemError.js";
import { logAgentAudit } from "./audit.js";
import { localVideoFilePath } from "./localVideoStorage.js";
import { formatDurationShort } from "./rawVideoFacts.js";
import { publicAppUrl } from "./crmPublicUrl.js";
import { buildPriceDisplay, generateReelsCaptionFromTemplates, reelsCaptionValuesFromProperty } from "./reelsCaptionTemplate.js";
import { loadMoneyContext } from "./money.js";
import { dushanbeDateTimeString as formatDushanbe } from "./dushanbeTime.js";
import {
  approveReviewAll,
  onReviewDecision,
  rejectReview,
  whoDecided,
  type ReviewDecisionEvent,
  type ReviewMaterial,
} from "./propertyReview.js";
import { removePropertyPhoto } from "./propertyPhotoRemoval.js";
import { onPendingReview } from "./propertyPipeline.js";
import { signAccessToken } from "../auth/jwt.js";

/** Сколько ждёт бот ответа модератора (комментарий, новое значение). */
export const DIALOG_TTL_MS = 15 * 60_000;
/** Пауза между сообщениями одному чату: Telegram режет ~1 сообщение/сек на чат. */
export const SEND_PAUSE_MS = 1_100;
const ALBUM_MAX = 10;

export const REJECT_REASONS: Array<{ text: string; material: ReviewMaterial }> = [
  { text: "Мало фото", material: "photos" },
  { text: "Тёмные / размытые фото", material: "photos" },
  { text: "Фото не того объекта", material: "photos" },
  { text: "Нет видео / плохое видео", material: "video" },
  { text: "Видео не по объекту", material: "video" },
  { text: "Другое (фото)", material: "photos" },
  { text: "Другое (видео)", material: "video" },
];

/** Поля «Поправить» — самые частые опечатки агента в карточке. */
export const EDITABLE_FIELDS = {
  price: { label: "Цена", numeric: true },
  areaSqm: { label: "Площадь, м²", numeric: true },
  rooms: { label: "Комнаты", numeric: true },
  floor: { label: "Этаж", numeric: true },
  totalFloors: { label: "Этажность", numeric: true },
  address: { label: "Адрес", numeric: false },
} as const;
export type EditableField = keyof typeof EDITABLE_FIELDS;

/** Поле правки имеет смысл у этого типа объекта. */
export function editableFieldShown(type: string, field: EditableField): boolean {
  if (field === "price" || field === "address") return true;
  return propertyFieldShown(type, field);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────── получатели и права ───────────────────────────

export interface Moderator {
  id: string;
  fullName: string;
  chatId: string;
}

function canModerate(a: { role: string; permissions: unknown }): boolean {
  return resolvePermissions(a.role as Role, parsePermissionOverrides(a.permissions as never)).has("properties.moderate");
}

/** Все, кому рассылать: активные, с флагом, с чатом и с правом модерации. */
export async function listTelegramModerators(): Promise<Moderator[]> {
  const agents = await prisma.agent.findMany({
    where: { isActive: true, telegramModeration: true, telegramChatId: { not: null } },
    select: { id: true, fullName: true, role: true, permissions: true, telegramChatId: true },
  });
  return agents.filter(canModerate).map((a) => ({ id: a.id, fullName: a.fullName, chatId: a.telegramChatId! }));
}

/** Чат → модератор. Флаг НЕ требуется: выключил рассылку — старые кнопки всё равно
 *  его, а право проверяется заново на каждое нажатие (могли отобрать). */
export async function moderatorByChat(chatId: string): Promise<Moderator | null> {
  const a = await prisma.agent.findUnique({
    where: { telegramChatId: chatId },
    select: { id: true, fullName: true, role: true, permissions: true, isActive: true, telegramChatId: true },
  });
  if (!a || !a.isActive || !canModerate(a)) return null;
  return { id: a.id, fullName: a.fullName, chatId };
}

// ─────────────────────────── карточка объекта ───────────────────────────

const propertyInclude = {
  district: { select: { name: true } },
  photos: { orderBy: { order: "asc" as const }, select: { id: true, url: true } },
  videos: {
    orderBy: { uploadedAt: "asc" as const },
    // filename/hasAudio — задание C (23.09.2026): «⚠ Видео без звука» в карточке
    // модератора, describeRawVideo молча пропускает поле, если факт ещё не разобран.
    select: { storageKey: true, sizeBytes: true, filename: true, hasAudio: true, durationSec: true },
  },
};
type CardProperty = Prisma.PropertyGetPayload<{ include: typeof propertyInclude }>;

async function loadCardProperty(where: { id: string } | { shortId: number }): Promise<CardProperty | null> {
  return prisma.property.findUnique({ where, include: propertyInclude }) as Promise<CardProperty | null>;
}

export function crmPropertyUrl(shortId: number): string {
  return `${publicAppUrl().replace(/\/+$/, "")}/properties/${shortId}`;
}

async function captionPreview(p: CardProperty): Promise<string> {
  if (p.reelsCaption?.trim()) return p.reelsCaption.trim();
  const [settings, responsible, money] = await Promise.all([
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { reelsCaptionTemplates: true } }),
    prisma.agent.findUnique({
      where: { id: p.intakeAgentId ?? p.assignedAgentId ?? p.createdById ?? "" },
      select: { phone: true },
    }),
    loadMoneyContext(),
  ]);
  return generateReelsCaptionFromTemplates(
    reelsCaptionValuesFromProperty({
      type: p.type,
      rooms: p.rooms,
      areaSqm: p.areaSqm,
      floor: p.floor,
      totalFloors: p.totalFloors,
      price: p.price,
      currency: p.currency,
      condition: p.condition,
      stage: p.stage ?? null,
      marketType: p.marketType ?? null,
      districtName: p.district?.name ?? "Душанбе",
      phone: responsible?.phone ?? null,
      address: p.address,
      documents: p.documents,
      windowCount: p.windowCount,
      details: p.details,
      landAreaSotka: p.landAreaSotka,
      amenities: p.amenities,
      money,
    }),
    settings?.reelsCaptionTemplates
  );
}

/** Текст карточки. Телефон собственника не выводится намеренно: чат модератора —
 *  не место для контактов клиента (пересылка, чужой телефон в руках). */
export async function buildReviewCardText(p: CardProperty): Promise<string> {
  const responsibleId = p.intakeAgentId ?? p.assignedAgentId ?? p.createdById;
  const [agent, money] = await Promise.all([
    responsibleId ? prisma.agent.findUnique({ where: { id: responsibleId }, select: { fullName: true } }) : null,
    loadMoneyContext(),
  ]);
  // По типу: у дома — этажность, у участка ни комнат, ни этажей (propertyTypeFields.ts).
  const floors = propertyFloorsLabel(p);
  const hasFloors = propertyFieldShown(p.type, "totalFloors");
  const approved = [p.photosApprovedAt ? "фото ✅" : null, p.videoApprovedAt ? "видео ✅" : null].filter(Boolean).join(", ");
  // Без звука — задание C (23.09.2026, объект №127): модератор одобрял видео
  // вслепую, звук пропадал уже на монтаже. Строка появляется, только если
  // describeRawVideo уже знает hasAudio === false хотя бы у одного ролика.
  const silentVideos = p.videos.filter((v) => v.hasAudio === false).map((v) => v.filename);
  const lines = [
    `🏠 Объект №${p.shortId} на проверке`,
    `Тип: ${PROPERTY_TYPE_LABELS[p.type] ?? p.type}`,
    `Район: ${p.district?.name ?? "—"}`,
    `Адрес: ${p.address?.trim() || "—"}`,
    `Цена: ${buildPriceDisplay(p.price, p.currency, money)}`,
    `Площадь: ${Number(p.areaSqm)} м²`,
    propertyFieldShown(p.type, "rooms") ? `Комнат: ${p.rooms ?? "—"}` : null,
    hasFloors ? `${floors?.label ?? (propertyFieldShown(p.type, "floor") ? "Этаж" : "Этажность")}: ${floors?.value ?? "—"}` : null,
    `Агент: ${agent?.fullName ?? "—"}`,
    `Фото: ${p.photos.length}, видео: ${p.videos.length}${approved ? ` (${approved})` : ""}`,
    silentVideos.length ? `⚠ Видео без звука: ${silentVideos.join(", ")}` : null,
    "",
    "📝 Подпись публикации:",
    await captionPreview(p),
  ].filter((l): l is string => l !== null);
  return lines.join("\n");
}

export function reviewButtons(shortId: number): TelegramInlineButton[][] {
  return [
    [
      { text: "✅ Одобрить", callback_data: `tm:a:${shortId}` },
      { text: "↩️ Вернуть", callback_data: `tm:r:${shortId}` },
    ],
    [
      { text: "✏️ Поправить", callback_data: `tm:e:${shortId}` },
      { text: "🔗 Открыть в CRM", url: crmPropertyUrl(shortId) },
    ],
  ];
}

function photoDiskPath(url: string): string {
  return path.join(uploadsDir, path.basename(url));
}

/** Ошибка отправки конкретному модератору: журнал, но рассылка остальным идёт. */
function reportSendFailure(mod: Moderator, what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  void logSystemError("telegram", `Модерация в Telegram: ${what} для ${mod.fullName} не ушло: ${message}`);
}

/**
 * Альбом фото объекта файлами с диска — один помощник на модерацию и на бота
 * монтажёра («🖼 Фото», 25.09.2026). До 10 штук (предел sendMediaGroup);
 * одиночное фото уходит sendPhoto — sendMediaGroup принимает от двух элементов.
 * Бросает ошибку Telegram — решать, что с ней делать, вызывающему.
 */
export async function sendPhotoAlbumFromDisk(chatId: string, photos: ReadonlyArray<{ url: string }>, caption?: string): Promise<void> {
  const group = photos.slice(0, ALBUM_MAX);
  if (group.length === 0) return;
  if (group.length === 1) await sendPhotoFromDisk(chatId, photoDiskPath(group[0]!.url), caption);
  else
    await sendMediaGroupFiles(
      chatId,
      group.map((ph, i) => ({ type: "photo" as const, path: photoDiskPath(ph.url), ...(i === 0 && caption ? { caption } : {}) }))
    );
}

/** «1,2 ГБ» / «640 МБ» — размер для человека, с запятой по-русски. */
export function humanFileSize(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1).replace(".", ",")} ГБ`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} МБ`;
}

/**
 * ВИДЕО В МОДЕРАЦИИ — ВСЕ, А НЕ «1 ИЗ 16» (25.09.2026, А6, объект №119). Модератор
 * видел подпись «Видео 1 из 16» и не знал, что за остальные 15 файлов, сколько
 * они весят и не дубли ли это. Теперь — сводка перед первым роликом: сколько
 * файлов, общий вес и список имён с длительностью; сам файл по-прежнему один.
 */
export function moderationVideoSummaryText(videos: ReadonlyArray<{ filename: string; sizeBytes: number; durationSec: number | null }>): string {
  const total = videos.reduce((sum, v) => sum + v.sizeBytes, 0);
  const lines = videos.map((v, i) => {
    const duration = v.durationSec != null ? ` — ${formatDurationShort(v.durationSec)}` : "";
    return `${i + 1}. ${v.filename}${duration}`;
  });
  return [`🎬 Видео: ${videos.length} ${videoFilesWord(videos.length)} (${humanFileSize(total)}), первый — ниже:`, ...lines].join("\n");
}

export function videoFilesWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "файл";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "файла";
  return "файлов";
}

/** Альбомы фото и видео — best-effort: не ушло — пишем в журнал и идём дальше. */
async function sendMaterials(mod: Moderator, p: CardProperty, opts: { photos?: Array<{ url: string }>; video?: boolean }): Promise<void> {
  const photos = opts.photos ?? p.photos;
  // Главное фото отдельным (первым) альбомом, остальные — вторым, до 10 штук.
  const groups = [photos.slice(0, 1), photos.slice(1, 1 + ALBUM_MAX)].filter((g) => g.length > 0);
  for (const group of groups) {
    try {
      await sendPhotoAlbumFromDisk(mod.chatId, group);
    } catch (err) {
      reportSendFailure(mod, `фото №${p.shortId}`, err);
    }
    await sleep(SEND_PAUSE_MS);
  }
  if (!opts.video) return;
  const video = p.videos[0];
  if (!video) return;
  if (p.videos.length > 1) {
    await sendMessage(mod.chatId, moderationVideoSummaryText(p.videos)).catch((err) => reportSendFailure(mod, `список видео №${p.shortId}`, err));
    await sleep(SEND_PAUSE_MS);
  }
  const diskPath = localVideoFilePath(video.storageKey);
  const tooBig = video.sizeBytes > TELEGRAM_BOT_SEND_LIMIT_BYTES;
  try {
    if (!diskPath || tooBig) throw new Error(tooBig ? "файл больше предела Telegram" : "файл не найден в хранилище");
    await stat(diskPath);
    await sendVideoFromDisk(mod.chatId, diskPath, p.videos.length > 1 ? `Видео 1: ${video.filename}` : undefined);
  } catch (err) {
    reportSendFailure(mod, `видео №${p.shortId}`, err);
    await sendMessage(mod.chatId, `🎬 Видео не удалось прислать сюда — смотреть и скачать в CRM: ${crmPropertyUrl(p.shortId)}`).catch(() => {});
  }
  await sleep(SEND_PAUSE_MS);
}

export async function recordMessage(params: {
  kind: "REVIEW" | "PHOTOS" | "CLIP" | "CLIP_TEXT";
  propertyId: string;
  batchId?: string | null;
  mod: Moderator;
  messageId: number;
  text: string;
  version: number;
}): Promise<void> {
  await prisma.telegramModerationMessage.create({
    data: {
      kind: params.kind,
      propertyId: params.propertyId,
      batchId: params.batchId ?? null,
      agentId: params.mod.id,
      chatId: params.mod.chatId,
      messageId: params.messageId,
      text: params.text,
      propertyVersion: params.version,
    },
  });
}

async function sendReviewCard(mod: Moderator, p: CardProperty, withMaterials: boolean): Promise<void> {
  if (withMaterials) await sendMaterials(mod, p, { video: true });
  const text = await buildReviewCardText(p);
  try {
    const sent = await sendMessageWithButtons(mod.chatId, text, reviewButtons(p.shortId));
    await recordMessage({ kind: "REVIEW", propertyId: p.id, mod, messageId: sent.message_id, text, version: p.version });
  } catch (err) {
    reportSendFailure(mod, `карточка №${p.shortId}`, err);
  }
}

/** Объект встал на проверку — всем модераторам в Telegram. Никогда не бросает:
 *  пуш CRM (notifyPendingReview) от этой рассылки не зависит. */
export async function notifyTelegramReview(propertyId: string): Promise<void> {
  try {
    if (!isTelegramEnabled()) return;
    const mods = await listTelegramModerators();
    if (mods.length === 0) return;
    const p = await loadCardProperty({ id: propertyId });
    if (!p || p.deletedAt || p.status !== "PENDING_REVIEW") return;
    for (const mod of mods) await sendReviewCard(mod, p, true);
  } catch (err) {
    void logSystemError("telegram", `Модерация в Telegram: рассылка объекта ${propertyId} упала: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────── досланные фото ───────────────────────────

export function photoBatchButtons(code: number): TelegramInlineButton[][] {
  return [
    [
      { text: "✅ Все", callback_data: `tm:pa:${code}` },
      { text: "❌ Отклонить все", callback_data: `tm:pr:${code}` },
    ],
    [{ text: "По одному", callback_data: `tm:p1:${code}` }],
  ];
}

/** Агент дослал фото к уже проверенному объекту — на решение модераторам. */
export async function notifyTelegramPhotoBatch(propertyId: string, photoIds: string[]): Promise<void> {
  try {
    if (!isTelegramEnabled() || photoIds.length === 0) return;
    const mods = await listTelegramModerators();
    if (mods.length === 0) return;
    const p = await loadCardProperty({ id: propertyId });
    if (!p || p.deletedAt) return;
    const batch = await prisma.telegramPhotoBatch.create({ data: { propertyId, photoIds } });
    const photos = p.photos.filter((ph) => photoIds.includes(ph.id));
    const text = `📷 К объекту №${p.shortId} досланы фото: ${photos.length}`;
    for (const mod of mods) {
      await sendMaterials(mod, p, { photos, video: false });
      try {
        const sent = await sendMessageWithButtons(mod.chatId, text, photoBatchButtons(batch.shortCode));
        await recordMessage({ kind: "PHOTOS", propertyId, batchId: batch.id, mod, messageId: sent.message_id, text, version: p.version });
      } catch (err) {
        reportSendFailure(mod, `досланные фото №${p.shortId}`, err);
      }
    }
  } catch (err) {
    void logSystemError("telegram", `Модерация в Telegram: досланные фото ${propertyId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─────────────────────────── погасить кнопки у всех ───────────────────────────

function decisionLine(e: { outcome: string; name: string; at: Date; source: string; reason?: string }): string {
  const icon = e.outcome === "rejected" ? "↩️ Возвращено на доработку" : e.outcome === "partial" ? "☑️ Частично одобрено" : "✅ Одобрено";
  const where = e.source === "telegram" ? "в Telegram" : e.source === "auto" ? "автоматически: проверка исходников выключена" : "в CRM";
  return `${icon} (${e.name}, ${formatDushanbe(e.at)}, ${where})${e.reason ? `\nПричина: ${e.reason}` : ""}`;
}

/** Правит все неразрешённые сообщения по условию: убирает кнопки и дописывает строку. */
export async function resolveMessages(where: Prisma.TelegramModerationMessageWhereInput, line: string): Promise<number> {
  const open = await prisma.telegramModerationMessage.findMany({ where: { ...where, resolvedAt: null }, take: 200 });
  if (open.length === 0) return 0;
  // Сначала помечаем в базе (атомарно по id), потом правим: две параллельные
  // рассылки не отредактируют одно сообщение дважды.
  const claimed = await prisma.telegramModerationMessage.updateMany({
    where: { id: { in: open.map((m) => m.id) }, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
  for (const m of open) {
    try {
      // CLIP — видео с подписью (готовый ролик на проверке, lib/clipReview.ts,
      // 25.09.2026): у него правится подпись, а не текст сообщения.
      if (m.kind === "CLIP") await editMessageCaption(m.chatId, m.messageId, `${m.text}\n\n${line}`, null);
      else await editMessageText(m.chatId, m.messageId, `${m.text}\n\n${line}`, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/message is not modified|message to edit not found/i.test(message)) {
        void logSystemError("telegram", `Модерация в Telegram: не удалось обновить сообщение №${m.messageId}: ${message}`);
      }
    }
  }
  return claimed.count;
}

async function onDecision(e: ReviewDecisionEvent): Promise<void> {
  if (e.outcome === "partial") return; // объект всё ещё на проверке — кнопки нужны
  const agent = e.actor.agentId ? await prisma.agent.findUnique({ where: { id: e.actor.agentId }, select: { fullName: true } }) : null;
  await resolveMessages(
    { propertyId: e.propertyId, kind: "REVIEW" },
    decisionLine({ outcome: e.outcome, name: agent?.fullName ?? (e.actor.agentId ? "—" : "CRM"), at: e.at, source: e.actor.source, reason: e.reason })
  );
}
onReviewDecision(onDecision);

// ─────────────────────────── диалог (в базе, TTL 15 мин) ───────────────────────────

export type DialogState =
  | { kind: "reject_comment"; shortId: number; reason: number }
  | { kind: "edit_value"; shortId: number; field: EditableField }
  | { kind: "edit_confirm"; shortId: number; field: EditableField; value: string | number; version: number };

const MODERATION_DIALOG_KINDS: ReadonlySet<string> = new Set<DialogState["kind"]>(["reject_comment", "edit_value", "edit_confirm"]);

export async function setDialog(chatId: string, agentId: string, state: DialogState, now = new Date()): Promise<void> {
  const { kind, ...payload } = state;
  const data = { agentId, kind, payload: payload as Prisma.InputJsonValue, expiresAt: new Date(now.getTime() + DIALOG_TTL_MS) };
  await prisma.telegramDialogState.upsert({ where: { chatId }, create: { chatId, ...data }, update: data });
}

export async function getDialog(chatId: string, agentId: string, now = new Date()): Promise<DialogState | null> {
  const row = await prisma.telegramDialogState.findUnique({ where: { chatId } });
  if (!row) return null;
  // Та же таблица хранит вопрос монтажёру «это для №133 или №136?»
  // (telegram/montajerReceive.ts, 25.09.2026) — чужой вид состояния модерация
  // не читает и не стирает: иначе модератор-монтажёр терял бы свой вопрос.
  if (!MODERATION_DIALOG_KINDS.has(row.kind)) return null;
  if (row.expiresAt <= now || row.agentId !== agentId) {
    await prisma.telegramDialogState.deleteMany({ where: { chatId } });
    return null;
  }
  return { kind: row.kind, ...(row.payload as object) } as DialogState;
}

export async function clearDialog(chatId: string): Promise<void> {
  await prisma.telegramDialogState.deleteMany({ where: { chatId } });
}

// ─────────────────────────── нажатия кнопок ───────────────────────────

/** Первое ли это нажатие с таким id. Повторная доставка — false. */
export async function claimCallback(id: string): Promise<boolean> {
  try {
    await prisma.telegramCallbackSeen.create({ data: { id } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

async function alreadyDecidedText(propertyId: string): Promise<string> {
  const who = await whoDecided(propertyId);
  if (!who) return "Объект уже не на проверке.";
  return `Уже решил ${who.name} в ${formatDushanbe(who.at)}${who.source === "telegram" ? " (Telegram)" : who.source === "crm" ? " (CRM)" : who.source === "auto" ? " (автоматически)" : ""}.`;
}

/**
 * Сообщение устарело (карточку правили) или объект удалён — гасим старые кнопки
 * и, если объект жив и всё ещё на проверке, шлём свежую карточку. true — нажатие
 * отработано здесь, решение не выполняется.
 */
async function guardStale(mod: Moderator, messageId: number | undefined, p: CardProperty | null): Promise<boolean> {
  const row = messageId
    ? await prisma.telegramModerationMessage.findFirst({ where: { chatId: mod.chatId, messageId, kind: "REVIEW" } })
    : null;
  if (!p || p.deletedAt) {
    if (row) await resolveMessages({ id: row.id }, "🗑 Объект удалён");
    else await sendMessage(mod.chatId, "🗑 Объект удалён").catch(() => {});
    return true;
  }
  if (row && row.propertyVersion !== p.version && !row.resolvedAt && p.status === "PENDING_REVIEW") {
    await resolveMessages({ id: row.id }, "⚠️ Устарело: карточку изменили. Актуальная — ниже.");
    await sendReviewCard(mod, p, false);
    return true;
  }
  return false;
}

export async function reply(chatId: string, text: string, buttons?: TelegramInlineButton[][]): Promise<void> {
  try {
    if (buttons) await sendMessageWithButtons(chatId, text, buttons);
    else await sendMessage(chatId, text);
  } catch (err) {
    void logSystemError("telegram", `Модерация в Telegram: ответ в чат не ушёл: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Разбор нажатия `tm:*`. Возвращает true, если нажатие модерационное (обработано
 * здесь целиком), иначе false — пусть разбирает остальной бот.
 */
export async function handleModerationCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const data = query.data ?? "";
  if (!data.startsWith("tm:")) return false;
  // Ответ Telegram — сразу: иначе у админа крутится индикатор, пока идёт отправка.
  await answerCallbackQuery(query.id).catch(() => {});
  const chatId = query.message?.chat.id != null ? String(query.message.chat.id) : null;
  if (!chatId) return true;
  if (!(await claimCallback(query.id))) return true;

  const mod = await moderatorByChat(chatId);
  if (!mod) {
    await reply(chatId, "Нет права модерации. Если это ошибка — попросите руководителя выдать его в CRM.");
    return true;
  }
  const messageId = query.message?.message_id;
  const [, action, arg1, arg2] = data.split(":");

  if (action === "x") {
    await clearDialog(chatId);
    await reply(chatId, "Отменено.");
    return true;
  }

  // Досланные фото — по короткому номеру пачки.
  if (action?.startsWith("p")) {
    await handlePhotoAction(mod, action, Number(arg1), arg2 !== undefined ? Number(arg2) : null);
    return true;
  }

  const shortId = Number(arg1);
  if (!Number.isInteger(shortId) || shortId <= 0) return true;
  const p = await loadCardProperty({ shortId });

  // Подтверждение правки и выбор поля не проверяют «устарело»: версию сверяет
  // сам PATCH (оптимистичная блокировка), а меню полей ничего не меняет.
  if (action !== "ey" && action !== "ef" && action !== "rx" && (await guardStale(mod, messageId, p))) return true;
  if (!p || p.deletedAt) {
    await reply(chatId, "🗑 Объект удалён");
    return true;
  }

  switch (action) {
    case "a": {
      const result = await approveReviewAll(p.id, { agentId: mod.id, source: "telegram" });
      if (!result.ok) {
        await reply(chatId, result.code === "no_material" ? `Нельзя одобрить №${shortId}: ${result.error}` : await alreadyDecidedText(p.id));
      }
      return true;
    }
    case "r": {
      if (p.status !== "PENDING_REVIEW") {
        await reply(chatId, await alreadyDecidedText(p.id));
        return true;
      }
      await reply(
        chatId,
        `Почему возвращаем №${shortId}?`,
        REJECT_REASONS.map((r, i) => [{ text: r.text, callback_data: `tm:rr:${shortId}:${i}` }])
      );
      return true;
    }
    case "rr": {
      const reason = Number(arg2);
      if (!REJECT_REASONS[reason]) return true;
      await setDialog(chatId, mod.id, { kind: "reject_comment", shortId, reason });
      await reply(chatId, `Причина: «${REJECT_REASONS[reason]!.text}». Напишите комментарий агенту одним сообщением (15 минут) или отправьте без него.`, [
        [{ text: "Отправить без комментария", callback_data: `tm:rx:${shortId}` }],
        [{ text: "Отмена", callback_data: "tm:x" }],
      ]);
      return true;
    }
    case "rx": {
      const state = await getDialog(chatId, mod.id);
      if (!state || state.kind !== "reject_comment" || state.shortId !== shortId) {
        await reply(chatId, "Время на ответ вышло — нажмите «Вернуть» ещё раз.");
        return true;
      }
      await clearDialog(chatId);
      await finishReject(mod, p.id, state.reason, null);
      return true;
    }
    case "e": {
      await reply(
        chatId,
        `Что поправить в №${shortId}?`,
        // Только поля, которые есть у этого типа: у дома нет «Этажа», у участка —
        // комнат и этажей (packages/shared/src/propertyTypeFields.ts).
        (Object.keys(EDITABLE_FIELDS) as EditableField[])
          .filter((f) => editableFieldShown(p.type, f))
          .map((f) => [{ text: EDITABLE_FIELDS[f].label, callback_data: `tm:ef:${shortId}:${f}` }])
      );
      return true;
    }
    case "ef": {
      if (!(arg2 && arg2 in EDITABLE_FIELDS)) return true;
      const field = arg2 as EditableField;
      await setDialog(chatId, mod.id, { kind: "edit_value", shortId, field });
      await reply(chatId, `${EDITABLE_FIELDS[field].label}: сейчас «${fieldValue(p, field) ?? "—"}». Пришлите новое значение (15 минут).`, [
        [{ text: "Отмена", callback_data: "tm:x" }],
      ]);
      return true;
    }
    case "ey": {
      const state = await getDialog(chatId, mod.id);
      if (!state || state.kind !== "edit_confirm" || state.shortId !== shortId) {
        await reply(chatId, "Время на подтверждение вышло — начните правку заново.");
        return true;
      }
      await clearDialog(chatId);
      const result = await applyPropertyEdit(mod.id, p.id, { [state.field]: state.value, version: state.version });
      if (!result.ok) {
        await reply(chatId, `Не сохранено: ${result.error}`);
        return true;
      }
      logAgentAudit(mod.id, "PROPERTY_EDITED_TELEGRAM", "Property", p.id, {
        source: "telegram",
        field: state.field,
        was: fieldValue(p, state.field),
        becomes: state.value,
      });
      await reply(chatId, `Сохранено: ${EDITABLE_FIELDS[state.field].label} — ${state.value}.`);
      // Карточка изменилась — старые сообщения у всех устарели; свежую получат все.
      await resolveMessages({ propertyId: p.id, kind: "REVIEW" }, `✏️ Поправлено (${mod.fullName}, ${formatDushanbe(new Date())}, в Telegram) — актуальная карточка ниже.`);
      const fresh = await loadCardProperty({ id: p.id });
      if (fresh && fresh.status === "PENDING_REVIEW" && !fresh.deletedAt) {
        for (const m of await listTelegramModerators()) await sendReviewCard(m, fresh, false);
      }
      return true;
    }
    default:
      return true;
  }
}

function fieldValue(p: CardProperty, field: EditableField): string | number | null {
  const v = p[field];
  if (v == null) return null;
  return typeof v === "object" ? Number(v) : (v as string | number);
}

async function finishReject(mod: Moderator, propertyId: string, reasonIdx: number, comment: string | null): Promise<void> {
  const reason = REJECT_REASONS[reasonIdx]!;
  const text = comment ? `${reason.text}: ${comment}` : reason.text;
  const result = await rejectReview(propertyId, { material: reason.material, reason: text.slice(0, 500) }, { agentId: mod.id, source: "telegram" });
  if (!result.ok) await reply(mod.chatId, await alreadyDecidedText(propertyId));
}

/** Текст от модератора: ответ на «жду комментарий» / «жду значение». true — разобран. */
export async function handleModerationText(chatId: string, text: string): Promise<boolean> {
  const mod = await moderatorByChat(chatId);
  if (!mod) return false;
  const state = await getDialog(chatId, mod.id);
  if (!state) return false;
  const p = await loadCardProperty({ shortId: state.shortId });
  if (!p || p.deletedAt) {
    await clearDialog(chatId);
    await reply(chatId, "🗑 Объект удалён");
    return true;
  }
  if (state.kind === "reject_comment") {
    await clearDialog(chatId);
    await finishReject(mod, p.id, state.reason, text.trim().slice(0, 400));
    return true;
  }
  if (state.kind === "edit_value") {
    const parsed = parseFieldInput(state.field, text);
    if (!parsed.ok) {
      await reply(chatId, `Не подходит: ${parsed.error}. Пришлите ещё раз или нажмите «Отмена».`, [[{ text: "Отмена", callback_data: "tm:x" }]]);
      return true;
    }
    await setDialog(chatId, mod.id, { kind: "edit_confirm", shortId: p.shortId, field: state.field, value: parsed.value, version: p.version });
    await reply(chatId, `${EDITABLE_FIELDS[state.field].label}: ${fieldValue(p, state.field) ?? "—"} → ${parsed.value}. Сохранить?`, [
      [
        { text: "✅ Сохранить", callback_data: `tm:ey:${p.shortId}` },
        { text: "Отмена", callback_data: "tm:x" },
      ],
    ]);
    return true;
  }
  return false;
}

/** Разбор ввода той же Zod-схемой, что проверяет PATCH объекта в CRM. */
export function parseFieldInput(field: EditableField, raw: string): { ok: true; value: string | number } | { ok: false; error: string } {
  const text = raw.trim();
  const value: string | number = EDITABLE_FIELDS[field].numeric ? Number(text.replace(/[\s ]/g, "").replace(",", ".")) : text;
  if (EDITABLE_FIELDS[field].numeric && !Number.isFinite(value)) return { ok: false, error: "нужно число" };
  const result = propertyUpdateSchema.safeParse({ [field]: value });
  if (!result.success) return { ok: false, error: result.error.issues[0]?.message ?? "неверное значение" };
  return { ok: true, value };
}

/**
 * Правка карточки — через сам PATCH /properties/:id от имени модератора, а не
 * копией его логики: пересборка названия, SEO, история цены, права, журнал и
 * оптимистичная блокировка по version работают ровно как в CRM.
 */
export async function applyPropertyEdit(
  agentId: string,
  propertyId: string,
  body: Record<string, unknown>
): Promise<{ ok: true } | { ok: false; error: string }> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { role: true } });
  if (!agent) return { ok: false, error: "сотрудник не найден" };
  const token = signAccessToken({ sub: agentId, role: agent.role });
  const port = Number(process.env.PORT ?? 4000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/properties/${propertyId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: res.status === 409 && !data.error ? "карточку успели изменить" : data.error ?? `ошибка ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────── действия с досланными фото ───────────────────────────

async function handlePhotoAction(mod: Moderator, action: string, code: number, idx: number | null): Promise<void> {
  if (!Number.isInteger(code)) return;
  const batch = await prisma.telegramPhotoBatch.findUnique({ where: { shortCode: code } });
  if (!batch) return;
  const property = await prisma.property.findUnique({ where: { id: batch.propertyId } });
  if (!property || property.deletedAt) {
    await resolveMessages({ batchId: batch.id }, "🗑 Объект удалён");
    return;
  }
  const stamp = `${mod.fullName}, ${formatDushanbe(new Date())}, в Telegram`;
  const loserText = async () => {
    const fresh = await prisma.telegramPhotoBatch.findUnique({ where: { id: batch.id } });
    const who = fresh?.resolvedById ? await prisma.agent.findUnique({ where: { id: fresh.resolvedById }, select: { fullName: true } }) : null;
    return `Уже решил ${who?.fullName ?? "другой модератор"}${fresh?.resolvedAt ? ` в ${formatDushanbe(fresh.resolvedAt)}` : ""}.`;
  };

  if (action === "pa" || action === "pr") {
    const claimed = await prisma.telegramPhotoBatch.updateMany({
      where: { id: batch.id, resolvedAt: null },
      data: { resolvedAt: new Date(), resolvedById: mod.id },
    });
    if (claimed.count === 0) {
      await reply(mod.chatId, await loserText());
      return;
    }
    let removed = 0;
    if (action === "pr") {
      try {
        removed = await removeBatchPhotos(batch.photoIds, batch.decisions as Record<string, string>, property, mod.id);
      } catch (err) {
        // Решение уже зафиксировано, а фото остались: повторный клик получил бы «Уже решил»,
        // и отклонённые фото навсегда оставались бы в выдаче сайта и публикациях
        // (CHANNEL-CROSSCHECK01). Возвращаем партию в разбор: удаление идемпотентно, повтор
        // добьёт то, что не удалилось.
        await prisma.telegramPhotoBatch
          .updateMany({ where: { id: batch.id, resolvedById: mod.id }, data: { resolvedAt: null, resolvedById: null } })
          .catch(() => {});
        void logSystemError(
          "telegram",
          `Модерация в Telegram: отклонённые фото объекта №${property.shortId} не удалены (${mod.fullName}), партия возвращена в разбор: ${err instanceof Error ? err.message : String(err)}`
        );
        await reply(mod.chatId, "Не удалось удалить фото, нажмите «Все ❌» ещё раз.");
        return;
      }
    }
    logAgentAudit(mod.id, action === "pa" ? "PROPERTY_PHOTOS_BATCH_APPROVED" : "PROPERTY_PHOTOS_BATCH_REJECTED", "Property", property.id, {
      source: "telegram",
      photoIds: batch.photoIds,
      removed,
    });
    await resolveMessages({ batchId: batch.id }, action === "pa" ? `✅ Фото приняты (${stamp})` : `❌ Фото отклонены: ${removed} (${stamp})`);
    return;
  }

  if (action === "p1") {
    if (batch.resolvedAt) {
      await reply(mod.chatId, await loserText());
      return;
    }
    const photos = await prisma.propertyPhoto.findMany({ where: { id: { in: batch.photoIds } }, select: { id: true, url: true } });
    for (const [i, id] of batch.photoIds.entries()) {
      const photo = photos.find((ph) => ph.id === id);
      if (!photo) continue;
      try {
        await sendPhotoFromDisk(mod.chatId, photoDiskPath(photo.url), `Фото ${i + 1} из ${batch.photoIds.length}`, [
          [
            { text: "✅", callback_data: `tm:po:${code}:${i}` },
            { text: "❌", callback_data: `tm:pn:${code}:${i}` },
          ],
        ]);
      } catch (err) {
        reportSendFailure(mod, `фото ${i + 1} №${property.shortId}`, err);
      }
      await sleep(SEND_PAUSE_MS);
    }
    return;
  }

  if ((action === "po" || action === "pn") && idx != null) {
    const photoId = batch.photoIds[idx];
    if (!photoId) return;
    // Решение по одному фото — атомарно: jsonb-ключ пишется, только если его ещё нет.
    const updated = await prisma.$executeRaw`
      UPDATE "TelegramPhotoBatch"
         SET "decisions" = "decisions" || jsonb_build_object(${photoId}::text, ${action === "po" ? "ok" : "no"}::text)
       WHERE "id" = ${batch.id} AND "resolvedAt" IS NULL AND NOT ("decisions" ? ${photoId}::text)`;
    if (updated === 0) {
      await reply(mod.chatId, batch.resolvedAt ? await loserText() : "По этому фото уже решили.");
      return;
    }
    if (action === "pn") {
      const photo = await prisma.propertyPhoto.findUnique({ where: { id: photoId } });
      if (photo) {
        try {
          await removePropertyPhoto(photo, property, mod.id);
        } catch (err) {
          // Та же беда, что у «Все ❌» выше: решение «нет» записано, а фото на месте, и
          // повторный клик отказал бы («По этому фото уже решили»). Снимаем ключ решения —
          // ровно его, пока партия не закрыта (CHANNEL-CROSSCHECK01).
          await prisma.$executeRaw`
            UPDATE "TelegramPhotoBatch" SET "decisions" = "decisions" - ${photoId}::text
             WHERE "id" = ${batch.id} AND "resolvedAt" IS NULL`.catch(() => {});
          void logSystemError(
            "telegram",
            `Модерация в Telegram: фото ${idx + 1} объекта №${property.shortId} не удалено (${mod.fullName}), решение снято: ${err instanceof Error ? err.message : String(err)}`
          );
          await reply(mod.chatId, `Фото ${idx + 1}: не удалось удалить, нажмите ❌ ещё раз.`);
          return;
        }
      }
    }
    logAgentAudit(mod.id, action === "po" ? "PROPERTY_PHOTO_APPROVED" : "PROPERTY_PHOTO_REJECTED", "Property", property.id, {
      source: "telegram",
      photoId,
    });
    const fresh = await prisma.telegramPhotoBatch.findUnique({ where: { id: batch.id } });
    const decisions = (fresh?.decisions ?? {}) as Record<string, string>;
    await reply(mod.chatId, `Фото ${idx + 1}: ${action === "po" ? "✅ принято" : "❌ удалено"}`);
    if (batch.photoIds.every((id) => decisions[id])) {
      const done = await prisma.telegramPhotoBatch.updateMany({
        where: { id: batch.id, resolvedAt: null },
        data: { resolvedAt: new Date(), resolvedById: mod.id },
      });
      if (done.count === 1) {
        const rejected = Object.values(decisions).filter((d) => d === "no").length;
        await resolveMessages({ batchId: batch.id }, `☑️ Разобрано по одному: принято ${batch.photoIds.length - rejected}, удалено ${rejected} (${stamp})`);
      }
    }
  }
}

async function removeBatchPhotos(
  photoIds: string[],
  decisions: Record<string, string>,
  property: NonNullable<Awaited<ReturnType<typeof prisma.property.findUnique>>>,
  actorId: string
): Promise<number> {
  // Уже принятые «по одному» не трогаем — отклоняем только нерешённые.
  const target = photoIds.filter((id) => decisions[id] !== "ok");
  const photos = await prisma.propertyPhoto.findMany({ where: { id: { in: target }, propertyId: property.id } });
  for (const photo of photos) await removePropertyPhoto(photo, property, actorId);
  return photos.length;
}

// Подписка на «объект встал на проверку» — при первой загрузке модуля
// (app.ts импортирует его ради этого побочного эффекта).
onPendingReview(notifyTelegramReview);
