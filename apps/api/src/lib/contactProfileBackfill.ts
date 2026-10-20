/**
 * РАЗБОР ПРЕЖНИХ ПЕРЕПИСОК И ЗВОНКОВ В ДОСЬЕ СОБЕСЕДНИКА — сама работа.
 *
 * Досье завелись 21.09.2026 и заполняются с первого нового сообщения человека.
 * У всех, кто писал или звонил раньше, досье нет вовсе — и вернувшемуся клиенту
 * бот отвечает как незнакомому, хотя переписка с ним лежит в той же базе.
 *
 * ЧТО ПЕРЕНОСИТСЯ: признаки канала (те же, что ставит живой код), имя из
 * профиля, ссылка на карточку клиента, первое и последнее касание, число
 * входящих и категория по последнему известному намерению разговора.
 *
 * ЧЕГО НЕ ПЕРЕНОСИТСЯ: факты (бюджет, район, площадь). Их считает модель по
 * ходу разговора, и выдумать их из архива нельзя — досье наполнится фактами с
 * первого же нового сообщения. Пустой раздел фактов честнее придуманного.
 *
 * ЧИСЛО ВХОДЯЩИХ — НИЖНЯЯ ГРАНИЦА, а не точное значение: в диалоге хранятся
 * последние 40 реплик, остальные обрезаны давно. Считать нечего, и завышать
 * тоже нельзя: «пишет нам 60 сообщений» у человека с тремя репликами — это
 * ложь боту в промте.
 *
 * ЛОГИКА ЗАВЕДЕНИЯ НЕ ДУБЛИРУЕТСЯ: зовутся те же `attachContactProfile` и
 * `identitiesForMessengerChannel`, что и живые каналы. Своя копия разошлась бы
 * с ними на первой правке и склеила бы разных людей в одно досье — ровно то, от
 * чего досье должно защищать.
 *
 * Живёт модулем, а не внутри скрипта, чтобы это можно было проверить тестом:
 * разбор идёт по записям живых людей, и «вроде отработало» тут не годится.
 */
import { categoryFromIntent, type ContactCategory } from "@royal-home/shared";
import { prisma } from "../db.js";
import {
  attachContactProfile,
  identitiesForMessengerChannel,
  linkContactProfileToClient,
  setContactCategory,
} from "./contactProfiles.js";

export interface BackfillStats {
  conversations: number;
  telegram: number;
  direct: number;
  calls: number;
  profiles: number;
  skipped: number;
}

/** Сколько записей одного вида берём за раз: вся таблица в память не нужна. */
const PAGE = 200;

/** Накопленное по досье, пока идём по источникам. */
interface Touches {
  firstSeenAt: Date;
  lastSeenAt: Date;
  messagesIn: number;
  clientId: string | null;
  /** Последнее известное намерение разговора — из него выводится категория. */
  intent: string | null;
  /** Когда это намерение было названо: побеждает самое свежее. */
  intentAt: Date;
}


function note(touches: Map<string, Touches>, profileId: string, next: Omit<Touches, "intentAt"> & { intentAt?: Date }): void {
  const at = next.intentAt ?? next.lastSeenAt;
  const prev = touches.get(profileId);
  if (!prev) {
    touches.set(profileId, { ...next, intentAt: at });
    return;
  }
  prev.messagesIn += next.messagesIn;
  if (next.firstSeenAt < prev.firstSeenAt) prev.firstSeenAt = next.firstSeenAt;
  if (next.lastSeenAt > prev.lastSeenAt) prev.lastSeenAt = next.lastSeenAt;
  // Карточка клиента у досье одна. Первая найденная и остаётся: перебивать её
  // второй — это молча переписать, кому принадлежит разговор.
  if (!prev.clientId && next.clientId) prev.clientId = next.clientId;
  if (next.intent && at > prev.intentAt) {
    prev.intent = next.intent;
    prev.intentAt = at;
  }
}

/** Сколько входящих реплик хранится в диалоге. Форме в Json не доверяем. */
function inboundCount(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  let n = 0;
  for (const item of raw) {
    if (item && typeof item === "object" && (item as { role?: unknown }).role === "user") n += 1;
  }
  return n;
}

/** Намерение из сохранённого черновика лида. */
function draftIntent(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as { intent?: unknown }).intent;
  return typeof value === "string" && value ? value : null;
}

/**
 * Завести досье и вернуть его id. В режиме показа в базу не пишем вовсе: у
 * `attachContactProfile` нет «сухого» режима, а заводить настоящие записи ради
 * отчёта — это и есть запись в базу.
 */
async function attach(
  apply: boolean,
  identities: Parameters<typeof attachContactProfile>[0]["identities"],
  name: string | null,
  nameSource: "self" | "profile" | undefined,
  link: (profileId: string) => Promise<void>
): Promise<string | null> {
  if (!apply) return null;
  return attachContactProfile({ existingProfileId: null, identities, name, nameSource, link });
}

async function backfillMessengerConversations(
  apply: boolean,
  touches: Map<string, Touches>,
  stats: BackfillStats
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.botConversation.findMany({
      where: { contactProfileId: null },
      select: {
        id: true,
        channel: true,
        subscriberId: true,
        name: true,
        messages: true,
        leadDraft: true,
        clientId: true,
        createdAt: true,
        lastMessageAt: true,
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) return;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      const identities = identitiesForMessengerChannel(row.channel, row.subscriberId);
      // Неизвестный канал признаков не даёт — заводить досье не на чем, и
      // выдумывать признак нельзя: по выдуманному склеятся разные люди.
      if (identities.length === 0) {
        stats.skipped += 1;
        continue;
      }
      stats.conversations += 1;
      const profileId = await attach(apply, identities, row.name, "profile", async (id) => {
        await prisma.botConversation.update({ where: { id: row.id }, data: { contactProfileId: id } });
      });
      if (!profileId) continue;
      note(touches, profileId, {
        firstSeenAt: row.createdAt,
        lastSeenAt: row.lastMessageAt ?? row.createdAt,
        messagesIn: inboundCount(row.messages),
        clientId: row.clientId,
        intent: draftIntent(row.leadDraft),
      });
    }
  }
}

async function backfillTelegram(
  apply: boolean,
  touches: Map<string, Touches>,
  stats: BackfillStats
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.telegramConversation.findMany({
      where: { contactProfileId: null },
      select: {
        id: true,
        chatId: true,
        username: true,
        messages: true,
        leadDraft: true,
        clientId: true,
        createdAt: true,
        lastMessageAt: true,
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) return;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      stats.telegram += 1;
      // Те же признаки, что ставит живой telegram/bot.ts: chatId подтверждён
      // самим Telegram, ник человек меняет когда захочет — он подсказка.
      const profileId = await attach(apply, 
        [
          { kind: "TG_CHAT_ID", value: row.chatId, trust: "TRANSPORT" },
          { kind: "TG_USERNAME", value: row.username, trust: "PROFILE" },
        ],
        row.username ? `@${row.username}` : null,
        "profile",
        async (id) => {
          await prisma.telegramConversation.update({ where: { id: row.id }, data: { contactProfileId: id } });
        }
      );
      if (!profileId) continue;
      note(touches, profileId, {
        firstSeenAt: row.createdAt,
        lastSeenAt: row.lastMessageAt ?? row.createdAt,
        messagesIn: inboundCount(row.messages),
        clientId: row.clientId,
        intent: draftIntent(row.leadDraft),
      });
    }
  }
}

async function backfillTelegramDirect(
  apply: boolean,
  touches: Map<string, Touches>,
  stats: BackfillStats
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.telegramDirectConversation.findMany({
      where: { contactProfileId: null },
      select: {
        id: true,
        chatId: true,
        topicId: true,
        fromUserId: true,
        username: true,
        messages: true,
        leadDraft: true,
        clientId: true,
        createdAt: true,
        lastMessageAt: true,
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) return;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      stats.direct += 1;
      const profileId = await attach(apply, 
        [
          ...(row.fromUserId
            ? [{ kind: "TG_CHAT_ID" as const, value: row.fromUserId, trust: "TRANSPORT" as const }]
            : []),
          { kind: "TG_DM_TOPIC", value: `${row.chatId}:${row.topicId}`, trust: "TRANSPORT" },
          { kind: "TG_USERNAME", value: row.username, trust: "PROFILE" },
        ],
        row.username ? `@${row.username}` : null,
        "profile",
        async (id) => {
          await prisma.telegramDirectConversation.update({
            where: { id: row.id },
            data: { contactProfileId: id },
          });
        }
      );
      if (!profileId) continue;
      note(touches, profileId, {
        firstSeenAt: row.createdAt,
        lastSeenAt: row.lastMessageAt ?? row.createdAt,
        messagesIn: inboundCount(row.messages),
        clientId: row.clientId,
        intent: draftIntent(row.leadDraft),
      });
    }
  }
}

async function backfillCalls(
  apply: boolean,
  touches: Map<string, Touches>,
  stats: BackfillStats
): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.incomingCall.findMany({
      where: { contactProfileId: null },
      select: {
        id: true,
        phone: true,
        clientId: true,
        startedAt: true,
        client: { select: { fullName: true } },
      },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) return;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      stats.calls += 1;
      // Номер, определённый станцией, — тот же признак, по которому звонок и
      // переписка в WhatsApp сходятся в одно досье (хвост из девяти цифр).
      const profileId = await attach(apply, 
        [{ kind: "PHONE", value: row.phone, trust: "TRANSPORT" }],
        row.client?.fullName ?? null,
        "self",
        async (id) => {
          await prisma.incomingCall.update({ where: { id: row.id }, data: { contactProfileId: id } });
        }
      );
      if (!profileId) continue;
      // Звонок — это касание, но не входящее СООБЩЕНИЕ: счётчик не трогаем,
      // иначе «сообщений в переписке» станет числом, которого нет в переписке.
      note(touches, profileId, {
        firstSeenAt: row.startedAt,
        lastSeenAt: row.startedAt,
        messagesIn: 0,
        clientId: row.clientId,
        intent: null,
      });
    }
  }
}

/** Проставить накопленное. Одним проходом: у досье может быть несколько бесед. */
async function applyTouches(touches: Map<string, Touches>, stats: BackfillStats): Promise<void> {
  for (const [profileId, t] of touches) {
    stats.profiles += 1;
    await prisma.contactProfile.update({
      where: { id: profileId },
      data: {
        firstSeenAt: t.firstSeenAt,
        lastSeenAt: t.lastSeenAt,
        messagesIn: t.messagesIn,
      },
    });
    if (t.clientId) await linkContactProfileToClient(profileId, t.clientId);
    const category: ContactCategory | null = t.intent ? categoryFromIntent(t.intent) : null;
    // Источник "guard": категорию вывел код по сохранённому черновику, а не
    // модель в разговоре. В истории смен это будет видно.
    if (category) await setContactCategory({ profileId, category, source: "guard" });
  }
}

/**
 * Пройти по четырём источникам и завести недостающие досье.
 *
 * @param apply писать в базу. `false` (по умолчанию) — только посчитать, сколько
 *   записей осталось без досье: заводить настоящие записи ради отчёта — это и
 *   есть запись в базу.
 */
export async function backfillContactProfiles({ apply = false } = {}): Promise<BackfillStats> {
  const touches = new Map<string, Touches>();
  const stats: BackfillStats = { conversations: 0, telegram: 0, direct: 0, calls: 0, profiles: 0, skipped: 0 };
  await backfillMessengerConversations(apply, touches, stats);
  await backfillTelegram(apply, touches, stats);
  await backfillTelegramDirect(apply, touches, stats);
  await backfillCalls(apply, touches, stats);
  if (apply) await applyTouches(touches, stats);
  return stats;
}
