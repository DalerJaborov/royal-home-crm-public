/**
 * ЧТО МОНТАЖЁР ВИДИТ В БОТЕ ПО ЛЮБОМУ ОБЪЕКТУ (25.09.2026, владелец: «добавь в
 * меню монтажёра полно функций, что нужно ему: чтобы вживую мог посмотреть любой
 * объект из очереди и так далее»).
 *
 * Здесь только ДАННЫЕ и ТЕКСТ — из базы, без отправки: кнопки и отправку делает
 * telegram/montajerBot.ts. Любой объект, кроме удалённых (как montajerCardText):
 * монтажёр должен суметь перечитать данные и после публикации — именно
 * невозможность перечитать стоила 19.09 перепутанных описаний двух квартир.
 * Каждый вид обязан честно отвечать и на объекте без фото, без видео и без
 * публикаций — «нет», а не падение и не молчание.
 */
import { channelLabel, publishedPostLink } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { TelegramInlineButton } from "../telegram/api.js";
import { EDITOR_HOLDER_WHERE, montajerCardText, orderedQueue, rawVideoDownloadLink, SOURCE_VIDEO_ORDER } from "./videoHandoff.js";
import { describeRawVideo } from "./rawVideoFacts.js";
import { crmPropertyUrl, humanFileSize } from "./telegramModeration.js";
import { dushanbeDateTimeString } from "./dushanbeTime.js";

export interface MontajerView {
  text: string;
  buttons?: TelegramInlineButton[][];
}

/** Сколько объектов очереди показывать списком и кнопками (Telegram: до 100 кнопок,
 *  но читаемо — около десятка). Остальное — «и ещё N». */
const QUEUE_VIEW_LIMIT = 10;
/** Сколько последних квитанций показывать по «✅ Что я сдал». */
const RECEIPTS_LIMIT = 10;

const HOUR_MS = 60 * 60 * 1000;

/** «25.09 14:30» по Душанбе — дата и время без года. */
export function dushanbeShortDateTime(at: Date): string {
  const [date, time] = dushanbeDateTimeString(at).split(" ");
  const [, month, day] = date!.split("-");
  return `${day}.${month} ${time}`;
}

function hoursSince(at: Date | null, now: Date): number | null {
  return at ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / HOUR_MS)) : null;
}

/** Кнопка «открыть в CRM» — только для https-адреса: Telegram отвергает всё
 *  сообщение целиком, если адрес кнопки ему не нравится (localhost, http). */
function crmButton(shortId: number): TelegramInlineButton | null {
  const url = crmPropertyUrl(shortId);
  return url.startsWith("https://") ? { text: "🔗 Открыть в CRM", url } : null;
}

/** Кнопки «📋 №…» по несколько в ряд. */
function objectButtons(shortIds: number[]): TelegramInlineButton[][] {
  const rows: TelegramInlineButton[][] = [];
  for (let i = 0; i < shortIds.length; i += 3) {
    rows.push(shortIds.slice(i, i + 3).map((n) => ({ text: `📋 №${n}`, callback_data: `mj:obj:${n}` })));
  }
  return rows;
}

type ObjectLineRow = {
  shortId: number;
  address: string | null;
  rooms: number | null;
  district: { name: string } | null;
  _count: { videos: number };
};

function objectLine(p: ObjectLineRow): string {
  const place = [p.district?.name, p.address?.trim()].filter(Boolean).join(", ");
  const parts = [`№${p.shortId}`, place || null, p.rooms ? `${p.rooms} комн.` : null, `видео: ${p._count.videos}`];
  return parts.filter(Boolean).join(" · ");
}

const OBJECT_LINE_SELECT = {
  id: true,
  shortId: true,
  address: true,
  rooms: true,
  district: { select: { name: true } },
  _count: { select: { videos: true } },
} as const;

/** «🗂 Очередь» — держатель и очередь с адресом и комнатами, кнопка на каждый. */
export async function montajerQueueView(now: Date = new Date()): Promise<MontajerView> {
  const [holder, queue, settings] = await Promise.all([
    prisma.property.findFirst({
      where: EDITOR_HOLDER_WHERE,
      orderBy: { videoHandoffSentAt: "asc" },
      select: { id: true, videoHandoffSentAt: true },
    }),
    orderedQueue(),
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { videoHandoffQueuePaused: true, videoHandoffQueuePauseReason: true },
    }),
  ]);
  const shown = queue.slice(0, QUEUE_VIEW_LIMIT);
  const ids = [...(holder ? [holder.id] : []), ...shown.map((q) => q.id)];
  const rows = ids.length
    ? await prisma.property.findMany({ where: { id: { in: ids } }, select: OBJECT_LINE_SELECT })
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  const lines = ["🗂 Очередь монтажа"];
  const buttonIds: number[] = [];
  const holderRow = holder ? byId.get(holder.id) : undefined;
  if (holderRow) {
    const hours = hoursSince(holder!.videoHandoffSentAt, now);
    lines.push(`В работе у вас: ${objectLine(holderRow)}${hours !== null ? ` (файлы ушли ${hours} ч назад)` : ""}`);
    buttonIds.push(holderRow.shortId);
  } else {
    lines.push("В работе у вас ничего нет.");
  }
  if (shown.length === 0) {
    lines.push("Дальше в очереди никого.");
  } else {
    lines.push("", "Дальше:");
    shown.forEach((q, i) => {
      const row = byId.get(q.id);
      lines.push(`${i + 1}) ${row ? objectLine(row) : `№${q.shortId}`}`);
      buttonIds.push(q.shortId);
    });
    if (queue.length > shown.length) lines.push(`… и ещё ${queue.length - shown.length}`);
  }
  if (settings?.videoHandoffQueuePaused) {
    lines.push(
      "",
      `⏸ Очередь на паузе — новые объекты пока не придут.${settings.videoHandoffQueuePauseReason ? ` Причина: ${settings.videoHandoffQueuePauseReason}.` : ""}`
    );
  }
  lines.push("", "Нажмите номер — откроется карточка объекта.");
  return { text: lines.join("\n"), buttons: objectButtons(buttonIds) };
}

/** «📋 Данные объекта №N» — те же факты, что в подписи к файлам, и кнопки по объекту. */
export async function montajerObjectView(shortId: number): Promise<MontajerView> {
  const [text, exists] = await Promise.all([
    montajerCardText(shortId),
    prisma.property.findFirst({ where: { shortId, deletedAt: null }, select: { id: true } }),
  ]);
  if (!exists) return { text };
  const crm = crmButton(shortId);
  return {
    text,
    buttons: [
      [
        { text: "🖼 Фото", callback_data: `mj:ph:${shortId}` },
        { text: "🎬 Исходники", callback_data: `mj:src:${shortId}` },
      ],
      [{ text: "📈 Где вышел", callback_data: `mj:pub:${shortId}` }, ...(crm ? [crm] : [])],
    ],
  };
}

export type MontajerPhotos =
  | { ok: true; shortId: number; photos: { url: string }[]; total: number }
  | { ok: false; text: string };

/** «🖼 Фото №N» — до 10 фото объекта (главное первым), для альбома. */
export async function montajerPhotos(shortId: number): Promise<MontajerPhotos> {
  const property = await prisma.property.findFirst({
    where: { shortId, deletedAt: null },
    select: { shortId: true, photos: { orderBy: { order: "asc" }, take: 10, select: { url: true } }, _count: { select: { photos: true } } },
  });
  if (!property) return { ok: false, text: `Объект №${shortId} не найден.` };
  if (property.photos.length === 0) return { ok: false, text: `У объекта №${shortId} нет фото.` };
  return { ok: true, shortId, photos: property.photos, total: property._count.photos };
}

/**
 * «🎬 Исходники №N» — список файлов с размером, длительностью, звуком и ссылкой
 * на скачивание. Файлы сами НЕ шлются (это гигабайты): «📥 Прислать файлами» —
 * отдельной кнопкой и только для объекта, который у монтажёра в работе.
 */
export async function montajerSourcesView(shortId: number): Promise<MontajerView & { holder: boolean }> {
  const property = await prisma.property.findFirst({
    where: { shortId, deletedAt: null },
    select: {
      id: true,
      videoHandoffStatus: true,
      videoHandoffManualSince: true,
      videos: { orderBy: SOURCE_VIDEO_ORDER, take: 100 },
    },
  });
  if (!property) return { text: `Объект №${shortId} не найден.`, holder: false };
  if (property.videos.length === 0) return { text: `У объекта №${shortId} нет исходных видео.`, holder: false };
  const total = property.videos.reduce((sum, v) => sum + v.sizeBytes, 0);
  const lines = [`🎬 Исходники объекта №${shortId} — ${property.videos.length} шт., ${humanFileSize(total)}`];
  property.videos.forEach((v, i) => {
    const facts = describeRawVideo(v);
    const sound = v.hasAudio === true ? "звук есть" : null;
    lines.push("", `${i + 1}. ${v.filename} — ${humanFileSize(v.sizeBytes)}${facts ? ` · ${facts}` : ""}${sound ? ` · ${sound}` : ""}`);
    const link = rawVideoDownloadLink(property.id, v.id);
    lines.push(link ? `Скачать: ${link}` : "Скачать — через карточку объекта в CRM (публичный адрес CRM не настроен).");
  });
  const holder = property.videoHandoffStatus === "SENT_TO_EDITOR" && !property.videoHandoffManualSince;
  return { text: lines.join("\n"), holder };
}

/** «📈 Где вышел №N» — сети, ссылки и, если ещё не вышел, когда и почему. */
export async function montajerPublishedText(shortId: number): Promise<string> {
  const property = await prisma.property.findFirst({
    where: { shortId, deletedAt: null },
    select: {
      publishedChannels: true,
      publishedPostIds: true,
      instagramUrl: true,
      scheduledPublishAt: true,
      scheduledPublishReason: true,
    },
  });
  if (!property) return `Объект №${shortId} не найден.`;
  const channels = property.publishedChannels ?? [];
  if (channels.length === 0) {
    const lines = [`Объект №${shortId} ещё нигде не опубликован.`];
    if (property.scheduledPublishAt) lines.push(`Публикация запланирована на ${dushanbeShortDateTime(property.scheduledPublishAt)}.`);
    if (property.scheduledPublishReason) lines.push(property.scheduledPublishReason);
    return lines.join("\n");
  }
  const lines = [`📈 Где вышел объект №${shortId}:`];
  for (const channel of channels) {
    const link = publishedPostLink(channel, property);
    lines.push(`• ${channelLabel(channel)} — ${link ?? "вышел (ссылки на пост нет)"}`);
  }
  return lines.join("\n");
}

/** «✅ Что я сдал» — последние квитанции о приёме с датами. */
export async function montajerReceiptsText(): Promise<string> {
  const receipts = await prisma.montajerMessage.findMany({
    where: { kind: "RECEIPT" },
    orderBy: { sentAt: "desc" },
    take: RECEIPTS_LIMIT,
    select: { sentAt: true, text: true, property: { select: { shortId: true } } },
  });
  if (receipts.length === 0) return "Квитанций о сданных роликах пока нет.";
  const lines = [`✅ Последние сданные ролики (${receipts.length}):`];
  for (const r of receipts) {
    const firstLine = r.text.split("\n")[0] ?? "";
    lines.push(`• ${dushanbeShortDateTime(r.sentAt)} — №${r.property.shortId}: ${firstLine}`);
  }
  return lines.join("\n");
}

/** «⏱ Сроки» — сколько держатель у монтажёра, сколько ждут остальные, пауза. */
export async function montajerDeadlinesText(now: Date = new Date()): Promise<string> {
  const [holder, queue, settings] = await Promise.all([
    prisma.property.findFirst({
      where: EDITOR_HOLDER_WHERE,
      orderBy: { videoHandoffSentAt: "asc" },
      select: { shortId: true, videoHandoffSentAt: true, videoHandoffDeliveredAt: true },
    }),
    orderedQueue(),
    prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { videoHandoffQueuePaused: true, videoHandoffQueuePauseReason: true, videoHandoffQueuePausedAt: true },
    }),
  ]);
  const lines = ["⏱ Сроки"];
  if (holder) {
    const hours = hoursSince(holder.videoHandoffSentAt, now);
    lines.push(
      `В работе у вас №${holder.shortId}${hours !== null ? `: файлы ушли ${hours} ч назад` : ""}${holder.videoHandoffDeliveredAt ? "" : " (ещё не все дошли — досылаю)"}.`
    );
  } else {
    lines.push("В работе у вас ничего нет.");
  }
  if (queue.length > 0) {
    const shown = queue.slice(0, QUEUE_VIEW_LIMIT);
    const rows = await prisma.property.findMany({
      where: { id: { in: shown.map((q) => q.id) } },
      select: { id: true, videoHandoffSentAt: true },
    });
    const since = new Map(rows.map((r) => [r.id, r.videoHandoffSentAt]));
    lines.push(`Ждут в очереди: ${queue.length}`);
    shown.forEach((q, i) => {
      const hours = hoursSince(since.get(q.id) ?? null, now);
      lines.push(`${i + 1}) №${q.shortId}${hours !== null ? ` — ждёт ${hours} ч` : ""}`);
    });
    if (queue.length > shown.length) lines.push(`… и ещё ${queue.length - shown.length}`);
  } else {
    lines.push("В очереди никого.");
  }
  if (settings?.videoHandoffQueuePaused) {
    const since = settings.videoHandoffQueuePausedAt ? ` с ${dushanbeShortDateTime(settings.videoHandoffQueuePausedAt)}` : "";
    lines.push(`⏸ Очередь на паузе${since}.${settings.videoHandoffQueuePauseReason ? ` Причина: ${settings.videoHandoffQueuePauseReason}.` : ""}`);
  }
  return lines.join("\n");
}
