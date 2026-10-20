/**
 * ДОСЬЕ СОБЕСЕДНИКА ДЛЯ ЛЮДЕЙ — то же самое, что бот читает перед ответом, но
 * словами и по правам.
 *
 * Зачем отдельный файл, а не пара полей в маршруте: досье открывается из двух
 * мест (панель в «Чатах» и карточка клиента), а гейтов по правам здесь три
 * штуки сразу — канал, телефон и кандидаты на слияние. Размазанные по
 * маршрутам, они разъезжаются на первой же правке, и один из входов начинает
 * отдавать то, что другой прячет.
 *
 * Значения фактов форматирует СЕРВЕР теми же подписями, которыми они печатаются
 * в промт (`CONTACT_FACT_LABELS` общего словаря). Иначе экран показывал бы одно,
 * а бот читал другое — ровно тот разрыв, ради которого панель и делается.
 */

import {
  CONTACT_FACT_DOMAINS,
  CONTACT_FACT_LABELS,
  CONTACT_INTENT_LABELS,
  isContactCategory,
  parseContactCategoryHistory,
  parseContactFacts,
  type ContactCategory,
  type ContactFact,
  type ContactFactDomain,
  type ContactFactView,
  type ContactNameSource,
  type ContactProfileView,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { clientNamePhoneSafe, clientPhoneFor, phoneSafeText } from "./clientPhone.js";
import { TG_PREFIX } from "./conversationId.js";
import { resolveMergedInto } from "./contactProfiles.js";

/** Телефон в досье лежит хвостом из 9 цифр — тем же, каким CRM узнаёт клиента. */
const PHONE_KIND = "PHONE";

/** Сколько смен категории показываем. Больше на экране не читается. */
const CATEGORY_HISTORY_SHOWN = 5;

export interface ContactProfileViewPerms {
  /** `clients.viewOrigin` — канал, имя из профиля соцсети. */
  canSeeOrigin: boolean;
  /** `clients.viewPhone` — номер целиком вместо маски. */
  canSeePhone: boolean;
  /** `clients.merge` — кандидаты на слияние досье. */
  canMerge: boolean;
}

/** Значение факта человеческими словами — тот же текст, что уходит в промт. */
function factValue(key: string, value: ContactFact["v"]): string | null {
  if (typeof value === "boolean") return value ? "да" : null;
  if (key === "intent") return CONTACT_INTENT_LABELS[String(value)] ?? String(value);
  return String(value);
}

function factViews(
  domain: Record<string, ContactFact>,
  labels: Record<string, string>,
  canSeePhone: boolean
): ContactFactView[] {
  const out: ContactFactView[] = [];
  for (const [key, fact] of Object.entries(domain)) {
    const value = factValue(key, fact.v);
    if (value === null) continue;
    out.push({
      key,
      label: labels[key] ?? key,
      // Факт мог прийти из свободного текста («звоните на 90…») — номер в нём
      // закрывается тем же правом, что и структурный телефон клиента, иначе
      // право обходится первым же фактом из области «прочее».
      value: phoneSafeText(value, canSeePhone),
      at: fact.at,
      src: fact.src,
      ...(fact.conv ? { conv: fact.conv } : {}),
    });
  }
  // Свежее сверху: агент открывает панель, чтобы увидеть последнее, а не первое.
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Собрать досье для экрана. `null` — досье нет вовсе (старые диалоги до
 * бэкофилла) либо оно слито в другое и то исчезло.
 */
export async function contactProfileView(
  profileId: string | null | undefined,
  perms: ContactProfileViewPerms
): Promise<ContactProfileView | null> {
  if (!profileId) return null;
  // Диалог может ссылаться на досье, которое администратор уже слил в другое:
  // показываем живое, а не надгробие.
  const id = await resolveMergedInto(profileId);
  const row = await prisma.contactProfile.findUnique({
    where: { id },
    select: {
      id: true,
      displayName: true,
      nameSource: true,
      category: true,
      categorySetAt: true,
      categoryHistory: true,
      language: true,
      facts: true,
      firstSeenAt: true,
      lastSeenAt: true,
      messagesIn: true,
      client: {
        select: {
          id: true,
          shortId: true,
          kind: true,
          status: true,
          assignedAgent: { select: { fullName: true } },
        },
      },
      identities: { select: { kind: true, value: true, trust: true, lastSeenAt: true } },
      /**
       * ДЛИНУ ПЕРЕПИСКИ СЧИТАЕТ POSTGRES, А НЕ ЭТА ФУНКЦИЯ (правка 22.09.2026).
       *
       * Раньше `select` тянул `messages` целиком у КАЖДОГО диалога всех трёх
       * каналов (до 150 переписок) — только ради `.length`. Одно открытие панели
       * собеседника читало в память мегабайты истории, которая тут же
       * выбрасывалась. Теперь берём лишь id/канал/время; число сообщений
       * добавляет `jsonb_array_length` отдельным дешёвым запросом ниже.
       */
      botConversations: {
        select: { id: true, channel: true, lastMessageAt: true },
        orderBy: { lastMessageAt: "desc" },
        take: 50,
      },
      telegramConversations: {
        select: { id: true, lastMessageAt: true },
        orderBy: { lastMessageAt: "desc" },
        take: 50,
      },
      telegramDirectConversations: {
        select: { id: true, lastMessageAt: true },
        orderBy: { lastMessageAt: "desc" },
        take: 50,
      },
    },
  });
  if (!row) return null;

  /**
   * Число сообщений в каждом диалоге — одним запросом на таблицу через
   * `jsonb_array_length`, вместо чтения массивов в Node. id взяты из уже
   * прочитанных диалогов (те же 50 на канал), поэтому это счёт по известному
   * списку, а не второй проход по всей таблице.
   */
  const msgLen = new Map<string, number>();
  const botIds = row.botConversations.map((c) => c.id);
  const tgIds = row.telegramConversations.map((c) => c.id);
  const tgdIds = row.telegramDirectConversations.map((c) => c.id);
  const [botLens, tgLens, tgdLens] = await Promise.all([
    botIds.length
      ? prisma.$queryRaw<{ id: string; n: number }[]>`
          SELECT "id", COALESCE(jsonb_array_length("messages"), 0)::int AS n
          FROM "BotConversation" WHERE "id" = ANY(${botIds})`
      : Promise.resolve([]),
    tgIds.length
      ? prisma.$queryRaw<{ id: string; n: number }[]>`
          SELECT "id", COALESCE(jsonb_array_length("messages"), 0)::int AS n
          FROM "TelegramConversation" WHERE "id" = ANY(${tgIds})`
      : Promise.resolve([]),
    tgdIds.length
      ? prisma.$queryRaw<{ id: string; n: number }[]>`
          SELECT "id", COALESCE(jsonb_array_length("messages"), 0)::int AS n
          FROM "TelegramDirectConversation" WHERE "id" = ANY(${tgdIds})`
      : Promise.resolve([]),
  ]);
  for (const r of [...botLens, ...tgLens, ...tgdLens]) msgLen.set(r.id, Number(r.n) || 0);

  const facts = parseContactFacts(row.facts);
  const factsByDomain = {} as Record<ContactFactDomain, ContactFactView[]>;
  for (const domain of CONTACT_FACT_DOMAINS) {
    factsByDomain[domain] = factViews(facts[domain], CONTACT_FACT_LABELS[domain], perms.canSeePhone);
  }

  const category: ContactCategory = isContactCategory(row.category) ? row.category : "UNKNOWN";
  const categoryHistory = parseContactCategoryHistory(row.categoryHistory)
    .slice()
    .reverse()
    .slice(0, CATEGORY_HISTORY_SHOWN)
    .map((entry) => ({
      category: (isContactCategory(entry.category) ? entry.category : "UNKNOWN") as ContactCategory,
      label: entry.category,
      at: entry.at,
      src: entry.source,
    }));

  const phones = row.identities.filter((i) => i.kind === PHONE_KIND);
  // Основной номер — самый свежий подтверждённый транспортом (caller-id станции,
  // wa_id), а не напечатанный человеком в чате: второй может быть чужим.
  const primary =
    phones.filter((p) => p.trust === "TRANSPORT").sort((a, b) => +b.lastSeenAt - +a.lastSeenAt)[0] ??
    phones.sort((a, b) => +b.lastSeenAt - +a.lastSeenAt)[0] ??
    null;

  const conversations = [
    ...row.botConversations.map((c) => ({
      id: c.id,
      channel: c.channel,
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      messages: msgLen.get(c.id) ?? 0,
    })),
    ...row.telegramConversations.map((c) => ({
      // Инбокс адресует Telegram-диалоги с префиксом — иначе ссылка из панели
      // открывает чужой диалог бота с тем же id.
      id: TG_PREFIX + c.id,
      channel: "TELEGRAM",
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      messages: msgLen.get(c.id) ?? 0,
    })),
    ...row.telegramDirectConversations.map((c) => ({
      id: TG_PREFIX + c.id,
      channel: "TELEGRAM_DM",
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      messages: msgLen.get(c.id) ?? 0,
    })),
  ].sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));

  const channelCounts = new Map<string, { conversations: number; lastAt: string }>();
  for (const c of conversations) {
    const prev = channelCounts.get(c.channel);
    const lastAt = c.lastMessageAt ?? row.firstSeenAt.toISOString();
    if (prev) {
      prev.conversations += 1;
      if (lastAt > prev.lastAt) prev.lastAt = lastAt;
    } else {
      channelCounts.set(c.channel, { conversations: 1, lastAt });
    }
  }

  const pendingLinks = perms.canMerge ? await loadPendingLinks(row.id, perms.canSeePhone) : [];

  return {
    id: row.id,
    // Имя из профиля соцсети — тот же @ник, что прячется в `profileName` инбокса.
    // Имя, которое человек назвал САМ, видно всем: его он сказал нам сам.
    // Имя профиля — такой же носитель номера, как поле `phone`: у WhatsApp имени
    // часто нет вовсе и транспорт отдаёт вместо него сам номер, а карточка
    // незнакомого звонившего заводится с номером В ИМЕНИ («Входящий +992…»).
    // Поэтому имя идёт через то же право, что и номер (разбор — clientPhone.ts).
    displayName:
      row.nameSource === "profile" && !perms.canSeeOrigin
        ? null
        : row.displayName && clientNamePhoneSafe(row.displayName, perms.canSeePhone),
    nameSource: (row.nameSource as ContactNameSource | null) ?? null,
    category,
    categorySetAt: row.categorySetAt?.toISOString() ?? null,
    categoryHistory,
    language: row.language,
    primaryPhone: primary ? clientPhoneFor(primary.value, perms.canSeePhone) : null,
    phonesCount: phones.length,
    channels: [...channelCounts.entries()]
      .map(([channel, v]) => ({ channel: perms.canSeeOrigin ? channel : null, ...v }))
      .sort((a, b) => b.lastAt.localeCompare(a.lastAt)),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    inboundMessages: row.messagesIn,
    client: row.client
      ? {
          id: row.client.id,
          shortId: row.client.shortId,
          kind: row.client.kind,
          status: row.client.status,
          agentName: row.client.assignedAgent?.fullName ?? null,
        }
      : null,
    facts: factsByDomain,
    conversations: conversations.map((c) => ({ ...c, channel: perms.canSeeOrigin ? c.channel : null })),
    pendingLinks,
  };
}

async function loadPendingLinks(
  profileId: string,
  canSeePhone: boolean
): Promise<ContactProfileView["pendingLinks"]> {
  const rows = await prisma.contactLinkCandidate.findMany({
    where: {
      status: "PENDING",
      OR: [{ leftId: profileId }, { rightId: profileId }],
    },
    select: {
      id: true,
      reason: true,
      left: { select: { id: true, displayName: true, category: true } },
      right: { select: { id: true, displayName: true, category: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
  return rows.map((r) => {
    const other = r.left.id === profileId ? r.right : r.left;
    return {
      id: r.id,
      otherProfile: {
        id: other.id,
        displayName: other.displayName && clientNamePhoneSafe(other.displayName, canSeePhone),
        category: (isContactCategory(other.category) ? other.category : "UNKNOWN") as ContactCategory,
      },
      reason: r.reason,
    };
  });
}
