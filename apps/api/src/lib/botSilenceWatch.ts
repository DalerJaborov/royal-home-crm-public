import { pluralizeRu } from "@royal-home/shared";
import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { customerSpamMuteActive, customerSpamMuteFrom } from "../ai/customerSpamMute.js";
import { loadBotAnswerSwitches } from "../messengers/botChannels.js";
import { automationSwitchOn } from "./automationSwitches.js";
import { episodeAllIntentional, humanRepliedSince, INTENTIONAL_SILENCE_REASONS, waitingEpisodeOf } from "./clientWaitingAlert.js";
import { isCustomerAgentChannelOff } from "./customerAgentChannelOff.js";
import { CUSTOMER_TURN_INTENDED_SILENCE } from "./customerIntendedSilence.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { dushanbeDateString, dushanbeTimeString } from "./dushanbeTime.js";
import { isQuietHour, quietDecision, quietHoursDisabledByEnv } from "./pushQuietHours.js";
import { logSystemError } from "./systemError.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { isTelegramEnabled, sendMessage as sendTelegramMessage } from "../telegram/api.js";

/**
 * СТОРОЖ «БОТ ЗАМОЛЧАЛ» (владелец 27.11.2026).
 *
 * ЗАЧЕМ. 26.11.2026 с 16:00 до 20:22 по Душанбе бот не ответил никому в Instagram, WhatsApp и Facebook (версия ядра
 * застряла, починено #482). Единственным следом была техническая строка в журнале ошибок, которую никто не читал;
 * владелец узнал по входящим Instagram у себя в телефоне. Его слова: «как что-то сломается и бот не отвечает, надо
 * чтобы сторож узнал сразу и сказал мне, админу и директору. Только по-человечески, а не по-технически».
 *
 * ПО ПРИЗНАКУ, А НЕ ПО ПРИЧИНЕ. Сторож не знает, ПОЧЕМУ бот молчит (версия, ключ Meta, упавший процесс, очередь,
 * ИИ — любая будущая причина): он смотрит только на итог в базе. Считает он по ГРУППЕ «канал + наш аккаунт»
 * (номер WhatsApp, страница, аккаунт Instagram, чат сайта): живой аккаунт не прячет мёртвый (26.11 основной WhatsApp
 * молчал, пока второй номер отвечал). Группа «замолчала», когда одновременно:
 *   1. трое и больше клиентов (SILENCE_MIN_CUSTOMERS) ждут ответа дольше 10 минут (SILENCE_GRACE_MS), и
 *   2. с того момента, как написал первый из них, бот не ответил в этой группе НИКОМУ.
 * Второе условие отличает поломку от медлительности и от отдельных намеренных молчаний: работающий бот отвечает
 * хоть кому-то, и тогда пункт 2 ложен. Окно «ждёт ответа» — 6 часов.
 *
 * ДВА ИСТОЧНИКА ОДНОГО ПРИЗНАКА. (а) Переписка CRM (`BotConversation.messages`): хвост реплик клиента без ответа —
 * то же правило, что у сторожа «клиент ждёт ответа» (`waitingEpisodeOf`, одна дверь). (б) Сообщения нового ядра
 * (`CustomerPropertyIngressTicket`), не получившие ответа: на случай поломки ДО того, как текст лёг в переписку
 * (новая пустая переписка, старая переписка вне выборки). Человек считается один раз (ключ: переписка, без неё —
 * область ядра). Ответ бота — его реплика сразу после реплики клиента или принятая площадкой часть ответа ядра.
 *
 * НАМЕРЕННО ВЫКЛЮЧЕННОЕ НЕ ТРЕВОЖИТ НИКОГДА: общий рубильник бота, рубильник канала, выключенный Meta, чат сайта
 * (одна дверь — messengers/botChannels.ts::loadBotAnswerSwitches, то же правило, что у ядра), выключенный аккаунт
 * (`MessengerAccount.enabled`), аварийный `CUSTOMER_AGENT_CHANNEL_OFF`. Аккаунт, у которого Meta отозвала доступ
 * (`accessLostAt`), тоже не смотрим: о нём уже говорит сторож ключей канала, а здесь он открывал бы и закрывал
 * эпизод каждую ночь. Не считаются и люди: намеренное молчание (единый список lib/customerIntendedSilence.ts),
 * пауза бота, отписка, корзина, заглушённый спам, переписка, где сотрудник отвечал за последние сутки.
 *
 * КОМУ И КОГДА. Директору и администратору (владелец — директор) через очередь тревог руководству, срочно: мимо
 * часов алармов, днём телефон звонит сразу. НОЧЬЮ (21:00–08:00 по Душанбе) действует общее правило владельца
 * «ночью пуши запрещены всем» (lib/pushQuietHours.ts): запись в колокольчике появляется сразу, а звонок телефона —
 * в 08:00. Звонить ночью может только вид `realtime` — это решение владельца, здесь его нет.
 * Один эпизод — одно уведомление; пока он длится, напоминание не чаще раза в час и только если люди всё ещё ждут;
 * когда бот снова ответил в каждой замолчавшей группе — «Бот снова отвечает». Если в замолчавших группах никто не
 * ждёт 6 часов (SILENCE_STALE_CLOSE_MS), эпизод закрывается молча: следующее молчание — новый эпизод и новое
 * уведомление. Эпизод хранится в `BotSilenceIncident` (переживает выкат), решение — под замком базы.
 *
 * TELEGRAM (владелец 27.11.2026: «в Telegram дублировать, РОП не добавлять, ночью не звонить»). Тот же текст уходит
 * тем же директору и администратору (активные, с привязанным Telegram) через бота CRM — `sendSilenceTelegram`. Только
 * ПОСЛЕ коммита записи эпизода: откат не оставляет отправленного сообщения, а повтор тика не шлёт второе (эпизод в
 * базе — отметка «уже сказали»). Цена: упал процесс между коммитом и отправкой — Telegram потерян, колокольчик и
 * телефон остались. Ночью (та же тишина, что у пушей) сообщение уходит без звука. Сбой Telegram сторожа не роняет.
 *
 * РУБИЛЬНИКИ (Настройки → Автоматика → Бот клиентов), по умолчанию ВКЛ: `botSilenceWatchEnabled` — сторож целиком,
 * `botSilenceTelegramEnabled` — только дубль в Telegram.
 */

export const SILENCE_WATCHED_CHANNELS = ["INSTAGRAM", "WHATSAPP", "FACEBOOK", "WEBSITE"] as const;
export type SilenceChannel = (typeof SILENCE_WATCHED_CHANNELS)[number];
/** Сколько клиентов без ответа в группе нужно для тревоги. Один-два — это сторож «клиент ждёт ответа», не поломка бота. */
export const SILENCE_MIN_CUSTOMERS = 3;
/** Сколько клиент ждёт, прежде чем считаться «без ответа»: обычный ход бота — секунды, склейка сообщений — до минуты. */
export const SILENCE_GRACE_MS = 10 * 60_000;
/** Глубже не смотрим. */
export const SILENCE_LOOKBACK_MS = 6 * 60 * 60_000;
/** Напоминание руководству не чаще. */
export const SILENCE_REMIND_MS = 60 * 60_000;
/** В замолчавших группах никто не ждёт столько — эпизод закрывается молча (не висит открытым неделями). */
export const SILENCE_STALE_CLOSE_MS = 6 * 60 * 60_000;
/** Сотрудник отвечал в переписке за это время — её ведёт человек, молчание бота там не сигнал. */
const HUMAN_LED_MS = 24 * 60 * 60_000;
const ROW_LIMIT = 1500;
const TICKET_LIMIT = 1000;
/** Сколько ключей «без ответа» хранит эпизод (на число в сообщении о восстановлении хватает с запасом). */
const MISSED_KEYS_CAP = 500;
const LOCK_KEY = "bot-silence-watch";
const ALERT_URL = "/messages";
const ALERT_ROLES = ["DIRECTOR", "ADMIN"] as const;
/** Аккаунт «по умолчанию»: переписка без строки MessengerAccount (основной номер WhatsApp из Настроек, чат сайта). */
const MAIN = "main";

const CHANNEL_WORD: Record<SilenceChannel, string> = {
  INSTAGRAM: "Instagram",
  WHATSAPP: "WhatsApp",
  FACEBOOK: "Facebook",
  WEBSITE: "чате на сайте",
};

function watched(channel: string | null | undefined): SilenceChannel | null {
  const up = (channel ?? "").toUpperCase();
  return (SILENCE_WATCHED_CHANNELS as readonly string[]).includes(up) ? (up as SilenceChannel) : null;
}

/** Группа «канал + наш аккаунт»: «WHATSAPP:main», «INSTAGRAM:<id аккаунта>». */
export function groupKey(channel: SilenceChannel, accountId: string | null | undefined): string {
  return `${channel}:${accountId || MAIN}`;
}
const channelOfGroup = (group: string): SilenceChannel | null => watched(group.split(":")[0]);

export interface WaitingCustomer {
  /** Один человек — один ключ: id переписки CRM, без неё — область ядра. */
  key: string;
  group: string;
  /** С какого момента ждёт ответа. */
  since: Date;
}

export interface SilenceSnapshot {
  /** Все, кто ждёт ответа дольше SILENCE_GRACE_MS (в окне SILENCE_LOOKBACK_MS), без исключённых и без выключенных групп. */
  waiting: WaitingCustomer[];
  /** Последний ответ бота клиенту по группе (в окне); нет записи — не было. */
  lastBotAnswerAt: Record<string, Date>;
  /** Последний ответ сотрудника по ключу человека (для «без ответа остались N»: кому ответили люди, тот не пропущен). */
  lastHumanAnswerAt: Record<string, Date>;
  /** Группы, где бот выключен намеренно, и аккаунты, о которых говорит другой сторож: о них тревоги нет. */
  offGroups: ReadonlySet<string>;
  /** Название группы простыми словами («WhatsApp», «Instagram Арван», «чате на сайте»). */
  labels: Record<string, string>;
}

/** Замолчавшие группы и кто в них ждёт (пришёл ПОСЛЕ последнего ответа бота в группе). Чистая функция. */
export function silentGroups(snapshot: Pick<SilenceSnapshot, "waiting" | "lastBotAnswerAt" | "offGroups">): Map<string, WaitingCustomer[]> {
  const byGroup = new Map<string, WaitingCustomer[]>();
  for (const w of snapshot.waiting) {
    if (snapshot.offGroups.has(w.group)) continue;
    const last = snapshot.lastBotAnswerAt[w.group]?.getTime() ?? -Infinity;
    if (w.since.getTime() <= last) continue;
    byGroup.set(w.group, [...(byGroup.get(w.group) ?? []), w]);
  }
  for (const [group, stuck] of byGroup) if (stuck.length < SILENCE_MIN_CUSTOMERS) byGroup.delete(group);
  return byGroup;
}

export interface OpenIncident {
  id: string;
  groups: string[];
  startedAt: Date;
  lastAlertAt: Date;
  /** Последний тик, когда в группах эпизода кто-то ждал ответа после последнего ответа бота. */
  lastActiveAt: Date;
  missedKeys: string[];
}

export type SilenceDecision =
  | { kind: "none" }
  | { kind: "open"; groups: string[]; startedAt: Date; waiting: number; keys: string[] }
  | { kind: "update"; groups: string[]; keys: string[]; remind: boolean; waiting: number; active: boolean }
  | { kind: "recover"; missed: number; stillWaiting: number }
  | { kind: "close"; why: "off" | "stale" };

/** Что делать на этом тике. Чистая функция — проверяется без базы. */
export function decideBotSilence(snapshot: SilenceSnapshot, open: OpenIncident | null, now: Date): SilenceDecision {
  const silent = silentGroups(snapshot);
  const stuck = [...silent.values()].flat();
  if (!open) {
    if (!silent.size) return { kind: "none" };
    return { kind: "open", groups: [...silent.keys()], startedAt: new Date(Math.min(...stuck.map((w) => w.since.getTime()))),
      waiting: stuck.length, keys: stuck.map((w) => w.key) };
  }
  const live = open.groups.filter((g) => !snapshot.offGroups.has(g) && channelOfGroup(g) !== null);
  if (silent.size) {
    const groups = [...new Set([...live, ...silent.keys()])];
    const keys = [...new Set([...open.missedKeys, ...stuck.map((w) => w.key)])].slice(0, MISSED_KEYS_CAP);
    return { kind: "update", groups, keys, remind: now.getTime() - open.lastAlertAt.getTime() >= SILENCE_REMIND_MS,
      waiting: stuck.length, active: true };
  }
  // Все замолчавшие группы потом выключили намеренно: «бот снова отвечает» было бы неправдой — закрываем молча.
  if (!live.length) return { kind: "close", why: "off" };
  // Бот снова отвечает, только если ответил КОМУ-ТО после начала молчания в каждой замолчавшей группе. Ручные ответы
  // сотрудников бота не «чинят»: тогда эпизод открыт и молчит, пока не наберутся новые трое или бот не ответит.
  if (live.every((g) => (snapshot.lastBotAnswerAt[g]?.getTime() ?? -Infinity) > open.startedAt.getTime())) {
    const waitingNow = new Set(snapshot.waiting.map((w) => w.key));
    // Кому за время молчания ответил сотрудник, тот не «остался без ответа».
    const missed = open.missedKeys.filter((k) => !((snapshot.lastHumanAnswerAt[k]?.getTime() ?? -Infinity) > open.startedAt.getTime()));
    return { kind: "recover", missed: missed.length, stillWaiting: missed.filter((k) => waitingNow.has(k)).length };
  }
  // Кто-то в группах эпизода ещё ждёт после последнего ответа бота — эпизод жив, просто ниже порога.
  const anyoneStuck = snapshot.waiting.some((w) => live.includes(w.group) &&
    w.since.getTime() > (snapshot.lastBotAnswerAt[w.group]?.getTime() ?? -Infinity));
  if (anyoneStuck) return { kind: "update", groups: live, keys: open.missedKeys, remind: false, waiting: 0, active: true };
  if (now.getTime() - open.lastActiveAt.getTime() >= SILENCE_STALE_CLOSE_MS) return { kind: "close", why: "stale" };
  return { kind: "none" };
}

// ---------------------------------------------------------------- тексты: по-человечески, без кодов и английских слов

const people = (n: number) => `${n} ${pluralizeRu(n, ["человек", "человека", "человек"])}`;

/** «в WhatsApp и Instagram Арван», «в Instagram, Facebook и чате на сайте». Порядок — как в списке каналов. */
export function groupsInWords(groups: readonly string[], labels: Readonly<Record<string, string>>): string {
  const order = (g: string) => SILENCE_WATCHED_CHANNELS.indexOf(channelOfGroup(g) ?? "WEBSITE");
  const words = [...new Set([...groups].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    .map((g) => labels[g] ?? CHANNEL_WORD[channelOfGroup(g) ?? "WEBSITE"]))];
  if (!words.length) return "";
  return `в ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} и ${words[words.length - 1]}`}`;
}

/** «16:05» сегодня, «26.11 в 23:50» — если молчание началось в другой день (по Душанбе). */
export function sinceInWords(since: Date, now: Date): string {
  const time = dushanbeTimeString(since);
  const day = dushanbeDateString(since);
  if (day === dushanbeDateString(now)) return time;
  return `${day.slice(8, 10)}.${day.slice(5, 7)} в ${time}`;
}

/**
 * Заголовок намеренно другой, чем у тревоги «бот остановился после обновления CRM» (customerAgentRevisionAlert.ts):
 * та говорит о причине сразу, эта — о том, что клиенты ждут; два одинаковых пуша подряд читались бы как дубль.
 */
export function silenceAlertText(input: { groups: readonly string[]; labels: Readonly<Record<string, string>>; since: Date; waiting: number;
  reminder: boolean; now: Date }): { title: string; body: string } {
  const where = groupsInWords(input.groups, input.labels);
  const since = sinceInWords(input.since, input.now);
  return {
    title: input.reminder ? "Бот всё ещё не отвечает клиентам" : "Клиенты ждут: бот не отвечает",
    body: `${input.reminder ? "Бот всё ещё не отвечает" : "Бот перестал отвечать"} клиентам ${where} с ${since}. ` +
      `Без ответа уже ${people(input.waiting)}. Пока бот молчит, ответьте им вручную в CRM → Чаты и сообщите разработчику.`,
  };
}

export function silenceRecoveredText(input: { groups: readonly string[]; labels: Readonly<Record<string, string>>; since: Date;
  missed: number; stillWaiting: number; now: Date }): { title: string; body: string } {
  const head = `Бот снова отвечает клиентам ${groupsInWords(input.groups, input.labels)}. Пока он молчал (с ${sinceInWords(input.since, input.now)}), `;
  const body = input.missed === 0
    ? `${head}всем написавшим ответили сотрудники.`
    : `${head}без ответа ${pluralizeRu(input.missed, ["остался", "остались", "остались"])} ${people(input.missed)}.` +
      (input.stillWaiting > 0 ? ` Ещё ждут ответа: ${people(input.stillWaiting)}, ответьте им в CRM → Чаты.` : " Проверьте их в CRM → Чаты.");
  return { title: "Бот снова отвечает клиентам", body };
}

// ---------------------------------------------------------------- снимок из базы

type ConversationRow = {
  id: string; channel: string; accountId: string | null; messages: unknown; leadDraft: unknown; pausedUntil: Date | null;
  optedOutAt: Date | null; clientDeleted: boolean;
};
type TicketRow = { eventKey: string; conversationId: string | null; scopeKey: string; receivedAt: Date; channel: string | null; accountId: string | null };
type AccountRow = { id: string; channel: string; enabled: boolean; accessLostAt: Date | null; brandName: string | null; title: string };
type MessageLike = { role?: unknown; at?: unknown; deliveryStatus?: unknown; by?: { kind?: unknown } | null };

const BOT_SILENT_AUTHORS = new Set(["agent", "manual", "system"]);
const HUMAN_AUTHORS = new Set(["agent", "manual"]);
const isoAt = (raw: unknown): Date | null => {
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
};
const authorOf = (m: MessageLike): string | undefined => {
  const kind = m.by && typeof m.by === "object" ? m.by.kind : undefined;
  return typeof kind === "string" ? kind : undefined;
};

/** Последний ответ бота клиенту в переписке (не позже `now`): его реплика сразу после реплики клиента. Чистая функция. */
export function lastBotAnswerIn(messages: unknown, now: Date = new Date(8.64e15)): Date | null {
  if (!Array.isArray(messages)) return null;
  let last: Date | null = null;
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i] as MessageLike | null;
    const prev = messages[i - 1] as MessageLike | null;
    if (!m || m.role !== "assistant" || prev?.role !== "user" || m.deliveryStatus === "failed") continue;
    const kind = authorOf(m);
    if (kind && BOT_SILENT_AUTHORS.has(kind)) continue;
    const at = isoAt(m.at);
    if (at && at <= now && (!last || at > last)) last = at;
  }
  return last;
}

function lastHumanAnswerIn(messages: unknown): Date | null {
  if (!Array.isArray(messages)) return null;
  let last: Date | null = null;
  for (const raw of messages as Array<MessageLike | null>) {
    const kind = raw && raw.role === "assistant" ? authorOf(raw) : undefined;
    const at = kind && HUMAN_AUTHORS.has(kind) ? isoAt(raw!.at) : null;
    if (at && (!last || at > last)) last = at;
  }
  return last;
}

/** Переписку ведёт человек или бот в ней молчит по решению людей — не считаем. */
function conversationExcluded(row: ConversationRow, now: Date): boolean {
  if (row.clientDeleted || row.optedOutAt) return true;
  if (row.pausedUntil && row.pausedUntil.getTime() > now.getTime()) return true;
  const draft = row.leadDraft;
  const spam = draft && typeof draft === "object" && !Array.isArray(draft) ? (draft as Record<string, unknown>).spamMute : undefined;
  if (customerSpamMuteActive(customerSpamMuteFrom(spam), now)) return true;
  return humanRepliedSince(row.messages, new Date(now.getTime() - HUMAN_LED_MS));
}

/** Выключенные группы: рубильники бота (одна дверь), выключенный аккаунт, отозванный Meta доступ, аварийный рубильник. */
export function offGroupsOf(switches: Readonly<Record<SilenceChannel, boolean>>, accounts: readonly AccountRow[],
  env: NodeJS.ProcessEnv = process.env): Set<string> {
  const off = new Set<string>();
  for (const channel of SILENCE_WATCHED_CHANNELS) {
    const channelOff = !switches[channel] || isCustomerAgentChannelOff(channel, env, null);
    if (channelOff) off.add(groupKey(channel, null));
    for (const account of accounts.filter((a) => watched(a.channel) === channel)) {
      if (channelOff || !account.enabled || account.accessLostAt || isCustomerAgentChannelOff(channel, env, account.brandName)) {
        off.add(groupKey(channel, account.id));
      }
    }
  }
  return off;
}

function labelsOf(accounts: readonly AccountRow[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const channel of SILENCE_WATCHED_CHANNELS) labels[groupKey(channel, null)] = CHANNEL_WORD[channel];
  for (const account of accounts) {
    const channel = watched(account.channel);
    if (!channel) continue;
    const name = (account.brandName ?? "").trim() || account.title.trim();
    labels[groupKey(channel, account.id)] = name ? `${CHANNEL_WORD[channel]} ${name}` : CHANNEL_WORD[channel];
  }
  return labels;
}

/** Выборка переписок одним запросом; хвост ленты (20 реплик) хватает и на «кто ждёт», и на «когда бот ответил». */
function conversationsWhere(where: Prisma.Sql) {
  return prisma.$queryRaw<ConversationRow[]>`
    SELECT bc.id, bc.channel, bc."accountId", bc."leadDraft", bc."pausedUntil", bc."optedOutAt",
      (c."deletedAt" IS NOT NULL) AS "clientDeleted",
      (SELECT jsonb_agg(x.e ORDER BY x.o) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(bc.messages) = 'array' THEN bc.messages ELSE '[]'::jsonb END)
        WITH ORDINALITY AS x(e, o) WHERE x.o > jsonb_array_length(CASE WHEN jsonb_typeof(bc.messages) = 'array' THEN bc.messages ELSE '[]'::jsonb END) - 20) AS messages
    FROM "BotConversation" bc
    LEFT JOIN "Client" c ON c.id = bc."clientId"
    WHERE ${where}`;
}

export async function loadSilenceSnapshot(now: Date): Promise<SilenceSnapshot> {
  const from = new Date(now.getTime() - SILENCE_LOOKBACK_MS);
  const graceEdge = new Date(now.getTime() - SILENCE_GRACE_MS);
  const channels = [...SILENCE_WATCHED_CHANNELS];
  const intended = [...CUSTOMER_TURN_INTENDED_SILENCE];
  // Верхняя граница `<= now` везде: снимок «на момент now» (и тесты на прошлом времени не видят чужих свежих строк).
  const [rows, tickets, outbox, accounts, switches] = await Promise.all([
    conversationsWhere(Prisma.sql`bc."lastMessageAt" >= ${from} AND bc."lastMessageAt" <= ${now}
      AND upper(bc.channel) = ANY(${channels}::text[]) ORDER BY bc."lastMessageAt" DESC LIMIT ${ROW_LIMIT}`),
    // Сообщения ядра без ответа: не запланирован ответ, нет ни одной части ответа, не перекрыты более новым отвеченным
    // сообщением того же человека, причина не из списка намеренного молчания.
    prisma.$queryRaw<TicketRow[]>`
      SELECT t."eventKey", t."conversationId", t."scopeKey", t."receivedAt",
        upper(COALESCE(es.channel, bc.channel)) AS channel, COALESCE(es."messengerAccountId", bc."accountId") AS "accountId"
      FROM "CustomerPropertyIngressTicket" t
      LEFT JOIN "CustomerEndpointScope" es ON es.id = t."endpointScopeId"
      LEFT JOIN "BotConversation" bc ON bc.id = t."conversationId"
      WHERE t."receivedAt" >= ${from} AND t."receivedAt" <= ${graceEdge}
        AND t."tombstonedAt" IS NULL
        AND t."processingState" IN ('RECEIVED', 'CLAIMED', 'HELD')
        AND (t."errorCode" IS NULL OR NOT (t."errorCode" = ANY(${intended}::text[])))
        AND NOT EXISTS (SELECT 1 FROM "CustomerOutboxPart" p WHERE p."ticketEventKey" = t."eventKey")
        AND NOT EXISTS (SELECT 1 FROM "CustomerPropertyIngressTicket" x
          WHERE x."scopeKey" = t."scopeKey" AND x."order" > t."order" AND x."processingState" = 'PLANNED')
      ORDER BY t."receivedAt" ASC
      LIMIT ${TICKET_LIMIT}`,
    // Принятые площадкой части ответов ядра в личные сообщения (не комментарии) — тоже «бот ответил».
    prisma.$queryRaw<Array<{ channel: string; accountId: string | null; at: Date | null }>>`
      SELECT upper(p.channel) AS channel, es."messengerAccountId" AS "accountId", max(p."acceptedAt") AS at
      FROM "CustomerOutboxPart" p
      JOIN "CustomerEndpointScope" es ON es.id = p."endpointScopeId"
      WHERE p."acceptedAt" >= ${from} AND p."acceptedAt" <= ${now} AND p."ticketEventKey" IS NOT NULL
      GROUP BY 1, 2`,
    prisma.messengerAccount.findMany({ select: { id: true, channel: true, enabled: true, accessLostAt: true, brandName: true, title: true },
      take: 500 }),
    loadBotAnswerSwitches(),
  ]);
  // Сообщение ядра указывает на переписку вне выборки (новая пустая, давно не писавшая): дочитываем её по id.
  const sampled = new Set(rows.map((r) => r.id));
  const missing = [...new Set(tickets.map((t) => t.conversationId).filter((id): id is string => !!id && !sampled.has(id)))];
  const extra = missing.length ? await conversationsWhere(Prisma.sql`bc.id = ANY(${missing}::text[])`) : [];

  const offGroups = offGroupsOf(switches, accounts);
  const lastBotAnswerAt: Record<string, Date> = {};
  const lastHumanAnswerAt: Record<string, Date> = {};
  const bump = (group: string | null, at: Date | null) => {
    if (group && at && at <= now && (!lastBotAnswerAt[group] || at > lastBotAnswerAt[group])) lastBotAnswerAt[group] = at;
  };
  for (const row of outbox) {
    const channel = watched(row.channel);
    if (channel) bump(groupKey(channel, row.accountId), row.at);
  }

  const byConversation = new Map([...rows, ...extra].map((row) => [row.id, row]));
  const waiting = new Map<string, WaitingCustomer>();
  const episodes: Array<{ row: ConversationRow; group: string; episode: NonNullable<ReturnType<typeof waitingEpisodeOf>> }> = [];
  for (const row of byConversation.values()) {
    const channel = watched(row.channel);
    if (!channel) continue;
    const group = groupKey(channel, row.accountId);
    bump(group, lastBotAnswerIn(row.messages, now));
    const human = lastHumanAnswerIn(row.messages);
    if (human) lastHumanAnswerAt[row.id] = human;
    if (offGroups.has(group)) continue;
    const episode = waitingEpisodeOf(row.messages);
    if (!episode || episode.since < from || episode.since > graceEdge || conversationExcluded(row, now)) continue;
    episodes.push({ row, group, episode });
  }
  // Намеренное молчание ядра (все реплики эпизода удержаны по списку намеренных) — тем же правилом, что у сторожа
  // «клиент ждёт ответа»; причины тикетов одним запросом на всю пачку, не в цикле.
  const keys = [...new Set(episodes.flatMap((e) => e.episode.eventKeys))];
  const codes = keys.length
    ? await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: keys } }, select: { eventKey: true, errorCode: true } })
    : [];
  const intentional = new Set(codes.filter((t) => t.errorCode && INTENTIONAL_SILENCE_REASONS.has(t.errorCode)).map((t) => t.eventKey));
  for (const { row, group, episode } of episodes) {
    if (episodeAllIntentional(episode, intentional)) continue;
    waiting.set(row.id, { key: row.id, group, since: episode.since });
  }

  for (const ticket of tickets) {
    const channel = watched(ticket.channel);
    if (!channel) continue;
    const group = groupKey(channel, ticket.accountId);
    const key = ticket.conversationId ?? `scope:${ticket.scopeKey}`;
    if (offGroups.has(group) || waiting.has(key)) continue;
    const row = ticket.conversationId ? byConversation.get(ticket.conversationId) : undefined;
    // Переписку удалили (id есть, строки нет): человек ушёл из CRM по решению сотрудника — не считаем.
    if (ticket.conversationId && !row) continue;
    if (row) {
      if (conversationExcluded(row, now)) continue;
      // В переписке после этого сообщения уже ответили (бот старым путём или человек): не ждёт.
      const answered = Array.isArray(row.messages) && (row.messages as MessageLike[]).some((m) => m?.role === "assistant" &&
        m.deliveryStatus !== "failed" && (isoAt(m.at)?.getTime() ?? 0) > ticket.receivedAt.getTime());
      if (answered) continue;
    }
    waiting.set(key, { key, group, since: ticket.receivedAt });
  }
  return { waiting: [...waiting.values()], lastBotAnswerAt, lastHumanAnswerAt, offGroups, labels: labelsOf(accounts) };
}

// ---------------------------------------------------------------- тик

export interface BotSilenceTickResult {
  action: "off" | "busy" | SilenceDecision["kind"];
  alerted: boolean;
}

const TELEGRAM_TIMEOUT_MS = 20_000;

/**
 * Тот же текст директору и администратору в Telegram. Зовётся только после коммита эпизода; ничего не бросает:
 * сбой одного получателя пишется в журнал ошибок и не мешает остальным и самому сторожу. Возвращает, скольким ушло.
 */
export async function sendSilenceTelegram(text: { title: string; body: string }, now: Date): Promise<number> {
  try {
    if (!isTelegramEnabled() || !(await automationSwitchOn("botSilenceTelegramEnabled"))) return 0;
    const recipients = await prisma.agent.findMany({
      where: { role: { in: [...ALERT_ROLES] }, isActive: true, telegramChatId: { not: null } },
      select: { id: true, telegramChatId: true }, take: 50,
    });
    if (!recipients.length) return 0;
    // Тишина — то же правило, что у пушей: ночью (вне рабочего дня) без звука.
    const workdayOpen = !quietHoursDisabledByEnv() && isQuietHour(now) ? await isWithinWorkingHours(now) : false;
    const silent = quietDecision({}, now, workdayOpen) !== "send";
    const message = `${text.title}

${text.body}`;
    let sent = 0;
    for (const agent of recipients) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          sendTelegramMessage(agent.telegramChatId!, message, undefined, undefined, { origin: "staff", singleAttempt: true, silent }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Telegram не ответил за 20 секунд")), TELEGRAM_TIMEOUT_MS); }),
        ]);
        sent++;
      } catch (err) {
        await logSystemError("telegram", `Сторож «бот замолчал»: не удалось отправить в Telegram (сотрудник ${agent.id}): ${err instanceof Error ? err.message : String(err)}`,
          { dedupKey: `bot-silence-telegram:${agent.id}` }).catch(() => undefined);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    return sent;
  } catch (err) {
    await logSystemError("telegram", `Сторож «бот замолчал»: Telegram-дубль не выполнен: ${err instanceof Error ? err.message : String(err)}`,
      { dedupKey: "bot-silence-telegram:all" }).catch(() => undefined);
    return 0;
  }
}

export async function runBotSilenceWatchTick(now: Date = new Date()): Promise<BotSilenceTickResult> {
  if (!(await automationSwitchOn("botSilenceWatchEnabled"))) return { action: "off", alerted: false };
  const snapshot = await loadSilenceSnapshot(now);
  // Что сказали руководству в этом тике: уходит в Telegram только после коммита (при откате транзакции — ничего).
  const said: Array<{ title: string; body: string }> = [];
  const result = await prisma.$transaction(async (tx) => {
    said.length = 0; // повтор транзакции Prisma не копит тексты прошлой попытки
    // Решение и запись — под одним замком: два процесса не заведут два эпизода и не пошлют одно уведомление дважды.
    const [{ locked }] = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) AS locked`;
    if (!locked) return { action: "busy" as const, alerted: false };
    const row = await tx.botSilenceIncident.findFirst({ where: { recoveredAt: null }, orderBy: { detectedAt: "desc" } });
    const open: OpenIncident | null = row
      ? { id: row.id, groups: row.groups, startedAt: row.startedAt, lastAlertAt: row.lastAlertAt, lastActiveAt: row.lastActiveAt,
          missedKeys: Array.isArray(row.missedKeys) ? (row.missedKeys as unknown[]).filter((k): k is string => typeof k === "string") : [] }
      : null;
    const decision = decideBotSilence(snapshot, open, now);
    const send = async (tag: string, text: { title: string; body: string }, urgent: boolean) => {
      const queued = await enqueueDirectorAlert({ ...text, url: ALERT_URL, tag, recipientRoles: [...ALERT_ROLES],
        ...(urgent ? { level: "CRITICAL" as const, severity: "critical" as const } : {}) }, tx);
      // Не встало — откат всей записи эпизода: следующий тик попробует снова.
      if (!queued) throw new Error("очередь тревог руководству недоступна");
      said.push(text);
      return true;
    };
    const labels = snapshot.labels;
    if (decision.kind === "open") {
      const created = await tx.botSilenceIncident.create({ data: { groups: decision.groups, startedAt: decision.startedAt,
        detectedAt: now, lastAlertAt: now, lastActiveAt: now, missedKeys: decision.keys } });
      await send(`bot-silence-${created.id}`,
        silenceAlertText({ groups: decision.groups, labels, since: decision.startedAt, waiting: decision.waiting, reminder: false, now }), true);
      return { action: decision.kind, alerted: true };
    }
    if (decision.kind === "update" && open) {
      if (decision.remind) {
        await send(`bot-silence-${open.id}`,
          silenceAlertText({ groups: decision.groups, labels, since: open.startedAt, waiting: decision.waiting, reminder: true, now }), true);
      }
      await tx.botSilenceIncident.update({ where: { id: open.id }, data: { groups: decision.groups, missedKeys: decision.keys,
        ...(decision.active ? { lastActiveAt: now } : {}), ...(decision.remind ? { lastAlertAt: now } : {}) } });
      return { action: decision.kind, alerted: decision.remind };
    }
    if (decision.kind === "recover" && open) {
      // Кто-то ещё ждёт — сказать сразу; иначе «к сведению», звонок телефона в часы алармов.
      await send(`bot-silence-ok-${open.id}`, silenceRecoveredText({ groups: open.groups, labels, since: open.startedAt,
        missed: decision.missed, stillWaiting: decision.stillWaiting, now }), decision.stillWaiting > 0);
      await tx.botSilenceIncident.update({ where: { id: open.id }, data: { recoveredAt: now } });
      return { action: decision.kind, alerted: true };
    }
    if (decision.kind === "close" && open) {
      await tx.botSilenceIncident.update({ where: { id: open.id }, data: { recoveredAt: now } });
      return { action: decision.kind, alerted: false };
    }
    return { action: "none" as const, alerted: false };
  }, { timeout: 15_000 });
  for (const text of said) await sendSilenceTelegram(text, now);
  return result;
}
