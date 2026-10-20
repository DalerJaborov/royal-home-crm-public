import { prisma } from "../db.js";

/**
 * ДЕТЕКТОР «НОМЕР ЗАПРОШЕН — ЗАГЛОХЛО» (mission-control, фаза 2, п.1а жалобы
 * `docs/razbor-zhaloby-admina-31-08-2026.md`): владелец хочет видеть, где
 * агент/бот попросил у клиента номер, а продолжения нет — «проверить, как
 * там на самом деле идёт разговор».
 *
 * ГДЕ ИСКАТЬ. `Client.phone` — обязательное уникальное поле (schema.prisma:1280):
 * карточка клиента физически не может существовать без номера. Значит «номер
 * так и не пришёл» — это не про уже заведённую карточку, а про диалог
 * (BotConversation/TelegramConversation), который ЕЩЁ НЕ привязан к клиенту
 * (clientId === null) — ровно тот момент до интейка, когда бот и спрашивает
 * номер, чтобы завести карточку.
 *
 * ЧТО СЧИТАЕМ «ЗАГЛОХЛО». `messages` — [{role, content}] без своих таймстампов
 * (см. комментарий у поля в schema.prisma), а `lastMessageAt` — момент
 * последнего ВХОДЯЩЕГО (от клиента) сообщения. Если диалог кончается репликой
 * бота с просьбой номера и клиент больше не написал, `lastMessageAt` так и
 * остаётся на последнем его сообщении ДО этой реплики — то есть время,
 * прошедшее с `lastMessageAt`, с точностью до секунд ответа бота и есть время
 * молчания после запроса. Этого достаточно для v1: не нужен отдельный
 * таймстамп на реплику, чтобы поймать «спросили — тишина».
 *
 * НЕ NLP, А КЛЮЧЕВЫЕ СЛОВА (по образцу caller — как и остальные детекторы
 * первой линии, keyword-проверка достаточна для v1; аудит `razbor-30-08-2026`
 * отмечал, что готовый `clientPhone.ts` ловит номер УЖЕ НАПИСАННЫЙ, а не
 * НАМЕРЕНИЕ его запросить — поэтому здесь отдельный, узкий словарь).
 */
const PHONE_ASK_RE =
  /(остав(ь|ьте)\s*(свой\s*)?ном|напиш[а-я]*\s*(свой\s*)?ном|скинь\s*(свой\s*)?ном|скиньте\s*(свой\s*)?ном|отправ[а-я]*\s*(свой\s*)?(ном|телефон)|дайте\s*(свой\s*)?ном|ваш\s*ном|ваш\s*телефон|номер\s*телефона|телефон[а-я]*\s*оставьте|рақам|раками)/iu;

const HOUR_MS = 3_600_000;
/** Окно поиска — 48ч (задание): диалог старше — уже не «свежая» тревога, потерян в потоке. */
const WINDOW_HOURS = 48;
const RESULT_CAP = 50;

interface RawMessage {
  role?: string;
  content?: unknown;
}

function lastMessageAsksForPhone(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const last = messages[messages.length - 1] as RawMessage;
  if (!last || last.role !== "assistant" || typeof last.content !== "string") return false;
  return PHONE_ASK_RE.test(last.content);
}

export interface StaleContactRequestItem {
  id: string;
  conversationId: string;
  channel: string;
  name: string | null;
  askedAt: Date;
  hoursSince: number;
}

async function loadThresholdHours(): Promise<number> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { staleContactRequestHours: true },
  });
  return s?.staleContactRequestHours ?? 18;
}

/**
 * Диалоги, где последнее слово было за ботом/агентом («оставьте номер»), клиент
 * так и не привязался к карточке (clientId===null, то есть номера не дал), и
 * с его последнего сообщения прошло больше порога, но не больше 48ч.
 */
export async function findStaleContactRequests(now: Date = new Date()): Promise<{
  thresholdHours: number;
  items: StaleContactRequestItem[];
}> {
  const thresholdHours = await loadThresholdHours();
  const windowStart = new Date(now.getTime() - WINDOW_HOURS * HOUR_MS);
  const staleBefore = new Date(now.getTime() - thresholdHours * HOUR_MS);
  if (windowStart >= staleBefore) return { thresholdHours, items: [] };

  const [botRows, tgRows] = await Promise.all([
    prisma.botConversation.findMany({
      where: { clientId: null, lastMessageAt: { gte: windowStart, lte: staleBefore } },
      select: { id: true, channel: true, name: true, messages: true, lastMessageAt: true },
      orderBy: { lastMessageAt: "asc" },
      take: 500,
    }),
    prisma.telegramConversation.findMany({
      where: { clientId: null, lastMessageAt: { gte: windowStart, lte: staleBefore } },
      select: { id: true, username: true, messages: true, lastMessageAt: true },
      orderBy: { lastMessageAt: "asc" },
      take: 500,
    }),
  ]);

  const items: StaleContactRequestItem[] = [];
  for (const r of botRows) {
    if (!r.lastMessageAt || !lastMessageAsksForPhone(r.messages)) continue;
    items.push({
      id: `bot-${r.id}`,
      conversationId: r.id,
      channel: r.channel,
      name: r.name,
      askedAt: r.lastMessageAt,
      hoursSince: Math.floor((now.getTime() - r.lastMessageAt.getTime()) / HOUR_MS),
    });
  }
  for (const r of tgRows) {
    if (!r.lastMessageAt || !lastMessageAsksForPhone(r.messages)) continue;
    items.push({
      id: `telegram-${r.id}`,
      conversationId: r.id,
      channel: "TELEGRAM",
      name: r.username,
      askedAt: r.lastMessageAt,
      hoursSince: Math.floor((now.getTime() - r.lastMessageAt.getTime()) / HOUR_MS),
    });
  }

  items.sort((a, b) => b.hoursSince - a.hoursSince);
  return { thresholdHours, items: items.slice(0, RESULT_CAP) };
}
