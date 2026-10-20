import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { SellerObjectFacts } from "@royal-home/shared";
import type { Prisma, PropertyDraftMedia } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { privateFilePath } from "./privateFiles.js";
import { sharpFromUpload } from "./heicInput.js";
import { uploadsDir, thumbsDir } from "../upload.js";
import { localVideoUpload } from "./localVideoStorage.js";
import { videoExtensionOf } from "./videoFileExtension.js";
import { logSystemError } from "./systemError.js";
import { matchesUniqueConstraint } from "./prismaUniqueConflict.js";
import { enqueueBackgroundJob } from "../jobs/enqueue.js";
import { DraftConflictError, assertActiveDraft, withDraftLock } from "../routes/properties/draftLifecycle.js";

interface DraftCopyGuard { agentId?: string; sellerClientId?: string; maxPhotos: number; maxVideos: number }

async function storeDraftAttachment(data: Prisma.PropertyDraftMediaUncheckedCreateInput, guard: DraftCopyGuard): Promise<PropertyDraftMedia> {
  const owner = guard.agentId ?? (await prisma.propertyDraft.findUnique({ where: { id: data.draftId }, select: { agentId: true } }))?.agentId;
  if (!owner) throw new DraftConflictError(null);
  return withDraftLock(owner, async (tx) => {
    const draft = await assertActiveDraft(tx, owner, { draftId: data.draftId });
    if (guard.sellerClientId && (!draft.values || typeof draft.values !== "object" || Array.isArray(draft.values) || draft.values.sellerClientId !== guard.sellerClientId)) throw new DraftConflictError(draft);
    const count = await tx.propertyDraftMedia.count({ where: { draftId: draft.id, kind: data.kind } });
    if (count >= (data.kind === "PHOTO" ? guard.maxPhotos : guard.maxVideos)) throw new DraftConflictError(draft, "В черновике достигнут предел файлов");
    return tx.propertyDraftMedia.create({ data: { ...data, order: count } });
  });
}

/**
 * ВЛОЖЕНИЯ ПРОДАВЦА ИЗ ПЕРЕПИСКИ И ИХ ПЕРЕЕЗД В ЧЕРНОВИК МАСТЕРА (21.09.2026,
 * «Объект продавца заполняется сам» — agent-brief.md, задание МЕДИА).
 *
 * Три источника переписки, как и везде в репозитории (findAttachmentOwnerClientId
 * в lib/privateFiles.ts, тот же список): BotConversation (Instagram/Facebook/
 * WhatsApp через бот-платформу), TelegramConversation (личка с ботом),
 * TelegramDirectConversation (Direct Messages канала). Вложение живёт ВНУТРИ
 * реплики (jsonb `messages`), своей таблицы у вложений в базе нет.
 *
 * ПОЧЕМУ ТОЛЬКО role="user". Вложения бота (`url`, ссылка на /uploads) — это
 * фотографии НАШИХ объектов, которые бот сам показал продавцу в разговоре про
 * что-то другое; они не имеют отношения к его собственной квартире и не должны
 * попадать в черновик как «фото объекта». У клиента вложение приходит только
 * полем `file` (закрытое хранилище, lib/privateFiles.ts) — см. докстринг
 * StoredAttachment в ai/shared.ts.
 */

/** Фото и видео — единственные два вида вложений, которые годятся в черновик
 *  объекта; голосовые и документы (kind "audio"/"file") сюда не идут — их
 *  разбирает агент ФАКТОВ как ТЕКСТ (расшифровка), а не как медиа объекта. */
export interface SellerAttachment {
  /** sha256 содержимого файла (hex) — ключ дедупликации и кэша оценки фото
   *  (ChatPhotoInsight), а не имя файла: один и тот же снимок мог прийти под
   *  разными именами (пересылка, сохранение из галереи). */
  sha256: string;
  kind: "image" | "video";
  /** Имя в закрытом хранилище (uploads-private) — то же, что StoredAttachment.file. */
  file: string;
  mime: string;
  /** Когда сказана реплика (ISO) — сортировка по умолчанию и запасной порядок
   *  для снимков, которых ещё не видела оценка (ChatPhotoInsight). Может
   *  отсутствовать: у реплик до 01.08.2026 поля `at` не было. */
  at: string | null;
}

interface RawMessage {
  role?: string;
  at?: string;
  attachments?: { kind?: string; file?: string; mime?: string }[];
}

/** Три таблицы диалога, где может лежать вложение клиента — тот же список, что
 *  у findAttachmentOwnerClientId (lib/privateFiles.ts), намеренно не переиспользован
 *  оттуда: та функция ищет ОДНО вложение по имени файла (LIKE по jsonb::text),
 *  здесь нужны ВСЕ вложения клиента с разбором каждой реплики. */
async function loadConversationMessages(clientId: string): Promise<RawMessage[]> {
  const [bot, tg, tgDirect] = await Promise.all([
    prisma.botConversation.findMany({ where: { clientId }, select: { messages: true } }),
    prisma.telegramConversation.findMany({ where: { clientId }, select: { messages: true } }),
    prisma.telegramDirectConversation.findMany({ where: { clientId }, select: { messages: true } }),
  ]);
  const all: RawMessage[] = [];
  for (const conv of [...bot, ...tg, ...tgDirect]) {
    if (Array.isArray(conv.messages)) all.push(...(conv.messages as RawMessage[]));
  }
  return all;
}

/** Читает файл из закрытого хранилища и считает sha256 содержимого. null — файла
 *  нет на диске (запись в переписке осталась, а файл уборка уже удалила по
 *  сроку хранения — RETENTION_DAYS в lib/privateFiles.ts, обычное дело). */
async function hashPrivateFile(name: string): Promise<{ sha256: string; size: number } | null> {
  const full = privateFilePath(name);
  if (!full) return null;
  try {
    const buf = await fs.readFile(full);
    return { sha256: createHash("sha256").update(buf).digest("hex"), size: buf.length };
  } catch {
    return null;
  }
}

/**
 * Все вложения клиента-продавца (фото и видео), по времени, без дублей по
 * содержимому. Читает диск (хэш каждого файла), поэтому зовётся только по
 * явному действию агента (кнопка «Добавить объект» в чате) — НЕ на пассивном
 * открытии экрана, и ИИ здесь не участвует вовсе (правило экономии токенов §1).
 */
export async function listSellerAttachments(clientId: string): Promise<SellerAttachment[]> {
  const messages = await loadConversationMessages(clientId);
  const result: SellerAttachment[] = [];
  const seenSha256 = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.attachments)) continue;
    for (const att of msg.attachments) {
      if ((att.kind !== "image" && att.kind !== "video") || !att.file) continue;
      const hashed = await hashPrivateFile(att.file);
      if (!hashed) continue;
      if (seenSha256.has(hashed.sha256)) continue;
      seenSha256.add(hashed.sha256);
      result.push({
        sha256: hashed.sha256,
        kind: att.kind,
        file: att.file,
        mime: att.mime || "application/octet-stream",
        at: typeof msg.at === "string" ? msg.at : null,
      });
    }
  }

  // Реплики внутри одного диалога уже идут по возрастанию времени (так их
  // дописывает messengers/appendMessages.ts), но диалогов у клиента может быть
  // несколько (Instagram + WhatsApp + Telegram сразу) — сортируем итог общим
  // ключом. Вложения без `at` (реплики до 01.08.2026) остаются в конце в
  // исходном порядке — Array.prototype.sort стабилен.
  result.sort((a, b) => {
    if (!a.at && !b.at) return 0;
    if (!a.at) return 1;
    if (!b.at) return -1;
    return a.at.localeCompare(b.at);
  });
  return result;
}

export const SELLER_PHOTO_INSIGHT_JOB_TYPE = "seller-photo-insight";

/**
 * Ставит фоновую оценку новых фото продавца (jobs/sellerPhotoInsight.ts).
 *
 * Debounce тем же приёмом, что у разбора фактов (agent-brief.md §2): отложенный
 * старт +15 минут и dedupeKey на клиента — пачка сообщений, пришедшая за
 * несколько минут (продавец прислал десять фото подряд), схлопывается в один
 * вызов вместо одного вызова на каждое фото. В отличие от разбора фактов
 * самопереустановка задания здесь не нужна: оценка идемпотентна по sha256
 * (см. jobs/sellerPhotoInsight.ts) — если пока джоб ждал, пришли ещё фото, он
 * просто увидит больше новых кадров при своём единственном запуске и разберёт их
 * несколькими пачками подряд (до MAX_BATCHES_PER_RUN), а не потеряет.
 *
 * Зовёт агент ФАКТОВ тем же событием, что и разбор фактов (новое входящее
 * сообщение продавца / голосовое расшифровано / звонок расшифрован) — см.
 * scheduleSellerFactsRefresh.
 */
export function scheduleSellerPhotoInsights(clientId: string): void {
  void enqueueBackgroundJob({
    type: SELLER_PHOTO_INSIGHT_JOB_TYPE,
    payload: { clientId },
    dedupeKey: `seller-photo-insight:${clientId}`,
    runAt: new Date(Date.now() + 15 * 60_000),
    maxAttempts: 2,
  });
}

export interface SellerMediaCopyResult {
  photosAdded: number;
  videosAdded: number;
  /** Пропущено: чужой ключ загрузки (файл уже в чьём-то другом черновике),
   *  упёрлись в потолок MAX_DRAFT_PHOTOS/VIDEOS или файл не прочитался с диска. */
  skipped: number;
}

/** Расширение по MIME для копии видео — тот же список контейнеров, что и белый
 *  список видео мессенджеров (messengers/attachments.ts::VIDEO_TYPES), плюс
 *  запасной путь по имени файла на случай неизвестного типа. */
function videoExtension(mime: string, filename: string): string {
  const byMime: Record<string, string> = {
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
    "video/3gpp": "3gp",
    "video/mpeg": "mpeg",
  };
  // Не по mime — расширение имени, но только из белого списка (D15, 02.10.2026):
  // раньше бралось как есть, а пустое давало ключ с хвостовой точкой.
  return byMime[mime] ?? (videoExtensionOf(filename) ?? ".mp4").replace(/^\./, "");
}

/** Снимок → тот же конвейер sharp, что и у обычной загрузки в черновик
 *  (routes/properties/drafts.ts POST /drafts/current/photos): один decode,
 *  webp 2560 полная версия + webp 800 миниатюра, оба в общей папке uploads. */
async function copyPhotoAttachment(
  draftId: string,
  attachment: SellerAttachment,
  order: number,
  guard: DraftCopyGuard
): Promise<PropertyDraftMedia | null> {
  const full = privateFilePath(attachment.file);
  if (!full) return null;
  let buf: Buffer;
  try {
    buf = await fs.readFile(full);
  } catch {
    return null;
  }

  const filename = `${randomUUID()}.webp`;
  try {
    const pipeline = (await sharpFromUpload(buf)).rotate();
    await pipeline
      .clone()
      .resize(2560, 2560, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(path.join(uploadsDir, filename));
    await pipeline
      .clone()
      .resize(800, undefined, { withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(thumbsDir, filename));
  } catch (err) {
    void logSystemError(
      "storage",
      `Не удалось обработать фото продавца из переписки (${attachment.file}): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  try {
    return await storeDraftAttachment({
        draftId,
        kind: "PHOTO",
        status: "READY",
        // Ключ повторной отправки — sha256 содержимого, а не uuid: повторный вызов
        // POST /drafts/from-client/:clientId на том же клиенте обязан узнать уже
        // скопированное фото и не плодить вторую копию (agent-brief.md, п.2).
        uploadKey: `chat:${attachment.sha256}`,
        filename: attachment.file,
        contentType: attachment.mime,
        sizeBytes: buf.length,
        order,
        url: `/uploads/${filename}`,
        thumbUrl: `/uploads/thumbs/${filename}`,
    }, guard);
  } catch (err) {
    // Гонка: тот же sha256 успел записать параллельный вызов (два клика по
    // кнопке «Добавить объект» подряд) — файлы на диске уже не нужны.
    await fs.unlink(path.join(uploadsDir, filename)).catch(() => undefined);
    await fs.unlink(path.join(thumbsDir, filename)).catch(() => undefined);
    if (matchesUniqueConstraint(err, "uploadKey")) return null;
    throw err;
  }
}

/** Ролик → копия байт в закрытое хранилище черновика (lib/localVideoStorage.ts),
 *  тот же формат ключа `<id черновика>/<uuid>.<ext>`, что и у ролика, снятого
 *  прямо в мастере (routes/properties/drafts.ts). Файл уже готов (клиент снял и
 *  прислал целиком) — многочастевая докачка тут ни при чём. */
async function copyVideoAttachment(
  draftId: string,
  attachment: SellerAttachment,
  order: number,
  guard: DraftCopyGuard
): Promise<PropertyDraftMedia | null> {
  const full = privateFilePath(attachment.file);
  if (!full) return null;
  let buf: Buffer;
  try {
    buf = await fs.readFile(full);
  } catch {
    return null;
  }

  const ext = videoExtension(attachment.mime, attachment.file);
  const storageKey = `${draftId}/${randomUUID()}.${ext}`;
  try {
    await localVideoUpload(storageKey, buf);
  } catch (err) {
    void logSystemError(
      "storage",
      `Не удалось скопировать видео продавца из переписки (${attachment.file}): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }

  try {
    return await storeDraftAttachment({
        draftId,
        kind: "VIDEO",
        status: "READY",
        uploadKey: `chat:${attachment.sha256}`,
        filename: attachment.file,
        contentType: attachment.mime,
        sizeBytes: buf.length,
        order,
        storageKey,
    }, guard);
  } catch (err) {
    const { localVideoDelete } = await import("./localVideoStorage.js");
    await localVideoDelete(storageKey).catch(() => undefined);
    if (matchesUniqueConstraint(err, "uploadKey")) return null;
    throw err;
  }
}

/**
 * Порядок кандидатов в обложку: лучший score из кэша ChatPhotoInsight первым,
 * распознанные планировки — в конец списка. Снимки без оценки (кэш ещё не
 * посчитал — оценка фоновая и не блокирует этот запрос, правило §1) остаются
 * обычными кандидатами и сортируются как «нет оценки», то есть ниже любого
 * оценённого, но выше любой планировки — до первой оценки порядок просто
 * хронологический, что и так разумно.
 */
async function orderPhotosByInsight(attachments: SellerAttachment[]): Promise<SellerAttachment[]> {
  if (attachments.length === 0) return attachments;
  const insights = await prisma.chatPhotoInsight.findMany({
    where: { sha256: { in: attachments.map((a) => a.sha256) } },
  });
  const bySha = new Map(insights.map((i) => [i.sha256, i]));
  const withInsight = attachments.map((a) => ({ a, insight: bySha.get(a.sha256) ?? null }));
  const plans = withInsight.filter((x) => x.insight?.isPlan);
  const rest = withInsight.filter((x) => !x.insight?.isPlan);
  rest.sort((x, y) => (y.insight?.score ?? -1) - (x.insight?.score ?? -1));
  return [...rest, ...plans].map((x) => x.a);
}

/**
 * Копирует вложения продавца в черновик мастера, идемпотентно по sha256.
 *
 * `limits` приходит от вызывающего (routes/properties/drafts.ts) — там уже
 * живут MAX_DRAFT_PHOTOS/MAX_DRAFT_VIDEOS, заводить им дубликат здесь значило
 * бы держать один и тот же потолок в двух местах с риском разойтись.
 */
export async function copySellerAttachmentsToDraft(
  draftId: string,
  attachments: SellerAttachment[],
  limits: DraftCopyGuard
): Promise<SellerMediaCopyResult> {
  const chatKeys = attachments.map((a) => `chat:${a.sha256}`);
  const already = chatKeys.length
    ? await prisma.propertyDraftMedia.findMany({
        where: { uploadKey: { in: chatKeys } },
        select: { uploadKey: true, draftId: true },
      })
    : [];
  const mineKeys = new Set(already.filter((m) => m.draftId === draftId).map((m) => m.uploadKey));
  // Тот же файл уже лежит в ЧУЖОМ черновике (другой агент нажал кнопку раньше,
  // его черновик ещё не истёк) — пропускаем молча, как и одиночная загрузка
  // фото черновика отвечает 409 на чужой ключ, только здесь без ответа: это
  // пакетная синхронизация, а не одиночная отправка одного файла.
  const foreignKeys = new Set(already.filter((m) => m.draftId !== draftId).map((m) => m.uploadKey));
  // Тот же файл уже переехал в ЖИВОЙ объект (глубокая проверка 02.10.2026, D2):
  // продавец прислал фото квартиры А, из них собран объект А, через неделю он же
  // шлёт фото квартиры Б — listSellerAttachments отдаёт вложения ВСЕХ переписок
  // клиента, и снимки А снова попадали бы в черновик Б. Таблица черновиков их уже
  // не помнит (черновик А удалён при переносе), ключи живут в PropertyPhoto /
  // PropertyVideo. Снимки объекта в Корзине НЕ считаем чужими: агент собирает
  // объект заново, и терять его фото незачем (ключ при переносе отдаст
  // attachDraftToProperty, см. draftAttach.ts).
  if (chatKeys.length) {
    const live = { uploadKey: { in: chatKeys }, property: { deletedAt: null } };
    const [inPhotos, inVideos] = await Promise.all([
      prisma.propertyPhoto.findMany({ where: live, select: { uploadKey: true } }),
      prisma.propertyVideo.findMany({ where: live, select: { uploadKey: true } }),
    ]);
    for (const m of [...inPhotos, ...inVideos]) if (m.uploadKey) foreignKeys.add(m.uploadKey);
  }

  const [existingPhotoCount, existingVideoCount] = await Promise.all([
    prisma.propertyDraftMedia.count({ where: { draftId, kind: "PHOTO" } }),
    prisma.propertyDraftMedia.count({ where: { draftId, kind: "VIDEO" } }),
  ]);

  const isNew = (a: SellerAttachment) => !mineKeys.has(`chat:${a.sha256}`) && !foreignKeys.has(`chat:${a.sha256}`);
  const newPhotos = await orderPhotosByInsight(attachments.filter((a) => a.kind === "image" && isNew(a)));
  const newVideos = attachments.filter((a) => a.kind === "video" && isNew(a));

  let photosAdded = 0;
  let videosAdded = 0;
  let skipped = foreignKeys.size;

  const photoRoom = Math.max(0, limits.maxPhotos - existingPhotoCount);
  for (const a of newPhotos.slice(0, photoRoom)) {
    const created = await copyPhotoAttachment(draftId, a, existingPhotoCount + photosAdded, limits);
    if (created) photosAdded++;
    else skipped++;
  }
  skipped += Math.max(0, newPhotos.length - photoRoom);

  const videoRoom = Math.max(0, limits.maxVideos - existingVideoCount);
  for (const a of newVideos.slice(0, videoRoom)) {
    const created = await copyVideoAttachment(draftId, a, existingVideoCount + videosAdded, limits);
    if (created) videosAdded++;
    else skipped++;
  }
  skipped += Math.max(0, newVideos.length - videoRoom);

  return { photosAdded, videosAdded, skipped };
}

/**
 * Значения черновика мастера из фактов продавца (WizardValues в
 * apps/web/src/components/property-wizard/types.ts — все поля строками, кроме
 * lat/lng, ровно как хранит propertyWizardDraftValuesSchema). Пишутся ТОЛЬКО
 * заполненные поля: «продавец этого не говорил» остаётся дырой в объекте, а не
 * затирает то, что агент, может быть, уже успел набрать руками.
 *
 * `landAreaSotka`/`documentsPreset`/`documentsOther` полей пока нет в
 * propertyWizardDraftValuesSchema (агент ИНТЕРФЕЙСА добавит первое, документы
 * сервер и так не валидирует строго — см. докстринг схемы: JSON пишет
 * прошлая версия кода, читает будущая) — пишем их уже сейчас, вкладка подберёт
 * знакомые поля, а незнакомые молча игнорирует до своего выката.
 */
export function sellerFactsToDraftValues(
  facts: SellerObjectFacts | null,
  clientId: string
): Prisma.InputJsonValue {
  const values: Record<string, unknown> = { sellerClientId: clientId };
  if (!facts) return values as Prisma.InputJsonValue;

  if (facts.type) values.type = facts.type;
  if (facts.rooms != null) values.rooms = String(facts.rooms);
  if (facts.areaSqm != null) values.areaSqm = String(facts.areaSqm);
  if (facts.landAreaSotka != null) values.landAreaSotka = String(facts.landAreaSotka);
  if (facts.floor != null) values.floor = String(facts.floor);
  if (facts.totalFloors != null) values.totalFloors = String(facts.totalFloors);
  if (facts.windowCount != null) values.windowCount = String(facts.windowCount);
  if (facts.price != null) values.price = String(facts.price);
  if (facts.currency) values.currency = facts.currency;
  if (facts.condition) values.condition = facts.condition;
  if (facts.marketType) values.marketType = facts.marketType;
  if (facts.districtId) values.districtId = facts.districtId;
  if (facts.address) values.address = facts.address;
  if (facts.lat != null) values.lat = facts.lat;
  if (facts.lng != null) values.lng = facts.lng;
  if (facts.documents) {
    values.documentsPreset = "Другое";
    values.documentsOther = facts.documents.slice(0, 500);
  }
  if (facts.description) values.sellerDescription = facts.description;

  return values as Prisma.InputJsonValue;
}

/** Поля карточки продавца, из которых можно начать объект. */
export type SellerCardPrefill = {
  desiredType: string | null;
  desiredRooms: number | null;
  desiredAreaMin: number | null;
  desiredFloorMin: number | null;
  desiredFloorMax: number | null;
  desiredTotalFloors: number | null;
  desiredDistrictId: string | null;
  budgetMin: { toString(): string } | null;
  budgetMax: { toString(): string } | null;
  currency: string | null;
  address: string | null;
};

/**
 * ЗНАЧЕНИЯ ЧЕРНОВИКА ИЗ САМОЙ КАРТОЧКИ ПРОДАВЦА (23.09.2026, аудит к стабильной
 * версии). Карточка «Добавить объект» открывала старую форму без видео, потому
 * что только она подставляла поля карточки. Теперь она ведёт в мастер, и те же
 * поля подставляет сервер: у продавца, заведённого руками, переписки нет, и
 * sellerFactsToDraftValues вернул бы пустой черновик. Правило подстановки то же,
 * что было в старой форме (ClientDetail → PropertyFormModal.fromSeller): цена —
 * верхняя граница, этаж — нижняя, если есть.
 */
export function sellerCardToDraftValues(card: SellerCardPrefill): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (card.desiredType) values.type = card.desiredType;
  if (card.desiredRooms != null) values.rooms = String(card.desiredRooms);
  if (card.desiredAreaMin != null) values.areaSqm = String(card.desiredAreaMin);
  const floor = card.desiredFloorMin ?? card.desiredFloorMax;
  if (floor != null) values.floor = String(floor);
  if (card.desiredTotalFloors != null) values.totalFloors = String(card.desiredTotalFloors);
  const price = card.budgetMax ?? card.budgetMin;
  if (price != null) values.price = price.toString();
  if (card.currency) values.currency = card.currency;
  if (card.desiredDistrictId) values.districtId = card.desiredDistrictId;
  if (card.address?.trim()) values.address = card.address.trim();
  return values;
}
