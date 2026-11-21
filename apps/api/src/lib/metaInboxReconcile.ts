// СВЕРКА ПЕРЕПИСОК СТРАНИЦЫ С META: сообщение, которое видно в Messenger
// Страницы, но не дошло до CRM, уходит человеку (15.11.2026).
//
// ЗАЧЕМ. Все сторожа молчания (clientWaitingAlert.ts, customerTurnSilence.ts)
// видят только то, что УЖЕ лежит в CRM. Сообщение, которое Meta не прислала
// вебхуком, для них не существует — клиенту тишина, сотруднику ни сигнала.
// ФАКТ (прод, 13–14.11, чтение Graph API): у Страницы «Arvan estate» за двое суток
// написали 8 человек, в CRM дошёл ОДИН — администратор приложения. Причина —
// у приложения базовый (не расширенный) доступ к Messenger, а Страница чужой
// компании: Meta шлёт вебхук только про людей с ролью в приложении. Ещё один
// путь той же потери — сообщение, оборвавшееся на перезапуске (13.11 12:30,
// фото в Messenger Royal Home).
//
// ЧТО ДЕЛАЕТ. Раз в 10 минут читает последние переписки каждой подключённой
// Страницы (Graph API, только чтение, бесплатно) и сверяет входящие сообщения
// с тем, что CRM получила (ProcessedMessage по mid, лента BotConversation).
// Mid в Graph и в вебхуке совпадает (ФАКТ, сверено на проде 15.11). Не дошедшее
// старше GRACE_MS — один пуш на человека «Ответьте вручную в Meta Business
// Suite» всем, кто читает переписки, и строка в журнале на Страницу.
//
// ЧЕГО НЕ ДЕЛАЕТ. Не пишет клиенту, не запускает бота, не создаёт переписку в
// CRM (ответить из CRM такому человеку Meta всё равно не даст, пока нет
// расширенного доступа). Отметка «уже сказали» — строка ProcessedMessage
// канала `meta-inbox-missed` на mid (живёт 3 дня, как остальные отметки).
//
// INSTAGRAM (15.11.2026, В4 владельца: сверка нужна не только для Messenger). Тот же
// путь для каждого аккаунта Instagram из «Каналов»: `GET /me/conversations?platform=
// instagram` маркером аккаунта (graph.instagram.com, через прокси, если задан).
// ФАКТ (прод 15.11, чтение): вложенные поля `messages{id,created_time,from,message}`
// Graph отдаёт; id сообщения в Graph = mid вебхука (Arvan IG 24/24, Royal Home 11/11
// найдены в ProcessedMessage). Ограничение Meta (docs instagram-api-with-instagram-login/
// conversations-api): видны только 20 последних сообщений переписки, «Запросы» старше
// 30 дней не отдаются. Ответ сотрудника в Instagram гасит сигнал так же, как в Messenger.
//
// АВТООТВЕТ НЕ ЖИВОЙ ОТВЕТ (Н2, обе площадки). Сообщение Страницы/аккаунта гасит сигнал,
// только если оно (а) пришло позже реплики клиента больше чем на минуту и (б) не шаблон:
// один и тот же текст в двух и более разных переписках выборки — это приветствие,
// «нет на месте» или быстрый ответ автоматизации, а не человек. Сохранённый ответ,
// которым сотрудник ответил двоим одинаково, тоже сочтётся шаблоном — лишний пуш
// безопаснее пропущенного клиента.
//
// РУБИЛЬНИКИ (правило владельца: у каждой сверки свой): Settings.messengerInboxReconcileEnabled
// и Settings.instagramInboxReconcileEnabled, оба по умолчанию включены (прод: пушей единицы
// в день — Arvan Messenger ~4 человека в сутки, Instagram доставляет всё).
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { decryptSecretSafe } from "../crypto.js";
import { GRAPH_VERSION, instagramApiUrl, instagramRequest } from "../messengers/metaGraph.js";
import { sendPushToAgents } from "../push.js";
import { isMetaChannelEnabled, isMetaEnabled } from "../messengers/meta.js";
import { findAgentsWithPermission } from "./recipients.js";
import { customerPropertyEventKey, customerPropertyScopeKey } from "./customerPropertyScope.js";
import { logSystemError } from "./systemError.js";
import { noteInstagramKeyRefused } from "./instagramAccountAccess.js";
import { instagramRouteForToken } from "./metaEternalTokens.js";
import { MANAGEMENT_ALARM_ROLES, raiseCriticalAlarm } from "./channelKeyAlarm.js";

/** Пока вебхук мог ещё не дойти, Meta повторяет доставку после сбоя или бот ждёт склейки — не тревожим. */
export const GRACE_MS = 15 * 60_000;
/** Предохранитель срабатывает, когда сверено хотя бы столько входящих (меньше — обычный путь). */
export const MASS_MISSED_MIN_SAMPLE = 3;
/**
 * Сообщение пришло, пока этот процесс не работал (выкатка, падение): Meta может дослать его
 * после подъёма, и тогда ответит бот. Даём боту полчаса после старта процесса, потом зовём
 * человека (повторное ревью, Н1). Двойного ответа нет и позже: повтор Meta по сообщению,
 * о котором уже сказали человеку, вебхук принимает молча (isHandedToStaff ниже).
 */
export const AFTER_START_GRACE_MS = 30 * 60_000;
const PROCESS_STARTED_AT = Date.now();
/**
 * Сообщение Страницы считается ответом человека, только если оно пришло позже реплики
 * клиента больше чем на минуту (повторное ревью, Н2): автоответ Business Suite
 * («мгновенный ответ», «нет на месте») уходит за секунды и сигнал гасить не должен.
 */
export const AUTO_REPLY_WINDOW_MS = 60_000;
/** Глубже не смотрим: старое — дело разовой сверки со «да» владельца, не пуша. */
export const LOOKBACK_MS = 3 * 60 * 60_000;
const CONVERSATIONS_PER_PAGE = 25;
const MESSAGES_PER_CONVERSATION = 10;
const FETCH_TIMEOUT_MS = 15_000;
const CLAIM_CHANNEL = "meta-inbox-missed";

export type InboxChannel = "FACEBOOK" | "INSTAGRAM";

export interface PageInbox {
  /** Площадка: Messenger Страницы или Direct аккаунта Instagram. По умолчанию — FACEBOOK. */
  channel?: InboxChannel;
  /** Идентификатор Страницы / аккаунта Instagram (для тега пуша и журнала). */
  pageId: string;
  /** Все id, под которыми пишет сама Страница/аккаунт (у Instagram их два: user_id и id для переписки). */
  ownIds?: readonly string[];
  /** Ник аккаунта Instagram: реплика с этим ником — своя, даже если id в ней незнакомый. */
  ownUsername?: string;
  title: string;
  token: string;
}

export interface InboxMessage {
  mid: string;
  createdAt: Date;
  /** Page-scoped id собеседника — тот же, что subscriberId в BotConversation. */
  fromId: string;
  fromName: string | null;
  text: string;
}

/** Ответ Graph `/{page}/conversations` с вложенными сообщениями (только нужные поля). */
interface GraphConversations {
  data?: Array<{
    messages?: { data?: Array<{ id?: string; created_time?: string; message?: string; from?: { id?: string; name?: string; username?: string } }> };
  }>;
  error?: { code?: number; error_subcode?: number; message?: string };
}

/**
 * Входящие от людей (не от самой Страницы) в окне [now-lookback, now-grace], на
 * которые Страница ещё НЕ ответила. Ответ сотрудника из Meta Business Suite — это
 * сообщение Страницы позже реплики человека больше чем на AUTO_REPLY_WINDOW_MS: такую
 * реплику не трогаем (ревью 192-3). Мгновенный автоответ Страницы ответом не считается (Н2).
 * Чистая функция — проверяется без сети и базы.
 */
/** Текст сообщения для сравнения шаблонов: без регистра, лишних пробелов и знаков в конце. */
const templateKey = (text: string | undefined) => (text ?? "").toLowerCase().replace(/\s+/gu, " ").replace(/[\s!.?…]+$/u, "").trim();

/**
 * Тексты Страницы/аккаунта, которые повторяются в двух и более РАЗНЫХ переписках выборки, —
 * автоматизация (приветствие, «нет на месте», быстрый ответ), не живой ответ (Н2). Чистая функция.
 */
export function automatedTexts(own: ReadonlySet<string>, body: GraphConversations): Set<string> {
  const seenIn = new Map<string, number>();
  for (const conversation of body.data ?? []) {
    const here = new Set<string>();
    for (const m of conversation.messages?.data ?? []) {
      const key = templateKey(m.message);
      if (m.from?.id && own.has(m.from.id) && key) here.add(key);
    }
    for (const key of here) seenIn.set(key, (seenIn.get(key) ?? 0) + 1);
  }
  return new Set([...seenIn].filter(([, n]) => n >= 2).map(([key]) => key));
}

export function incomingFromGraph(pageId: string | readonly string[], body: GraphConversations, now: Date,
  window: { graceMs: number; lookbackMs: number; processStartedAt?: number } = { graceMs: GRACE_MS, lookbackMs: LOOKBACK_MS }): InboxMessage[] {
  const out: InboxMessage[] = [];
  const own = new Set(typeof pageId === "string" ? [pageId] : pageId);
  const automated = automatedTexts(own, body);
  const newest = now.getTime() - window.graceMs;
  const oldest = now.getTime() - window.lookbackMs;
  const startedAt = window.processStartedAt ?? PROCESS_STARTED_AT;
  for (const conversation of body.data ?? []) {
    const pageTimes: number[] = [];
    for (const m of conversation.messages?.data ?? []) {
      const at = m.created_time ? new Date(m.created_time).getTime() : NaN;
      // Шаблон автоматизации — не ответ человека, сигнал он не гасит (Н2).
      if (m.from?.id && own.has(m.from.id) && !Number.isNaN(at) && !automated.has(templateKey(m.message))) pageTimes.push(at);
    }
    for (const m of conversation.messages?.data ?? []) {
      const fromId = m.from?.id;
      if (!m.id || !m.created_time || !fromId || own.has(fromId)) continue;
      const createdAt = new Date(m.created_time);
      const at = createdAt.getTime();
      if (Number.isNaN(at) || at > newest || at < oldest) continue;
      // Человек Страницы ответил после этой реплики (а не автоответ за секунды) — уже отвечено.
      if (pageTimes.some((p) => p >= at + AUTO_REPLY_WINDOW_MS)) continue;
      // Пришло до старта процесса — ждём, не дошлёт ли Meta (бот ответит сам).
      if (at < startedAt && now.getTime() < startedAt + AFTER_START_GRACE_MS) continue;
      // Instagram отдаёт в `from` ник (username), а не имя (ревью 199-4): по @нику человека найдут в Direct.
      const fromName = m.from?.name?.trim() || (m.from?.username?.trim() ? `@${m.from.username.trim()}` : null);
      out.push({ mid: m.id, createdAt, fromId, fromName, text: (m.message ?? "").trim() });
    }
  }
  return out;
}

/** Все Страницы Facebook, у которых есть ключ: из Настроек и из «Каналов». Одна Страница — один раз. */
export async function listFacebookPageInboxes(): Promise<PageInbox[]> {
  const pages = new Map<string, PageInbox>();
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaPageToken: true, metaPageId: true } });
  const settingsId = settings?.metaPageId || process.env.META_PAGE_ID;
  const settingsToken = decryptSecretSafe(settings?.metaPageToken ?? null) || process.env.META_PAGE_TOKEN;
  const accounts = await prisma.messengerAccount.findMany({
    where: { channel: "FACEBOOK", enabled: true },
    select: { externalId: true, title: true, token: true },
  });
  for (const account of accounts) {
    const token = decryptSecretSafe(account.token);
    if (token) pages.set(account.externalId, { pageId: account.externalId, title: account.title, token });
  }
  if (settingsId && settingsToken && !pages.has(settingsId)) pages.set(settingsId, { pageId: settingsId, title: "Страница Facebook", token: settingsToken });
  return [...pages.values()];
}

/** Все аккаунты Instagram из «Каналов» с ключом (переписка ходит маркером аккаунта, вход через Instagram). */
export async function listInstagramInboxes(): Promise<PageInbox[]> {
  const accounts = await prisma.messengerAccount.findMany({
    where: { channel: "INSTAGRAM", enabled: true, accessLostAt: null },
    select: { externalId: true, messagingId: true, extraExternalIds: true, username: true, title: true, token: true },
  });
  const out: PageInbox[] = [];
  for (const account of accounts) {
    const token = decryptSecretSafe(account.token);
    if (!token) continue;
    // Без id для переписки свои ответы аккаунта не отличить от реплик клиента — была бы волна ложных
    // «Ответьте вручную» нашим же текстом (ревью 199-2). Такой аккаунт не сверяем и говорим об этом.
    if (!account.messagingId) {
      void logSystemError("meta", `Сверка Direct: у аккаунта Instagram «${account.title}» не определён id для переписки — ` +
        `его входящие с Meta не сверяются (проверка ника аккаунта в «Каналах» его заполнит).`,
        { dedupKey: `meta-inbox-ig-no-messaging-id:${account.externalId}`, dedupWindowMs: 6 * 60 * 60_000 });
      continue;
    }
    // Все «свои» id — те же, что считает своими остальной код (customerConversationScope, customerIngressClassification).
    const ownIds = [...new Set([account.externalId, account.messagingId, ...account.extraExternalIds].filter((id): id is string => !!id))];
    out.push({ channel: "INSTAGRAM", pageId: account.externalId, ownIds, ownUsername: account.username?.replace(/^@/, "").toLowerCase() || undefined,
      title: account.title, token });
  }
  return out;
}

/** Рубильники сверки по площадкам (правило владельца: у каждой сверки свой). */
export async function inboxReconcileSwitches(): Promise<Record<InboxChannel, boolean>> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" },
    select: { messengerInboxReconcileEnabled: true, instagramInboxReconcileEnabled: true } });
  return { FACEBOOK: s?.messengerInboxReconcileEnabled ?? true, INSTAGRAM: s?.instagramInboxReconcileEnabled ?? true };
}

export type GraphFetch = (url: string, headers?: Record<string, string>) => Promise<{ json(): Promise<unknown> }>;

const defaultFetch: GraphFetch = (url, headers) => fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

export async function fetchPageInbox(page: PageInbox, fetchImpl: GraphFetch = defaultFetch): Promise<GraphConversations> {
  const fields = `messages.limit(${MESSAGES_PER_CONVERSATION}){id,created_time,message,from}`;
  if (page.channel === "INSTAGRAM") {
    // Instagram — graph.instagram.com маркером аккаунта; с нашего сервера — через прокси, если он задан.
    // Аккаунт на постоянном ключе (21.11.2026) — через свою Страницу: сверка не слепнет,
    // когда личный маркер умер (а именно тогда она нужнее всего). IGSID у путей одни.
    const query = `platform=instagram&limit=${CONVERSATIONS_PER_PAGE}&fields=${encodeURIComponent(fields)}`;
    const route = await instagramRouteForToken(page.token);
    const req = route.kind === "page"
      ? { url: `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(route.pageId)}/conversations?${query}`, headers: { Authorization: `Bearer ${route.token}` } }
      : instagramRequest(instagramApiUrl(`/${GRAPH_VERSION}/me/conversations?${query}`), page.token);
    const body = (await (await fetchImpl(req.url, req.headers)).json()) as GraphConversations;
    // Своя реплика по нику — приводим к основному id, дальше правила общие (ревью 199-2).
    if (page.ownUsername) {
      for (const conversation of body.data ?? []) for (const m of conversation.messages?.data ?? []) {
        if (m.from?.username && m.from.username.toLowerCase() === page.ownUsername) m.from.id = page.pageId;
      }
    }
    return body;
  }
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(page.pageId)}/conversations` +
    `?platform=messenger&limit=${CONVERSATIONS_PER_PAGE}&fields=${encodeURIComponent(fields)}` +
    `&access_token=${encodeURIComponent(page.token)}`;
  const response = await fetchImpl(url);
  return (await response.json()) as GraphConversations;
}

/** Какие из mid CRM получила: отметка вебхука или реплика в ленте переписки. */
export async function knownMessageIds(messages: readonly InboxMessage[], channel: InboxChannel = "FACEBOOK"): Promise<Set<string>> {
  if (!messages.length) return new Set();
  const mids = [...new Set(messages.map((m) => m.mid))];
  const peers = [...new Set(messages.map((m) => m.fromId))];
  const marks = await prisma.processedMessage.findMany({
    where: { channel, messageId: { in: mids } },
    select: { messageId: true },
  });
  const known = new Set(marks.map((m) => m.messageId));
  const inChats = await prisma.$queryRaw<Array<{ mid: string }>>`
    SELECT DISTINCT m.elem ->> 'mid' AS "mid"
    FROM "BotConversation" c,
      jsonb_array_elements(CASE WHEN jsonb_typeof(c."messages")='array' THEN c."messages" ELSE '[]'::jsonb END) AS m(elem)
    WHERE c."channel"=${channel} AND c."subscriberId" = ANY(${peers}::text[]) AND m.elem ->> 'mid' = ANY(${mids}::text[])`;
  for (const row of inChats) if (row.mid) known.add(row.mid);
  // Сообщения нового ядра (ревью 199-3): mid попадает в чат, только когда ядро разберёт ход, а тикет пишется ДО ответа
  // Meta. Есть тикет — сообщение в CRM, его судьбу ведёт сторож молчания ядра, сверка «не дошло» не нужна.
  const unknown = messages.filter((m) => !known.has(m.mid));
  if (unknown.length) {
    const scopes = await prisma.customerEndpointScope.findMany({ where: { channel }, select: { id: true, messengerAccountId: true } });
    const byKey = new Map<string, string>();
    for (const m of unknown) for (const scope of scopes) {
      const scopeKey = scope.messengerAccountId
        ? customerPropertyScopeKey(channel, m.fromId, scope.messengerAccountId)
        : customerPropertyScopeKey(channel, m.fromId, null, scope.id);
      byKey.set(customerPropertyEventKey(scopeKey, "message", m.mid), m.mid);
    }
    if (byKey.size) {
      const tickets = await prisma.customerPropertyIngressTicket.findMany({ where: { eventKey: { in: [...byKey.keys()] } }, select: { eventKey: true } });
      for (const t of tickets) known.add(byKey.get(t.eventKey)!);
    }
  }
  return known;
}

/**
 * Наши ответы в выборке переписок, ОТПРАВЛЕННЫЕ CRM, и сколько из них CRM знает по mid (ревью #344,
 * третий круг). Отправленный CRM ответ узнаём так: его mid есть в CRM (отметка `out:meta` или mid
 * реплики в ленте переписки), либо его текст совпадает с не-ручной репликой CRM этому же человеку.
 * Ответы сотрудника руками из Instagram (в CRM они без mid и с пометкой «вручную») не считаются вовсе:
 * по ним не отличить поломку сверки от потери, и глушить пуши из-за них нельзя.
 */
export async function ownRepliesInCrm(ownIds: readonly string[], body: GraphConversations): Promise<{ crmSent: number; known: number }> {
  const own = new Set(ownIds);
  const ours: Array<{ mid: string; peer: string | null; text: string }> = [];
  for (const conversation of body.data ?? []) {
    const list = conversation.messages?.data ?? [];
    const peer = list.find((m) => m.from?.id && !own.has(m.from.id))?.from?.id ?? null;
    for (const m of list) if (m.id && m.from?.id && own.has(m.from.id)) ours.push({ mid: m.id, peer, text: (m.message ?? "").trim() });
  }
  if (!ours.length) return { crmSent: 0, known: 0 };
  const peers = [...new Set(ours.map((o) => o.peer).filter((p): p is string => !!p))];
  const marks = await prisma.processedMessage.findMany({ where: { channel: { in: ["out:meta", "INSTAGRAM"] }, messageId: { in: ours.map((o) => o.mid) } },
    select: { messageId: true } });
  const knownMids = new Set(marks.map((m) => m.messageId));
  const crmText = new Map<string, string[]>();
  if (peers.length) {
    const convs = await prisma.botConversation.findMany({ where: { channel: "INSTAGRAM", subscriberId: { in: peers } }, select: { subscriberId: true, messages: true } });
    for (const c of convs) for (const m of (Array.isArray(c.messages) ? c.messages : []) as Array<{ role?: string; content?: string; mid?: string; mid2?: string; by?: { kind?: string }; attachments?: { mid?: string }[] }>) {
      for (const id of [m.mid, m.mid2, ...(m.attachments ?? []).map((x) => x.mid)]) if (id) knownMids.add(id);
      if (m.role === "assistant" && m.by?.kind !== "manual" && m.content?.trim()) {
        crmText.set(c.subscriberId, [...(crmText.get(c.subscriberId) ?? []), m.content.trim()]);
      }
    }
  }
  let crmSent = 0;
  let known = 0;
  for (const o of ours) {
    if (knownMids.has(o.mid)) { crmSent++; known++; continue; }
    // Пузырь реплики CRM (двумя сообщениями) — часть её текста; короткие тексты не сравниваем: «Да» бывает у всех.
    const texts = o.peer ? crmText.get(o.peer) ?? [] : [];
    if (o.text.length >= 8 && texts.some((t) => t === o.text || t.includes(o.text))) crmSent++;
  }
  return { crmSent, known };
}

/** Текст ошибки без ключа: адрес запроса к Graph содержит access_token. */
export function withoutToken(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/access_token=[^&\s"']+/gi, "access_token=***").slice(0, 300);
}

/**
 * Повтор доставки Meta по сообщению, о котором человеку УЖЕ сказали «Ответьте вручную»
 * (повторное ревью, Н1). Сотрудник отвечает сам — бот отвечать не должен, иначе клиент
 * получит два ответа. Вебхук зовёт это до приёма и, если ВСЕ сообщения запроса такие,
 * отвечает Meta 200 и ничего не делает. Пустой список — false.
 */
export async function isHandedToStaff(mids: readonly string[]): Promise<boolean> {
  const unique = [...new Set(mids.filter(Boolean))];
  if (!unique.length) return false;
  const marks = await prisma.processedMessage.count({ where: { channel: CLAIM_CHANNEL, messageId: { in: unique } } });
  return marks === unique.length;
}

let graphFetchOverride: GraphFetch | null = null;
/** Только для тестов маршрута: подменить чтение Graph (null — вернуть настоящее). */
export function setInboxGraphFetchForTests(fetchImpl: GraphFetch | null): void {
  graphFetchOverride = fetchImpl;
}
const LATE_CHECK_TIMEOUT_MS = 4_000;
/** Meta повторяет доставку до 36 часов (docs Graph API Webhooks) — глубже смотреть незачем. */
const LATE_LOOKBACK_MS = 48 * 60 * 60_000;

export interface LateMessage { channel: string; accountExternalId?: string; senderId: string; messageId?: string; text?: string; name?: string }

/**
 * ПОЗДНЯЯ ДОСТАВКА ПОСЛЕ «ОТВЕТЬТЕ ВРУЧНУЮ» (ревью 199-1). Meta дослала сообщение, о котором сверка уже сказала
 * человеку. Человек ответил (живой ответ Страницы/аккаунта позже реплики, не шаблон) — true: бот молчит, второго
 * ответа нет. Не ответил, Graph не ответил за 4 с или переписку не нашли — false: сообщение идёт обычным путём
 * (текст в CRM, бот отвечает), чтобы ночью клиент не ждал до утра.
 */
export async function staffAnsweredLate(messages: readonly LateMessage[], now: Date = new Date()): Promise<boolean> {
  const first = messages[0];
  if (!first || (first.channel !== "FACEBOOK" && first.channel !== "INSTAGRAM")) return false;
  try {
    const inboxes = first.channel === "FACEBOOK" ? await listFacebookPageInboxes() : await listInstagramInboxes();
    const inbox = inboxes.find((i) => i.pageId === first.accountExternalId || i.ownIds?.includes(first.accountExternalId ?? ""));
    if (!inbox) return false;
    const fetchImpl = graphFetchOverride ?? defaultFetch;
    const body = await Promise.race([fetchPageInbox(inbox, fetchImpl),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LATE_CHECK_TIMEOUT_MS))]);
    if (!body || body.error) return false;
    const mids = new Set(messages.map((m) => m.messageId).filter((id): id is string => !!id));
    const seen = new Set<string>();
    for (const conversation of body.data ?? []) for (const m of conversation.messages?.data ?? []) if (m.id && mids.has(m.id)) seen.add(m.id);
    if (!seen.size) return false;
    const stillWaiting = new Set(incomingFromGraph(inbox.ownIds?.length ? inbox.ownIds : inbox.pageId, body, now,
      { graceMs: 0, lookbackMs: LATE_LOOKBACK_MS, processStartedAt: 0 }).map((m) => m.mid));
    // Каждое из найденных сообщений уже получило живой ответ человека.
    return [...seen].every((mid) => !stillWaiting.has(mid));
  } catch {
    return false;
  }
}

/**
 * Сообщение всё-таки дошло — тот же тег, что у «Ответьте вручную»: запись в колокольчике заменяется,
 * и человек видит текст и что бот отвечает сам. Не CRITICAL: срочность снята. Никогда не бросает.
 */
export async function notifyLateDelivery(messages: readonly LateMessage[]): Promise<void> {
  const first = messages[0];
  if (!first) return;
  try {
    const recipients = await findAgentsWithPermission("messages.view");
    if (!recipients.length) return;
    const inboxes = first.channel === "FACEBOOK" ? await listFacebookPageInboxes() : await listInstagramInboxes();
    const inbox = inboxes.find((i) => i.pageId === first.accountExternalId || i.ownIds?.includes(first.accountExternalId ?? ""));
    const place = first.channel === "INSTAGRAM" ? "Instagram" : "Facebook";
    const text = messages.map((m) => (m.text ?? "").trim()).filter(Boolean).join(" / ").slice(0, 160);
    await sendPushToAgents(recipients, {
      kind: "message",
      title: `Дошло до CRM: ${first.name?.trim() || "клиент"} (${place}${inbox ? ` «${inbox.title}»` : ""})`,
      body: `«${text || "вложение без текста"}». Сообщение, по которому просили ответить вручную, всё-таки дошло — текст в CRM, ` +
        `бот отвечает сам. Если вы уже ответили — проверьте переписку, чтобы не ответить дважды.`,
      url: "/messages",
      tag: `meta-inbox-missed-${inbox?.pageId ?? first.accountExternalId ?? "page"}-${first.senderId}`,
    });
  } catch (err) {
    void logSystemError("meta", `Пуш «дошло до CRM» после сверки не ушёл: ${withoutToken(err)}`, { dedupKey: "meta-inbox-late-push-failed" });
  }
}

/** Атомарно: true — этот mid ещё никому не показывали (двое не пройдут). */
async function claimMissed(mid: string): Promise<boolean> {
  const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt","completedAt")
    VALUES (${randomUUID()},${CLAIM_CHANNEL},${mid},now(),now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
  return claimed === 1;
}

export interface MetaInboxReconcileResult {
  pages: number;
  missed: number;
  people: number;
  failedPages: number;
  /** Instagram через Страницу: «потеряно» больше половины — пуши не отправлены (предохранитель). */
  massMissedPages: number;
  /** Instagram: массовая настоящая потеря входящих — руководству «проверьте подписку на вебхуки». */
  notDeliveredPages: number;
  /** Почему тик ничего не сверял: канал Meta выключен в Настройках. */
  skipped: "meta_disabled" | "switched_off" | null;
}

/** Тик крона. Никогда не бросает: сбой одной Страницы — строка в журнале, остальные сверяются. */
export async function runMetaInboxReconcile(now: Date = new Date(), fetchImpl: GraphFetch = defaultFetch,
  options: { processStartedAt?: number } = {}): Promise<MetaInboxReconcileResult> {
  const result: MetaInboxReconcileResult = { pages: 0, missed: 0, people: 0, failedPages: 0, massMissedPages: 0, notDeliveredPages: 0, skipped: null };
  let pages: PageInbox[];
  try {
    // Канал Meta выключен в Настройках — вебхук отвечает 503 намеренно, звать людей не о чем (ревью 192-9).
    if (!(await isMetaEnabled())) return { ...result, skipped: "meta_disabled" };
    const switches = await inboxReconcileSwitches();
    if (!switches.FACEBOOK && !switches.INSTAGRAM) return { ...result, skipped: "switched_off" };
    pages = [
      ...(switches.FACEBOOK ? await listFacebookPageInboxes() : []),
      // Канал Instagram выключен в Настройках — вебхук его не ждёт, звать людей не о чем (как 192-9).
      ...(switches.INSTAGRAM && (await isMetaChannelEnabled("INSTAGRAM")) ? await listInstagramInboxes() : []),
    ];
  } catch (err) {
    void logSystemError("meta", `Сверка переписок Страниц не запустилась: ${withoutToken(err)}`,
      { dedupKey: "meta-inbox-reconcile-failed" });
    return result;
  }
  let recipients: string[] | null = null;
  for (const page of pages) {
    result.pages++;
    try {
      const body = await fetchPageInbox(page, fetchImpl);
      if (body.error) {
        result.failedPages++;
        // Instagram «Meta закрыла доступ» — одна отметка через общую дверь, дальше сверка аккаунт не трогает.
        if (page.channel === "INSTAGRAM" && (await noteInstagramKeyRefused({ token: page.token, text: body.error.message ?? "",
          detail: `код ${body.error.code ?? "?"}: ${(body.error.message ?? "").slice(0, 160)}` })).locked) continue;
        // Код и подкод — без текста запроса: в адресе был ключ Страницы.
        void logSystemError("meta", `Сверка переписок: Meta не отдала переписки Страницы «${page.title}» ` +
          `(код ${body.error.code ?? "?"}/${body.error.error_subcode ?? "-"}). Не дошедшие до CRM сообщения этой Страницы сейчас не видны никому.`,
          { dedupKey: `meta-inbox-read-failed:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
        continue;
      }
      const channel: InboxChannel = page.channel ?? "FACEBOOK";
      const incoming = incomingFromGraph(page.ownIds?.length ? page.ownIds : page.pageId, body, now,
        { graceMs: GRACE_MS, lookbackMs: LOOKBACK_MS, processStartedAt: options.processStartedAt });
      const known = await knownMessageIds(incoming, channel);
      const missed = incoming.filter((m) => !known.has(m.mid));
      if (!missed.length) continue;
      /**
       * МАССОВАЯ «ПОТЕРЯ» В INSTAGRAM (ревью #344). «Не дошло» больше половины сверенного (из трёх+) —
       * это либо настоящая потеря (подписку на вебхуки выключили, как у Arvan 17.11), либо поломка
       * самой сверки (id сообщений на путях разошлись). Различаем по ответам, ОТПРАВЛЕННЫМ CRM, в этих
       * же переписках (ownRepliesInCrm): хоть один найден по mid — id путей совпадают, потеря настоящая:
       * пуши как раньше и тревога руководству «проверьте подписку». Такие ответы есть, ни один не найден,
       * а читаем через Страницу — сверка сломана: без пушей сотрудникам, журнал и одна несрочная тревога
       * в сутки. Ответов CRM в выборке нет (только ручные сотрудников или никаких) — доказать поломку
       * нечем, считаем потерю настоящей.
       * Facebook не трогаем: там массовая «потеря» — настоящий сигнал (Arvan 13–14.11, 1 из 8).
       */
      if (channel === "INSTAGRAM" && incoming.length >= MASS_MISSED_MIN_SAMPLE && missed.length * 2 > incoming.length) {
        const ours = await ownRepliesInCrm(page.ownIds?.length ? page.ownIds : [page.pageId], body);
        const viaPage = (await instagramRouteForToken(page.token)).kind === "page";
        if (viaPage && ours.crmSent > 0 && ours.known === 0) {
          result.massMissedPages++;
          void logSystemError("meta", `Сверка Direct «${page.title}» (через Страницу): ${missed.length} из ${incoming.length} входящих не найдены в CRM, ` +
            `и ни один из ${ours.crmSent} ответов, отправленных CRM, тоже. Похоже на поломку сверки (разные id сообщений на путях), а не на потерю — ` +
            `пуши сотрудникам не отправлены. Проверьте переписки аккаунта вручную.`,
            { dedupKey: `meta-inbox-mass-missed:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000, silent: true });
          await raiseCriticalAlarm({
            tag: `meta-inbox-mass-missed:${page.pageId}`,
            title: "Сверка Instagram: проверьте переписки вручную",
            body: `«${page.title}»: ${missed.length} из ${incoming.length} входящих не найдены в CRM, наши ответы тоже не сверяются. Срочные пуши сотрудникам не отправлены. Откройте Direct аккаунта и сверьте с CRM.`,
            url: "/messages",
            quiet: true,
            recipientRoles: MANAGEMENT_ALARM_ROLES,
            everyMs: 24 * 60 * 60_000,
          });
          continue;
        }
        await raiseCriticalAlarm({
          tag: `meta-inbox-ig-not-delivered:${page.pageId}`,
          title: "Входящие Instagram не доходят до CRM",
          body: `«${page.title}»: ${missed.length} из ${incoming.length} входящих не дошли. Проверьте подписку на вебхуки в кабинете Meta: ` +
            `developers.facebook.com → приложение → Instagram → «Настройка API для входа в Instagram» → «Подписка на Webhooks» должна быть включена.`,
          url: "/messages",
          quiet: true,
          recipientRoles: MANAGEMENT_ALARM_ROLES,
          everyMs: 24 * 60 * 60_000,
        });
        result.notDeliveredPages++;
      }
      // Один пуш на человека за тик, даже если он написал пять сообщений подряд.
      const byPerson = new Map<string, InboxMessage[]>();
      for (const m of missed) byPerson.set(m.fromId, [...(byPerson.get(m.fromId) ?? []), m]);
      recipients ??= await findAgentsWithPermission("messages.view");
      if (!recipients.length) {
        // Отметок не ставим: появится получатель — сигнал уйдёт (ревью 192-2).
        void logSystemError("meta", `Страница «${page.title}»: ${byPerson.size} чел. не дошли до CRM, но в CRM нет никого с правом «Сообщения» — сказать некому.`,
          { dedupKey: `meta-inbox-no-recipients:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
        continue;
      }
      let told = 0;
      for (const [fromId, list] of byPerson) {
        // Отметка и пуш — по одному человеку; пуш не ушёл — отметки ЭТОГО человека снимаются,
        // следующий тик попробует снова (ревью 192-2: раньше отметки всех ставились до пушей и терялись).
        const fresh: InboxMessage[] = [];
        for (const m of list) if (await claimMissed(m.mid)) fresh.push(m);
        if (!fresh.length) continue;
        fresh.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const last = fresh[fresh.length - 1]!;
        const name = last.fromName ?? "Клиент";
        const excerpt = last.text ? `«${last.text.slice(0, 120)}»` : "вложение без текста";
        try {
          await sendPushToAgents(recipients, {
            kind: "message",
            level: "CRITICAL",
            title: `Ответьте вручную: ${name} (${channel === "INSTAGRAM" ? "Instagram" : "Facebook"} «${page.title}»)`,
            body: `${excerpt}${fresh.length > 1 ? ` и ещё ${fresh.length - 1}` : ""}. Сообщение не дошло до CRM, бот его не видел. ` +
              (channel === "INSTAGRAM"
                ? `Ответьте в Instagram (Direct аккаунта «${page.title}») или в Meta Business Suite → «Входящие».`
                : `Ответьте в Meta Business Suite (business.facebook.com) → «Входящие» Страницы.`),
            // Ссылка внутри CRM: колокольчик открывает только свои адреса. Где отвечать — сказано в тексте.
            url: "/messages",
            tag: `meta-inbox-missed-${page.pageId}-${fromId}`,
          });
          told++;
          result.missed += fresh.length;
          result.people++;
        } catch (err) {
          await prisma.processedMessage.deleteMany({ where: { channel: CLAIM_CHANNEL, messageId: { in: fresh.map((m) => m.mid) } } }).catch(() => {});
          void logSystemError("meta", `Пуш «Ответьте вручную» по Странице «${page.title}» не ушёл, повторим: ${withoutToken(err)}`,
            { dedupKey: `meta-inbox-push-failed:${page.pageId}` });
        }
      }
      if (!told) continue;
      void logSystemError("meta",
        `${channel === "INSTAGRAM" ? "Instagram" : "Страница"} «${page.title}»: ${told} чел. написали в ${channel === "INSTAGRAM" ? "Direct" : "Messenger"}, а до CRM сообщения не дошли — бот их не видел, ` +
          `сотрудникам ушёл пуш «Ответьте вручную». Частая причина — у приложения нет расширенного доступа к Messenger ` +
          `(Meta доставляет только людей с ролью в приложении): нужна проверка приложения (App Review).`,
        { dedupKey: `meta-inbox-missed:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
    } catch (err) {
      result.failedPages++;
      void logSystemError("meta", `Сверка переписок Страницы «${page.title}» оборвалась: ${withoutToken(err)}`,
        { dedupKey: `meta-inbox-reconcile-page-failed:${page.pageId}`, dedupWindowMs: 6 * 60 * 60_000 });
    }
  }
  return result;
}
