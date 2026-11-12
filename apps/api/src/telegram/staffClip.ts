/**
 * РОЛИК ОТ СОТРУДНИКА В TELEGRAM (12.11.2026, решение владельца). Ролик снял не агент, а
 * СММщик или другой сотрудник: он присылает видео Шабнам, и ролик сам находит свой объект —
 * номер в подписи («№123», «123»), ссылка на объект из CRM или с сайта, иначе Шабнам
 * спрашивает кнопками (последние объекты) или словами (номер или адрес). Дальше две кнопки:
 *  - «Готов к выпуску» — тот же приём готового ролика, что у карточки CRM
 *    (lib/finalVideoIntake.ts → receiveEditedVideoFromFile: проверка ролика, модерация,
 *    слот публикации во всех сетях). У объекта уже есть вышедший ролик — «Заменить вышедший»:
 *    старые посты снимет публикация нового (VideoRemakeRequest replaceOldPostsOnPublish);
 *  - «Нужен монтаж» — файл ложится исходником объекта и уходит монтажёру существующей
 *    очередью (с озвучкой, как всегда: lib/narrationDelivery.ts).
 * «Сначала ролик от агента» не нужен. Права: сотрудник привязан к Telegram, учётка активна,
 * не «только чтение», не монтажёр (у него свой приём) и может вести этот объект
 * (canManagePropertyAs — то же правило, что у карточки). Агенту объекта — уведомление
 * «ролик добавил такой-то». Тот же файл второй раз (file_unique_id) не принимается.
 * «Не тот объект» — в течение часа после решения: откатывает ровно сделанное и спрашивает снова.
 * Состояние — строка StaffClipIntake (не TelegramDialogState: та одна на чат и занята мастером).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { formatPropertyCode, isReadOnlyRole, type PermissionId } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { loadAgentAccess } from "../auth/middleware.js";
import { canManagePropertyAs } from "../lib/propertyAccess.js";
import { acceptFinalVideoFromStaff, selfApprovedClipOptsFor } from "../lib/finalVideoIntake.js";
import {
  cancelVideoHandoffQueueEntry, discardReceivedFinalVideo, EDITOR_HOLDER_WHERE, queueVideoHandoff, receiveEditedVideoFromFile, resendSourceVideos,
} from "../lib/videoHandoff.js";
import { sendBackToMontajer } from "../lib/publishedVideoFix.js";
import { localVideoDelete, localVideoFilePath } from "../lib/localVideoStorage.js";
import { createNotification } from "../lib/notifications.js";
import { logAgentAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { isInsideTelegramFilesDir } from "../messengers/attachments.js";
import { videoHandoffDir } from "../upload.js";
import { declaredObjectNumber } from "./montajerFileNumber.js";
import { handoffReceiptText } from "./montajerReceive.js";
import {
  answerCallbackQuery, resolveTelegramFileMaterialization, sendMessage, sendMessageWithButtons, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
  type TelegramCallbackQuery, type TelegramIncomingMessage, type TelegramInlineButton,
} from "./api.js";

/** Сколько живёт вопрос «к какому объекту» и решение до кнопки. */
export const STAFF_CLIP_DECISION_TTL_MS = 24 * 3_600_000;
/** Окно кнопки «Не тот объект» после решения. */
export const STAFF_CLIP_UNDO_WINDOW_MS = 60 * 60_000;
/** Ответ словами на «к какому объекту» ждём столько. */
const ASK_TEXT_WINDOW_MS = 30 * 60_000;
const CLOSED = ["SOLD", "WITHDRAWN"];
const UUID = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";

type Actor = { id: string; fullName: string; role: string; can: (p: PermissionId) => boolean };
type PropertyRef = { id: string; shortId: number; address: string | null; assignedAgentId: string | null; intakeAgentId: string | null; createdById: string | null; deletedAt: Date | null; status: string };
const PROPERTY_REF = { id: true, shortId: true, address: true, assignedAgentId: true, intakeAgentId: true, createdById: true, deletedAt: true, status: true } as const;

async function actorFor(agentId: string, fullName: string): Promise<Actor | null> {
  const access = await loadAgentAccess(agentId);
  if (!access?.isActive || isReadOnlyRole(access.role) || access.role === "EDITOR") return null;
  return { id: agentId, fullName, role: access.role, can: (p) => access.permissions.has(p) };
}
const canManage = (actor: Actor, p: PropertyRef) => !p.deletedAt && canManagePropertyAs({ agentId: actor.id, can: actor.can }, p);

function incomingClip(msg: TelegramIncomingMessage): { fileId: string; fileUniqueId: string | null; filename: string; size: number | null } | null {
  const doc = msg.document && (msg.document.mime_type?.startsWith("video/") || /\.(?:mov|mp4|m4v|mkv|webm)$/iu.test(msg.document.file_name ?? "")) ? msg.document : undefined;
  if (doc) return { fileId: doc.file_id, fileUniqueId: doc.file_unique_id ?? null, filename: doc.file_name ?? "video.mp4", size: doc.file_size ?? null };
  const video = msg.video as (typeof msg.video & { file_unique_id?: string; file_name?: string }) | undefined;
  if (video) return { fileId: video.file_id, fileUniqueId: video.file_unique_id ?? null, filename: video.file_name ?? `video-${msg.message_id}.mp4`, size: video.file_size ?? null };
  return null;
}

/** Объект из подписи: номер в начале или «№123» где угодно, ссылка CRM (/properties/<id>) или сайта. */
export async function propertyFromCaption(filename: string | null, caption: string | null): Promise<PropertyRef | null> {
  const text = caption ?? "";
  const crm = new RegExp(`/(?:properties|listing/by-crm)/(${UUID})`, "iu").exec(text);
  if (crm) return prisma.property.findUnique({ where: { id: crm[1].toLowerCase() }, select: PROPERTY_REF });
  const site = /royalhome\.tj\/(?:(?:tg|en)\/)?(?:khona|listing)\/(\d{1,9})(?!\d)/iu.exec(text);
  if (site) return prisma.property.findFirst({ where: { siteListingId: Number(site[1]), deletedAt: null }, select: PROPERTY_REF });
  const number = declaredObjectNumber(null, text) ?? (/№\s*(\d{1,6})(?!\d)/u.exec(text) ? Number(/№\s*(\d{1,6})(?!\d)/u.exec(text)![1]) : null) ?? declaredObjectNumber(filename, null);
  if (number) return prisma.property.findFirst({ where: { shortId: number, deletedAt: null }, select: PROPERTY_REF });
  return null;
}

/** Последние объекты, которые этот сотрудник может вести: сначала стоящие в монтаже. */
async function recentCandidates(actor: Actor, excluded: string[]): Promise<PropertyRef[]> {
  const mine = actor.can("properties.editForeign") ? {} : { OR: [{ assignedAgentId: actor.id }, { intakeAgentId: actor.id }, { createdById: actor.id }] };
  const rows = await prisma.property.findMany({
    where: { deletedAt: null, status: { notIn: CLOSED as never }, id: { notIn: excluded }, ...mine },
    orderBy: [{ updatedAt: "desc" }], take: 5, select: PROPERTY_REF,
  });
  return rows;
}

function shortLabel(p: PropertyRef): string {
  const address = p.address?.trim();
  return address ? `${formatPropertyCode(p.shortId)} · ${address.slice(0, 40)}` : formatPropertyCode(p.shortId);
}
const jsonList = (v: Prisma.JsonValue | null | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

async function ask(chatId: string, intakeId: string, actor: Actor, excluded: string[], intro: string): Promise<void> {
  const candidates = await recentCandidates(actor, excluded);
  await prisma.staffClipIntake.update({ where: { id: intakeId }, data: { status: "ASKING", propertyId: null, candidates: candidates.map((c) => c.id) } });
  const buttons: TelegramInlineButton[][] = candidates.map((c) => [{ text: shortLabel(c), callback_data: `clip:p:${intakeId}:${c.shortId}` }]);
  buttons.push([{ text: "Отмена", callback_data: `clip:x:${intakeId}` }]);
  await sendMessageWithButtons(chatId, `${intro}\nВыберите объект кнопкой или напишите его номер или адрес.`, buttons);
}

async function offer(chatId: string, intakeId: string, p: PropertyRef): Promise<void> {
  const full = await prisma.property.findUnique({ where: { id: p.id }, select: { publishedChannels: true, instagramUrl: true } });
  const published = (full?.publishedChannels?.length ?? 0) > 0 || !!full?.instagramUrl;
  await prisma.staffClipIntake.update({ where: { id: intakeId }, data: { status: "CHOSEN", propertyId: p.id } });
  const buttons: TelegramInlineButton[][] = [
    [{ text: published ? "✅ Заменить вышедший ролик" : "✅ Готов к выпуску", callback_data: `clip:r:${intakeId}` }],
    [{ text: "✂️ Нужен монтаж", callback_data: `clip:m:${intakeId}` }],
    [{ text: "↩️ Не тот объект", callback_data: `clip:u:${intakeId}` }],
  ];
  const tail = published ? "\nУ объекта уже есть вышедший ролик: «Заменить» снимет старые посты, когда выйдет новый." : "";
  await sendMessageWithButtons(chatId, `🎬 Ролик для ${shortLabel(p)}. Что с ним сделать?${tail}`, buttons);
}

/** Видео от сотрудника (не монтажёра) в личке Шабнам. true — сообщение разобрано здесь. */
export async function handleStaffClipMessage(msg: TelegramIncomingMessage, agent: { id: string; fullName: string }): Promise<boolean> {
  if (msg.chat.type !== "private") return false;
  const clip = incomingClip(msg);
  if (!clip) return false;
  const actor = await actorFor(agent.id, agent.fullName);
  if (!actor) return false;
  const chatId = String(msg.chat.id);
  if (clip.fileUniqueId) {
    const dup = await prisma.staffClipIntake.findFirst({ where: { fileUniqueId: clip.fileUniqueId, status: { in: ["READY", "MONTAGE"] } }, orderBy: { createdAt: "desc" } });
    const dupProperty = dup?.propertyId ? await prisma.property.findUnique({ where: { id: dup.propertyId }, select: { shortId: true } }) : null;
    if (dup && dupProperty) {
      await sendMessage(chatId, `Этот ролик уже добавлен к ${formatPropertyCode(dupProperty.shortId)}. Второй раз не добавляю.`);
      return true;
    }
  }
  const caption = msg.caption ?? null;
  const intake = await prisma.staffClipIntake.create({ data: {
    chatId, agentId: agent.id, fileId: clip.fileId, fileUniqueId: clip.fileUniqueId, filename: clip.filename, caption, sizeBytes: clip.size,
    expiresAt: new Date(Date.now() + STAFF_CLIP_DECISION_TTL_MS),
  } });
  const found = await propertyFromCaption(clip.filename, caption);
  if (found && canManage(actor, found)) await offer(chatId, intake.id, found);
  else await ask(chatId, intake.id, actor, [], found ? `${formatPropertyCode(found.shortId)} вам недоступен.` : "🎬 Получила ролик. К какому объекту он?");
  return true;
}

/** Ответ словами на «к какому объекту» (30 минут): номер или часть адреса. true — наш ответ. */
export async function handleStaffClipText(msg: TelegramIncomingMessage, agent: { id: string; fullName: string }): Promise<boolean> {
  const text = (msg.text ?? "").trim();
  if (msg.chat.type !== "private" || !text || text.startsWith("/")) return false;
  const chatId = String(msg.chat.id);
  const pending = await prisma.staffClipIntake.findFirst({ where: { chatId, agentId: agent.id, status: "ASKING", updatedAt: { gte: new Date(Date.now() - ASK_TEXT_WINDOW_MS) } }, orderBy: { updatedAt: "desc" } });
  if (!pending) return false;
  const actor = await actorFor(agent.id, agent.fullName);
  if (!actor) return false;
  const excluded = jsonList(pending.excluded);
  const number = /^(?:№\s*)?(\d{1,6})$/u.exec(text)?.[1];
  const matches = number
    ? await prisma.property.findMany({ where: { shortId: Number(number), deletedAt: null }, select: PROPERTY_REF, take: 1 })
    : await prisma.property.findMany({ where: { deletedAt: null, status: { notIn: CLOSED as never }, address: { contains: text.slice(0, 80), mode: "insensitive" } }, select: PROPERTY_REF, orderBy: { updatedAt: "desc" }, take: 10 });
  const usable = matches.filter((p) => canManage(actor, p) && !excluded.includes(p.id)).slice(0, 5);
  if (usable.length === 1) { await offer(chatId, pending.id, usable[0]!); return true; }
  if (!usable.length) { await sendMessage(chatId, "Не нашла такой объект. Напишите номер объекта (например 123) или часть адреса."); return true; }
  await prisma.staffClipIntake.update({ where: { id: pending.id }, data: { candidates: usable.map((p) => p.id) } });
  await sendMessageWithButtons(chatId, "Нашла несколько. Какой из них?", [...usable.map((p) => [{ text: shortLabel(p), callback_data: `clip:p:${pending.id}:${p.shortId}` }]), [{ text: "Отмена", callback_data: `clip:x:${pending.id}` }]]);
  return true;
}

async function fileToTemp(fileId: string): Promise<string | null> {
  const material = await resolveTelegramFileMaterialization(fileId, TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES);
  if (!material) return null;
  const ext = material.kind === "path" ? path.extname(material.path) || ".mp4" : ".mp4";
  const tmpPath = path.join(videoHandoffDir, `staff-clip-${randomUUID()}${ext}`);
  try {
    if (material.kind === "path") await pipeline(fs.createReadStream(material.path), fs.createWriteStream(tmpPath));
    else await fs.promises.writeFile(tmpPath, material.buffer);
  } catch {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    return null;
  }
  if (material.kind === "path" && isInsideTelegramFilesDir(material.path)) await fs.promises.rm(material.path, { force: true }).catch(() => {});
  return tmpPath;
}

async function tellPropertyAgent(p: PropertyRef, actor: Actor, what: string): Promise<void> {
  const agentId = p.assignedAgentId ?? p.intakeAgentId ?? p.createdById;
  if (!agentId || agentId === actor.id) return;
  await createNotification({ agentId, kind: "task", title: "Ролик добавлен", body: `${formatPropertyCode(p.shortId)}: ролик добавил(а) ${actor.fullName}. ${what}`, url: `/properties/${p.id}`, tag: `staff-clip:${p.id}` });
}

type ReadyResult = { kind: "READY"; hadFinal: boolean; remakeRequestId: string | null };
type MontageResult = { kind: "MONTAGE"; videoId: string; storageKey: string; queued: boolean; sentBack: boolean };

async function doReady(intakeId: string, p: PropertyRef, actor: Actor, tmpPath: string, filename: string): Promise<string> {
  const before = await prisma.property.findUnique({ where: { id: p.id }, select: { shortId: true, videoHandoffStatus: true, videoHandoffManualSince: true, videoHandoffFinalPath: true, publishedChannels: true, instagramUrl: true } });
  if (!before) return "Объект не найден.";
  const published = (before.publishedChannels?.length ?? 0) > 0 || !!before.instagramUrl;
  // Замена вышедшего: старые посты снимет публикация нового (тот же механизм, что у перемонтажа).
  let remakeRequestId: string | null = null;
  if (published && !await prisma.videoRemakeRequest.findFirst({ where: { propertyId: p.id, replaceOldPostsOnPublish: true, oldPostsReplacedAt: null }, select: { id: true } })) {
    remakeRequestId = (await prisma.videoRemakeRequest.create({ data: { propertyId: p.id, reason: "NEW_FOOTAGE", requestedById: actor.id, replaceOldPostsOnPublish: true,
      comment: `Готовый ролик от ${actor.fullName} в Telegram заменяет вышедший.` } })).id;
  }
  const clipOpts = await selfApprovedClipOptsFor({ id: actor.id, role: actor.role, canModerate: actor.can("properties.moderate") });
  const outcome = await acceptFinalVideoFromStaff({
    property: { id: p.id, shortId: before.shortId, videoHandoffStatus: before.videoHandoffStatus, videoHandoffManualSince: before.videoHandoffManualSince },
    actorIsEditor: false, reopenDenied: null,
    receive: () => receiveEditedVideoFromFile(p.id, tmpPath, filename, clipOpts),
    onOpened: () => logAgentAudit(actor.id, "PROPERTY_FINAL_VIDEO_MANUAL", "Property", p.id, { shortId: before.shortId, source: "telegram-staff-clip" }),
  });
  if (!outcome.ok) {
    if (remakeRequestId) await prisma.videoRemakeRequest.deleteMany({ where: { id: remakeRequestId } });
    await prisma.staffClipIntake.update({ where: { id: intakeId }, data: { status: "CHOSEN" } });
    return `${formatPropertyCode(before.shortId)}: ролик не принят. ${outcome.error}`;
  }
  const result: ReadyResult = { kind: "READY", hadFinal: !!before.videoHandoffFinalPath, remakeRequestId };
  await prisma.staffClipIntake.update({ where: { id: intakeId }, data: { status: "READY", decidedAt: new Date(), result } });
  void tellPropertyAgent(p, actor, "Готов к выпуску.").catch(() => {});
  return handoffReceiptText(outcome.result, before.shortId);
}

async function doMontage(intakeId: string, p: PropertyRef, actor: Actor, tmpPath: string, filename: string): Promise<string> {
  const storageKey = `${p.id}/${randomUUID()}${path.extname(filename) || ".mp4"}`;
  const dest = localVideoFilePath(storageKey);
  if (!dest) return "Не получилось сохранить файл.";
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.copyFile(tmpPath, dest);
  const size = (await fs.promises.stat(dest)).size;
  // uploadKey — повтор той же кнопки не заведёт второй исходник.
  const video = await prisma.propertyVideo.upsert({ where: { uploadKey: `tg-staff-clip:${intakeId}` }, update: {},
    create: { propertyId: p.id, storageKey, filename, sizeBytes: Math.min(size, 2_147_483_647), uploadedById: actor.id, uploadKey: `tg-staff-clip:${intakeId}` } });
  if (video.storageKey !== storageKey) await localVideoDelete(storageKey).catch(() => false);
  const state = await prisma.property.findUnique({ where: { id: p.id }, select: { shortId: true, videoHandoffStatus: true, videoHandoffManualSince: true, videoHandoffFinalPath: true, publishedChannels: true, instagramUrl: true } });
  if (!state) return "Объект не найден.";
  const code = formatPropertyCode(state.shortId);
  let queued = false, sentBack = false, text: string;
  const hasHistory = !!state.videoHandoffFinalPath || (state.publishedChannels?.length ?? 0) > 0 || !!state.instagramUrl;
  if (state.videoHandoffStatus === "QUEUED") {
    text = `${code} уже в очереди монтажа — новый исходник уйдёт монтажёру вместе с ним.`;
  } else if (state.videoHandoffStatus === "SENT_TO_EDITOR" && !state.videoHandoffManualSince) {
    const holder = await prisma.property.findFirst({ where: EDITOR_HOLDER_WHERE, orderBy: { videoHandoffSentAt: "asc" }, select: { id: true } });
    if (holder?.id === p.id) await resendSourceVideos().catch(() => null);
    text = `${code} сейчас у монтажёра — досылаю ему новый исходник.`;
  } else if (hasHistory) {
    const published = (state.publishedChannels?.length ?? 0) > 0 || !!state.instagramUrl;
    const sent = await sendBackToMontajer(p.id, actor.id, "NEW_FOOTAGE", `Новые кадры от ${actor.fullName} (Telegram): смонтируйте заново.`, null, published ? { removeFromSocial: "on-new-video" } : {});
    sentBack = sent.ok;
    text = sent.ok ? `${code} ушёл монтажёру на новый монтаж с этим исходником.${published ? " Старые посты снимутся, когда выйдет новый ролик." : ""}` : `${code}: исходник сохранён, но монтажёру не ушёл: ${sent.error}`;
  } else {
    await queueVideoHandoff(p.id);
    const after = await prisma.property.findUnique({ where: { id: p.id }, select: { videoHandoffStatus: true } });
    queued = after?.videoHandoffStatus === "QUEUED" || after?.videoHandoffStatus === "SENT_TO_EDITOR";
    text = queued ? `${code} поставлен в очередь монтажа, монтажёр получит этот исходник (и озвучку, когда её одобрят).` : `${code}: исходник сохранён, но очередь монтажа сейчас не принимает (выключена или монтажёр не назначен).`;
  }
  const result: MontageResult = { kind: "MONTAGE", videoId: video.id, storageKey: video.storageKey, queued, sentBack };
  await prisma.staffClipIntake.update({ where: { id: intakeId }, data: { status: "MONTAGE", decidedAt: new Date(), result } });
  logAgentAudit(actor.id, "PROPERTY_VIDEOS_ADDED", "Property", p.id, { shortId: state.shortId, count: 1, source: "telegram-staff-clip" });
  void tellPropertyAgent(p, actor, "Ушёл монтажёру.").catch(() => {});
  return text;
}

/** Откатить «Готов» или «Монтаж» (окно — час). null — откат сделан; иначе — почему нельзя. */
async function undo(intake: { id: string; propertyId: string | null; result: Prisma.JsonValue | null }): Promise<string | null> {
  const result = intake.result as (ReadyResult | MontageResult | null);
  if (!intake.propertyId || !result) return null;
  if (result.kind === "READY") {
    if (result.hadFinal) return "У объекта до этого уже был готовый ролик — отменить замену здесь нельзя. Позовите администратора.";
    const discarded = await discardReceivedFinalVideo(intake.propertyId);
    if (!discarded.ok) return discarded.error;
    if (discarded.publishedChannels.length) return "Ролик уже успел выйти в сети — уберите его кнопкой «Убрать из соцсетей» в карточке.";
    if (result.remakeRequestId) await prisma.videoRemakeRequest.deleteMany({ where: { id: result.remakeRequestId, oldPostsReplacedAt: null } });
    return null;
  }
  if (result.sentBack) return "Объект уже ушёл монтажёру на новый монтаж — напишите монтажёру, отменить здесь нельзя.";
  const video = await prisma.propertyVideo.findUnique({ where: { id: result.videoId }, select: { montajerDeliveredAt: true } });
  if (video?.montajerDeliveredAt) return "Монтажёр уже получил этот файл — напишите ему, отменить здесь нельзя.";
  if (result.queued) {
    const p = await prisma.property.findUnique({ where: { id: intake.propertyId }, select: { videoHandoffStatus: true } });
    if (p?.videoHandoffStatus === "QUEUED") await cancelVideoHandoffQueueEntry(intake.propertyId);
  }
  await prisma.propertyVideo.deleteMany({ where: { id: result.videoId } });
  await localVideoDelete(result.storageKey).catch(() => false);
  return null;
}

const CALLBACK = /^clip:(r|m|u|x|p):([\da-f-]{36})(?::(\d{1,7}))?$/u;
/** `clip:r|m|u|x:<id>` и выбор объекта `clip:p:<id>:<номер>`. true — наша кнопка. */
export async function handleStaffClipCallback(query: TelegramCallbackQuery): Promise<boolean> {
  const match = CALLBACK.exec(query.data ?? "");
  if (!match) return false;
  const answer = (text?: string) => answerCallbackQuery(query.id, text).catch(() => {});
  const chat = query.message?.chat;
  if (chat?.type !== "private" || query.from?.id !== chat.id) { await answer(); return true; }
  const chatId = String(chat.id);
  const intake = await prisma.staffClipIntake.findUnique({ where: { id: match[2] } });
  const agent = intake ? await prisma.agent.findUnique({ where: { id: intake.agentId }, select: { id: true, fullName: true, telegramChatId: true } }) : null;
  const actor = agent && agent.telegramChatId === chatId ? await actorFor(agent.id, agent.fullName) : null;
  if (!intake || intake.chatId !== chatId || !actor) { await answer("Кнопка устарела"); return true; }
  const action = match[1];
  try {
    if (action === "x") {
      await prisma.staffClipIntake.updateMany({ where: { id: intake.id, status: { in: ["ASKING", "CHOSEN"] } }, data: { status: "CANCELLED" } });
      await answer("Отменено");
      return true;
    }
    if (action === "u") {
      const decided = intake.status === "READY" || intake.status === "MONTAGE";
      if (decided && (!intake.decidedAt || Date.now() - intake.decidedAt.getTime() > STAFF_CLIP_UNDO_WINDOW_MS)) { await answer("Прошло больше часа"); await sendMessage(chatId, "Прошло больше часа — отменить здесь нельзя. Позовите администратора."); return true; }
      if (!["CHOSEN", "READY", "MONTAGE"].includes(intake.status)) { await answer("Кнопка устарела"); return true; }
      if (decided) {
        // Захват отката: второй тап не откатывает дважды.
        const claimed = await prisma.staffClipIntake.updateMany({ where: { id: intake.id, status: intake.status }, data: { status: "UNDOING" } });
        if (!claimed.count) { await answer(); return true; }
        const refused = await undo(intake);
        if (refused) {
          await prisma.staffClipIntake.update({ where: { id: intake.id }, data: { status: intake.status } });
          await answer(); await sendMessage(chatId, refused); return true;
        }
      }
      const excluded = [...new Set([...jsonList(intake.excluded), ...(intake.propertyId ? [intake.propertyId] : [])])];
      await prisma.staffClipIntake.update({ where: { id: intake.id }, data: { excluded, decidedAt: null } });
      await answer();
      await ask(chatId, intake.id, actor, excluded, decided ? "Отменила. К какому объекту этот ролик?" : "Хорошо. К какому объекту этот ролик?");
      return true;
    }
    if (intake.expiresAt < new Date()) { await answer("Кнопка устарела"); await sendMessage(chatId, "Прошли сутки — пришлите ролик ещё раз."); return true; }
    if (action === "p") {
      if (intake.status !== "ASKING") { await answer("Кнопка устарела"); return true; }
      const p = await prisma.property.findFirst({ where: { shortId: Number(match[3]), deletedAt: null }, select: PROPERTY_REF });
      if (!p || !canManage(actor, p) || jsonList(intake.excluded).includes(p.id)) { await answer("Объект недоступен"); return true; }
      await answer();
      await offer(chatId, intake.id, p);
      return true;
    }
    // «Готов» / «Монтаж»: захват строки — двойной тап не примет ролик дважды.
    const claimed = await prisma.staffClipIntake.updateMany({ where: { id: intake.id, status: "CHOSEN" }, data: { status: "WORKING" } });
    if (!claimed.count || !intake.propertyId) { await answer("Уже выполняется"); return true; }
    const p = await prisma.property.findUnique({ where: { id: intake.propertyId }, select: PROPERTY_REF });
    if (!p || !canManage(actor, p)) { await prisma.staffClipIntake.update({ where: { id: intake.id }, data: { status: "CHOSEN" } }); await answer("Объект недоступен"); return true; }
    await answer(action === "r" ? "Принимаю ролик" : "Передаю монтажёру");
    const tmpPath = await fileToTemp(intake.fileId);
    if (!tmpPath) {
      await prisma.staffClipIntake.update({ where: { id: intake.id }, data: { status: "CHOSEN" } });
      await sendMessage(chatId, "Не получилось скачать ролик из Telegram — пришлите его ещё раз.");
      return true;
    }
    try {
      const text = action === "r" ? await doReady(intake.id, p, actor, tmpPath, intake.filename) : await doMontage(intake.id, p, actor, tmpPath, intake.filename);
      const done = await prisma.staffClipIntake.findUnique({ where: { id: intake.id }, select: { status: true } });
      const undoButton = done && (done.status === "READY" || done.status === "MONTAGE") ? [[{ text: "↩️ Не тот объект (в течение часа)", callback_data: `clip:u:${intake.id}` }]] : [];
      if (undoButton.length) await sendMessageWithButtons(chatId, text, undoButton);
      else await sendMessage(chatId, text);
    } finally {
      await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    }
  } catch (err) {
    void logSystemError("telegram", `Ролик от сотрудника: ${describeError(err)}`, { dedupKey: "staff-clip" });
    await prisma.staffClipIntake.updateMany({ where: { id: intake.id, status: "WORKING" }, data: { status: "CHOSEN" } }).catch(() => {});
    await answer();
    await sendMessage(chatId, "Не получилось, попробуйте ещё раз.").catch(() => {});
  }
  return true;
}
