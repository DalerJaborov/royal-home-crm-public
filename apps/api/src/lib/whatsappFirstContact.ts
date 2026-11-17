/**
 * ПЕРВОЕ СООБЩЕНИЕ КЛИЕНТУ В WHATSAPP (24.09.2026, просьба владельца).
 *
 * Живой случай: клиент разрешил написать ему в WhatsApp, но сам не пишет — номер
 * агентства он не помнит. А мы написать ему не можем: Meta пускает свободный
 * текст только в течение суток после сообщения клиента. Законный путь один —
 * заранее одобренный Meta текст («шаблон»). Каждое такое сообщение Meta берёт
 * деньгами, поэтому повтор без ответа клиента закрыт.
 *
 * Как это работает целиком:
 *   1. Настройки → Каналы → «Первое сообщение в WhatsApp»: одна кнопка
 *      отправляет оба текста (packages/shared/whatsappFirstContact.ts) в Meta
 *      на проверку, там же видно «на проверке / одобрено / отклонено».
 *   2. Карточка клиента → «Написать в WhatsApp»: уходит одобренный текст с
 *      кнопкой «Да, присылайте», он же ложится в переписку клиента, бот на
 *      паузе (писал человек — тот же закон, что у ручного ответа).
 *   3. Клиент ответил (или нажал кнопку) — окно открыто. Если сообщение было
 *      про объект, ссылка на него уходит сама; агенту приходит пуш «клиент
 *      ответил, можно отправлять видео».
 *   4. Не дошло (нет WhatsApp, Meta не взяла оплату) — Meta сообщает это
 *      отдельно, позже; агенту пуш с причиной словами, в карточке та же причина.
 *
 * Транспорт до Meta подменяется в тестах (`__setWaTemplateTransportForTests`),
 * как у СМС: общая строка Settings в тестах не трогается — тесты сервера идут в
 * два процесса на одной базе, и чужой тест упал бы от наших ключей.
 */
import {
  WA_FIRST_CONTACT_BUTTON,
  WA_FIRST_CONTACT_LANGUAGE,
  WA_FIRST_CONTACT_TEMPLATES,
  renderWaFirstContactText,
  toWhatsAppRecipient,
  type WaFirstContactStatus,
  type WaFirstContactTemplateKey,
  type WaTemplateReview,
  type WaTemplateReviewState,
  type WaTemplatesOverview,
} from "@royal-home/shared";
import { prisma } from "../db.js";
import { callGraph, fetchWithRetry, GRAPH_VERSION, isMetaChannelEnabled, loadCredentials } from "../messengers/meta.js";
import { resolveIncomingAccount } from "../messengers/accounts.js";
import { appendConversationMessages } from "../messengers/appendMessages.js";
import { recordExposures } from "./propertyExposures.js";
import { ensureCustomerEndpoint, ensureScopedBotConversation, loadCustomerTransportForConversation,
  type CustomerTransportReference } from "./customerConversationScope.js";
import {
  agentSender,
  applyDeliveryPause,
  defaultPauseForSender,
  deliverToConversation,
  type DeliveryTarget,
} from "./conversationDelivery.js";
import { logTimeline } from "./timeline.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { markAgentAttempt } from "./clientWorkStalled.js";
import { sendPushToAgent } from "../push.js";
import { siteListingUrl } from "./siteListingUrl.js";
import { getOrCreatePropertyShareLinks } from "./propertyShareLink.js";
import { buildPropertyOfferText, formatPriceForClient } from "./propertyOfferText.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";

/** Сколько ждём ответа, прежде чем разрешить второе платное сообщение тому же клиенту. */
export const FIRST_CONTACT_REPEAT_HOURS = 72;
/** Окно Meta: столько после сообщения клиента можно писать ему свободно. */
export const MESSAGING_WINDOW_HOURS = 24;
/** Ответ клиента считается ответом на первое сообщение не дольше этого срока. */
const REPLY_MATCH_DAYS = 30;
/** Статусы текстов у Meta меняются редко — не спрашиваем её на каждое открытие карточки. */
const REVIEW_CACHE_MS = 5 * 60 * 1000;

// ─── Транспорт до Meta ───────────────────────────────────────────────────────

export interface WaTemplateConfig {
  phoneId: string;
  token: string;
  /** Кабинет WhatsApp (WABA). Без него тексты не проверить и не отправить на одобрение. */
  businessAccountId: string | null;
}

/** Текст так, как его отдаёт Meta в списке шаблонов кабинета. */
export interface MetaTemplateRow {
  name: string;
  language: string;
  status: string;
  category?: string;
  rejected_reason?: string;
}

export interface WaTemplateTransport {
  /** null — WhatsApp не подключён или выключен в Настройках. */
  config(): Promise<WaTemplateConfig | null>;
  send(config: WaTemplateConfig, to: string, templateName: string, params: string[]): Promise<{ messageId: string | null }>;
  list(config: WaTemplateConfig & { businessAccountId: string }): Promise<MetaTemplateRow[]>;
  create(config: WaTemplateConfig & { businessAccountId: string }, key: WaFirstContactTemplateKey): Promise<void>;
}

/** Тело запроса отправки — отдельно, чтобы тест сверял его с тем, что ждёт Meta. */
export function buildTemplateSendBody(to: string, templateName: string, params: string[]) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: WA_FIRST_CONTACT_LANGUAGE },
      components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
    },
  };
}

/** Тело запроса «отправить текст на одобрение». */
export function buildTemplateCreateBody(key: WaFirstContactTemplateKey) {
  const t = WA_FIRST_CONTACT_TEMPLATES[key];
  return {
    name: t.name,
    language: WA_FIRST_CONTACT_LANGUAGE,
    // «Служебное»: ответ на просьбу самого клиента. Meta может переложить в
    // «маркетинг» сама — цена тогда чуть выше, работать это не мешает.
    category: "UTILITY",
    components: [
      { type: "BODY", text: t.body, example: { body_text: [t.examples] } },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: WA_FIRST_CONTACT_BUTTON }] },
    ],
  };
}

const realTransport: WaTemplateTransport = {
  async config() {
    if (!(await isMetaChannelEnabled("WHATSAPP"))) return null;
    const c = await loadCredentials();
    const token = (await resolveIncomingAccount("WHATSAPP", c.waPhoneId)).token || c.waToken;
    if (!c.waPhoneId || !token) return null;
    const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { metaWaBusinessAccountId: true } });
    let businessAccountId = s?.metaWaBusinessAccountId ?? null;
    if (!businessAccountId) businessAccountId = await discoverBusinessAccountId(token);
    return { phoneId: c.waPhoneId, token, businessAccountId };
  },
  async send(config, to, templateName, params) {
    const res = await callGraph<{ messages?: { id?: string }[] }>(
      `https://graph.facebook.com/${GRAPH_VERSION}/${config.phoneId}/messages`,
      config.token,
      buildTemplateSendBody(to, templateName, params)
    );
    return { messageId: res?.messages?.[0]?.id ?? null };
  },
  async list(config) {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${config.businessAccountId}/message_templates` +
      `?fields=name,language,status,category,rejected_reason&limit=200`;
    const res = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${config.token}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`Graph API HTTP ${res.status}: ${text.slice(0, 300)}`);
    return (JSON.parse(text) as { data?: MetaTemplateRow[] }).data ?? [];
  },
  async create(config, key) {
    await callGraph(
      `https://graph.facebook.com/${GRAPH_VERSION}/${config.businessAccountId}/message_templates`,
      config.token,
      buildTemplateCreateBody(key)
    );
  },
};

let testTransport: WaTemplateTransport | null = null;

/** Только для тестов: подменить Meta (null — вернуть настоящую). */
export function __setWaTemplateTransportForTests(transport: WaTemplateTransport | null): void {
  testTransport = transport;
  reviewCache = null;
}

function transport(): WaTemplateTransport {
  return testTransport ?? realTransport;
}

// ─── Кабинет WhatsApp (WABA) ─────────────────────────────────────────────────

/**
 * Найти кабинет по самому маркеру: Meta отвечает, к каким кабинетам у него
 * есть право `whatsapp_business_management`. Один кабинет — он и наш.
 * Запасной путь на случай, когда вебхука ещё не было (см. rememberBusinessAccountFromWebhook).
 */
async function discoverBusinessAccountId(token: string): Promise<string | null> {
  try {
    const url =
      `https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(token)}` +
      `&access_token=${encodeURIComponent(token)}`;
    const res = await fetchWithRetry(url, {});
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { granular_scopes?: { scope?: string; target_ids?: string[] }[] } };
    const ids = body.data?.granular_scopes?.find((g) => g.scope === "whatsapp_business_management")?.target_ids ?? [];
    if (ids.length !== 1) return null;
    await saveBusinessAccountId(ids[0]);
    return ids[0];
  } catch (err) {
    console.error("[whatsapp] кабинет по маркеру не найден:", describeError(err));
    return null;
  }
}

let knownBusinessAccountId: string | null = null;

/** Кабинет поменяли руками в Настройках — забыть запомненное. */
export function resetWaTemplateCaches(): void {
  knownBusinessAccountId = null;
  reviewCache = null;
}

async function saveBusinessAccountId(id: string): Promise<void> {
  // Только в пустое поле: вписанное вручную не перетираем.
  await prisma.settings.updateMany({ where: { id: "singleton", metaWaBusinessAccountId: null }, data: { metaWaBusinessAccountId: id } });
  knownBusinessAccountId = id;
  reviewCache = null;
}

/**
 * Кабинет из вебхука: у WhatsApp `entry[].id` — это и есть его идентификатор.
 * Берём только запись, пришедшую на НАШ номер (у приложения рядом живёт номер
 * песочницы со своим кабинетом). Запись в базу — один раз, дальше память процесса.
 */
export async function rememberBusinessAccountFromWebhook(body: unknown, ourPhoneIds: string[] | undefined): Promise<void> {
  const payload = body as {
    object?: string;
    entry?: { id?: string; changes?: { value?: { metadata?: { phone_number_id?: string } } }[] }[];
  } | null;
  if (payload?.object !== "whatsapp_business_account") return;
  const ours = new Set(ourPhoneIds ?? []);
  for (const entry of payload.entry ?? []) {
    if (!entry.id) continue;
    const phoneIds = (entry.changes ?? []).map((c) => c.value?.metadata?.phone_number_id).filter(Boolean) as string[];
    if (ours.size > 0 && !phoneIds.some((id) => ours.has(id))) continue;
    if (knownBusinessAccountId === entry.id) return;
    try {
      await saveBusinessAccountId(entry.id);
    } catch (err) {
      console.error("[whatsapp] кабинет из вебхука не записан:", describeError(err));
    }
    return;
  }
}

// ─── Статусы текстов у Meta ──────────────────────────────────────────────────

let reviewCache: { at: number; overview: WaTemplatesOverview } | null = null;

function reviewState(status: string | undefined): WaTemplateReviewState {
  switch ((status ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "PENDING":
    case "IN_APPEAL":
      return "pending";
    case "REJECTED":
      return "rejected";
    case "PAUSED":
      return "paused";
    case "":
      return "missing";
    default:
      return "disabled";
  }
}

/** Разбор списка шаблонов кабинета в наши два текста. Чистая — ради теста. */
export function reviewsFromMetaRows(rows: MetaTemplateRow[]): WaTemplateReview[] {
  return (Object.keys(WA_FIRST_CONTACT_TEMPLATES) as WaFirstContactTemplateKey[]).map((key) => {
    const t = WA_FIRST_CONTACT_TEMPLATES[key];
    const row = rows.find((r) => r.name === t.name && r.language === WA_FIRST_CONTACT_LANGUAGE);
    const rejected = row?.rejected_reason && row.rejected_reason !== "NONE" ? row.rejected_reason : null;
    return {
      key,
      name: t.name,
      body: t.body,
      state: row ? reviewState(row.status) : "missing",
      reason: rejected,
      category: row?.category ?? null,
    };
  });
}

function emptyReviews(): WaTemplateReview[] {
  return reviewsFromMetaRows([]);
}

export async function waTemplatesOverview(force = false): Promise<WaTemplatesOverview> {
  if (!force && reviewCache && Date.now() - reviewCache.at < REVIEW_CACHE_MS) return reviewCache.overview;
  const config = await transport().config();
  let overview: WaTemplatesOverview;
  if (!config) {
    overview = { connected: false, accountKnown: false, templates: emptyReviews(), error: null };
  } else if (!config.businessAccountId) {
    overview = { connected: true, accountKnown: false, templates: emptyReviews(), error: null };
  } else {
    try {
      const rows = await transport().list({ ...config, businessAccountId: config.businessAccountId });
      overview = { connected: true, accountKnown: true, templates: reviewsFromMetaRows(rows), error: null };
    } catch (err) {
      // Отказ Meta не кэшируем надолго: пусть следующий заход спросит снова.
      return {
        connected: true,
        accountKnown: true,
        templates: emptyReviews(),
        error: `Meta не ответила: ${describeMetaError(err)}`,
      };
    }
  }
  reviewCache = { at: Date.now(), overview };
  return overview;
}

/** Отправить в Meta на проверку те тексты, которых у неё ещё нет (или отклонённые). */
export async function submitWaTemplates(): Promise<WaTemplatesOverview> {
  const config = await transport().config();
  if (!config) throw new FirstContactError(503, "WhatsApp не подключён или выключен в Настройках → Каналы.");
  if (!config.businessAccountId) {
    throw new FirstContactError(
      409,
      "CRM ещё не знает ваш кабинет WhatsApp. Он определится сам после первого сообщения клиента в WhatsApp, или впишите его ниже."
    );
  }
  const current = await waTemplatesOverview(true);
  const withAccount = { ...config, businessAccountId: config.businessAccountId };
  for (const t of current.templates) {
    if (t.state !== "missing") continue;
    try {
      await transport().create(withAccount, t.key);
    } catch (err) {
      reviewCache = null;
      throw new FirstContactError(502, `Meta не приняла текст «${t.name}»: ${describeMetaError(err)}`);
    }
  }
  return waTemplatesOverview(true);
}

// ─── Ошибки Meta словами ─────────────────────────────────────────────────────

export class FirstContactError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Код ошибки Meta из текста ответа (`"code":131026`). */
export function metaErrorCode(text: string): number | null {
  const m = /"code"\s*:\s*(\d+)/.exec(text);
  return m ? Number(m[1]) : null;
}

/** Причины, по которым не дошло КОНКРЕТНОМУ человеку, — не поломка CRM, в журнал не идут. */
const RECIPIENT_SIDE_CODES = new Set([131026, 131049, 131050, 131056, 130472]);

const REASONS: Record<number, string> = {
  131026: "у этого номера нет WhatsApp (или очень старое приложение). Позвоните клиенту.",
  131049: "Meta не доставила: этому человеку недавно писало много компаний. Попробуйте завтра или позвоните.",
  131050: "клиент отключил у себя в WhatsApp сообщения от компаний.",
  131056: "слишком много сообщений этому номеру подряд. Подождите несколько минут.",
  130472: "Meta сейчас не доставляет компаниям сообщения на этот номер. Позвоните клиенту.",
  131042: "Meta не приняла оплату. Нужно привязать карту: Meta Business → WhatsApp → Оплата.",
  131031: "Meta заблокировала кабинет WhatsApp. Это видно в Meta Business → WhatsApp.",
  132001: "Meta не нашла одобренный текст. Проверьте Настройки → Каналы → «Первое сообщение в WhatsApp».",
  132015: "Meta приостановила этот текст (на него жаловались получатели).",
  132016: "Meta отключила этот текст.",
  132000: "текст и подстановки не совпали — нужна правка в CRM.",
  132012: "текст и подстановки не совпали — нужна правка в CRM.",
  190: "маркер WhatsApp просрочен. Обновите его в Настройках → Каналы.",
  10: "у маркера WhatsApp нет права на это действие.",
  200: "у маркера WhatsApp нет права на это действие.",
};

export function describeMetaError(err: unknown, code?: number | null): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  const c = code ?? metaErrorCode(text);
  if (c !== null && REASONS[c]) return REASONS[c];
  const message = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1];
  return message ?? (text.slice(0, 200) || "причину Meta не назвала");
}

// ─── Состояние кнопки в карточке ─────────────────────────────────────────────

type ClientForContact = {
  id: string;
  phone: string;
  whatsappPhone: string | null;
  deletedAt: Date | null;
};

function recipientOf(client: ClientForContact): string | null {
  return toWhatsAppRecipient(client.whatsappPhone) ?? toWhatsAppRecipient(client.phone);
}

/** Когда клиент последний раз писал нам в WhatsApp сам — по его репликам в переписке. */
async function lastClientWhatsAppMessageAt(clientId: string, recipient: string): Promise<Date | null> {
  const conversations = await prisma.botConversation.findMany({
    where: { channel: "WHATSAPP", OR: [{ clientId }, { subscriberId: recipient }] },
    select: { messages: true },
    take: 5,
  });
  let latest: Date | null = null;
  for (const c of conversations) {
    const messages = (c.messages as unknown as { role?: string; at?: string }[]) ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "user" || !messages[i].at) continue;
      const at = new Date(messages[i].at!);
      if (!latest || at > latest) latest = at;
      break;
    }
  }
  return latest;
}

async function agentFirstName(agentId: string): Promise<string> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
  const full = agent?.fullName?.trim() || "Royal Home";
  return full.split(/\s+/)[0] || full;
}

type LastRow = Awaited<ReturnType<typeof lastFirstContact>>;

async function lastFirstContact(clientId: string) {
  return prisma.whatsAppFirstContact.findFirst({ where: { clientId }, orderBy: { sentAt: "desc" } });
}

async function presentLast(row: LastRow): Promise<WaFirstContactStatus["last"]> {
  if (!row) return null;
  const [property, agent] = await Promise.all([
    row.propertyId ? prisma.property.findUnique({ where: { id: row.propertyId }, select: { shortId: true } }) : null,
    prisma.agent.findUnique({ where: { id: row.agentId }, select: { fullName: true } }),
  ]);
  return {
    sentAt: row.sentAt.toISOString(),
    status: row.status as NonNullable<WaFirstContactStatus["last"]>["status"],
    failReason: row.failReason,
    propertyShortId: property?.shortId ?? null,
    agentName: agent?.fullName ?? null,
  };
}

/**
 * ЗАМОК, КОТОРЫЙ НЕКОМУ СНЯТЬ (25.09.2026). Строка заводится ДО отправки и
 * получает `waMessageId` сразу после неё (sendFirstContactOnce ниже). Значит
 * строка без `waMessageId` спустя минуты — это процесс, убитый между замком и
 * отправкой: снимать её отказ некому, а без этой оговорки она заперла бы
 * сотрудника на 72 часа.
 *
 * Хуже сегодняшнего это не делает НИ В ОДНОМ случае: сегодня строки нет вовсе и
 * второе сообщение уходит сразу, а тут — не раньше пяти минут и только если
 * отправка успела пройти, а запись номера нет (один `await` шириной).
 */
const LOCK_STALE_MS = 5 * 60_000;

function isAwaitingReply(row: LastRow): boolean {
  if (!row || row.repliedAt || row.status === "FAILED" || row.status === "REPLIED") return false;
  if (!row.waMessageId && Date.now() - row.sentAt.getTime() > LOCK_STALE_MS) return false;
  return Date.now() - row.sentAt.getTime() < FIRST_CONTACT_REPEAT_HOURS * 3600_000;
}

/** Какой из одобренных текстов брать: про объект — если он одобрен, иначе общий. */
function pickTemplate(reviews: WaTemplateReview[], wantProperty: boolean): WaFirstContactTemplateKey | null {
  const approved = (key: WaFirstContactTemplateKey) => reviews.find((r) => r.key === key)?.state === "approved";
  if (wantProperty && approved("property")) return "property";
  if (approved("general")) return "general";
  return null;
}

export async function firstContactStatus(client: ClientForContact, agentId: string): Promise<WaFirstContactStatus> {
  const [agentName, lastRow] = await Promise.all([agentFirstName(agentId), lastFirstContact(client.id)]);
  const last = await presentLast(lastRow);
  let propertyTextReady = false;
  const status = (state: WaFirstContactStatus["state"], hint: string): WaFirstContactStatus => ({
    state,
    hint,
    agentName,
    propertyTextReady,
    last,
  });

  const recipient = recipientOf(client);
  if (!recipient) return status("no_phone", "У клиента нет номера, похожего на WhatsApp. Проверьте номер в карточке.");

  const lastIncoming = await lastClientWhatsAppMessageAt(client.id, recipient);
  if (lastIncoming && Date.now() - lastIncoming.getTime() < MESSAGING_WINDOW_HOURS * 3600_000) {
    return status(
      "window_open",
      "Клиент писал в WhatsApp меньше суток назад — просто ответьте ему в переписке, это бесплатно."
    );
  }

  if (isAwaitingReply(lastRow)) {
    return status("recently_sent", "Первое сообщение уже ушло. Как только клиент ответит, придёт уведомление.");
  }

  const overview = await waTemplatesOverview();
  if (!overview.connected) return status("not_connected", "WhatsApp не подключён к CRM.");
  const general = overview.templates.find((t) => t.key === "general");
  propertyTextReady = overview.templates.find((t) => t.key === "property")?.state === "approved";
  if (pickTemplate(overview.templates, true)) {
    return status("ready", "Клиенту уйдёт одобренное Meta сообщение с кнопкой «Да, присылайте».");
  }
  if (general?.state === "pending") {
    return status("texts_pending", "Текст первого сообщения на проверке у Meta. Кнопка заработает, когда его одобрят.");
  }
  if (general?.state === "rejected" || general?.state === "paused" || general?.state === "disabled") {
    return status("texts_rejected", "Meta не одобрила текст первого сообщения. Подробности — в Настройках → Каналы.");
  }
  return status(
    "texts_missing",
    "Текст первого сообщения ещё не одобрен Meta. Руководитель отправляет его на проверку в Настройках → Каналы."
  );
}

// ─── Отправка ────────────────────────────────────────────────────────────────

/** Переписка WhatsApp этого номера: найти или завести, привязав к карточке. */
async function ensureConversation(recipient: string, clientId: string, name: string, transport: CustomerTransportReference): Promise<string> {
  return prisma.$transaction(async tx => {
    const scoped = await ensureScopedBotConversation(tx, { channel: "WHATSAPP", subscriberId: recipient, transport });
    const row = await tx.botConversation.findUniqueOrThrow({ where: { id: scoped.id }, select: { id: true, clientId: true } });
    // This authorized staff path keeps the existing rule: never overwrite a
    // foreign client binding just because the destination phone was supplied.
    if (!row.clientId) await tx.botConversation.update({ where: { id: row.id }, data: { clientId, name } });
    return row.id;
  });
}

export interface SendFirstContactInput {
  client: ClientForContact & { fullName: string };
  agentId: string;
  propertyShortId?: number | null;
}

/**
 * Клиенты, которым отправка идёт прямо сейчас. Двойное нажатие успело бы до
 * записи строки об отправке, и Meta взяла бы деньги за два одинаковых сообщения.
 *
 * ОТ КЛАССА «отправили, записать не успели» ЭТО НЕ ЗАЩИЩАЕТ ВОВСЕ (25.09.2026).
 * Множество живёт в памяти ОДНОГО процесса, а их два — API и worker, — и от
 * отказа базы на записи оно не спасает никак: снимается в `finally`, то есть
 * ровно тогда, когда строки об отправке может уже не быть. Настоящую защиту
 * даёт замок в базе (`sendFirstContactOnce` ниже), эта проверка осталась только
 * как дешёвая отсечка двойного нажатия в одном процессе.
 */
const inFlight = new Set<string>();

export async function sendFirstContact(input: SendFirstContactInput): Promise<WaFirstContactStatus> {
  if (inFlight.has(input.client.id)) throw new FirstContactError(409, "Сообщение этому клиенту уже отправляется.");
  inFlight.add(input.client.id);
  try {
    return await sendFirstContactOnce(input);
  } finally {
    inFlight.delete(input.client.id);
  }
}

async function sendFirstContactOnce(input: SendFirstContactInput): Promise<WaFirstContactStatus> {
  const { client, agentId } = input;
  const current = await firstContactStatus(client, agentId);
  if (current.state !== "ready") throw new FirstContactError(409, current.hint);

  const property = input.propertyShortId
    ? await prisma.property.findFirst({
        where: { shortId: input.propertyShortId, deletedAt: null },
        select: { id: true, shortId: true, status: true },
      })
    : null;
  if (input.propertyShortId && !property) throw new FirstContactError(404, `Объект №${input.propertyShortId} не найден`);
  if (property?.status === "SOLD") throw new FirstContactError(409, `Объект №${property.shortId} уже продан`);

  const overview = await waTemplatesOverview();
  const key = pickTemplate(overview.templates, !!property);
  const config = await transport().config();
  if (!key || !config) throw new FirstContactError(409, current.hint);
  const recipient = recipientOf(client);
  if (!recipient) throw new FirstContactError(409, "Номер WhatsApp клиента не задан.");
  const customerTransport = await prisma.$transaction(tx => ensureCustomerEndpoint(tx, {
    channel: "WHATSAPP", subscriberId: recipient,
    accountExternalId: config.phoneId,
  }));

  const agentName = current.agentName;
  const params = key === "property" ? [agentName, String(property!.shortId)] : [agentName];
  const templateName = WA_FIRST_CONTACT_TEMPLATES[key].name;

  /**
   * ЗАМОК ДО ОТПРАВКИ, А НЕ ОТМЕТКА ПОСЛЕ НЕЁ (25.09.2026, разбор класса
   * «запись сначала, маркер потом»).
   *
   * Было: шаблон уходил клиенту, и только после ТРЁХ ожиданий подряд
   * (`ensureConversation`, `appendConversationMessages`, `applyDeliveryPause`)
   * писалась строка «отправлено». Падение любого из трёх — и шаблон ушёл, а
   * строки нет; гейт `firstContactStatus` смотрит именно её
   * (`lastFirstContact` → `isAwaitingReply`) и пропускал ВТОРОЕ платное
   * сообщение тому же человеку. Окно было в четыре шага шириной.
   *
   * Стало: строка заводится первой и сама служит замком — гейт видит её сразу,
   * и повтор блокируется, даже если дальше всё упадёт. Отказ отправки снимает
   * замок статусом FAILED, тем же приёмом, что `releaseProcessedMessage` у
   * заявок сайта (`routes/webhooks.ts`). Номер сообщения дописывается первым же
   * запросом после отправки: тогда и вебхук «доставлено/прочитано», который
   * ищет строку по `waMessageId`, не разминётся с ней.
   */
  const lock = await prisma.whatsAppFirstContact.create({
    data: {
      clientId: client.id,
      agentId,
      recipient,
      propertyId: property?.id ?? null,
      templateName,
    },
    select: { id: true },
  });

  let messageId: string | null;
  try {
    messageId = (await transport().send(config, recipient, templateName, params)).messageId;
  } catch (err) {
    const code = metaErrorCode(err instanceof Error ? err.message : String(err));
    const reason = describeMetaError(err, code);
    // Снимаем замок: FAILED выводит строку из `isAwaitingReply`, и честный
    // повтор проходит сразу, а не через 72 часа.
    await prisma.whatsAppFirstContact.update({
      where: { id: lock.id },
      data: { status: "FAILED", failReason: reason },
    });
    if (code === null || !RECIPIENT_SIDE_CODES.has(code)) {
      void logSystemError("meta", `Первое сообщение в WhatsApp не отправлено: ${describeError(err)}`);
    }
    throw new FirstContactError(502, `Не отправлено: ${reason}`);
  }

  // Первым же запросом после отправки — до переписки, паузы и хронологии.
  if (messageId) await prisma.whatsAppFirstContact.update({ where: { id: lock.id }, data: { waMessageId: messageId } });

  // В переписку клиента — ровно тот текст, что он получил, с подписью сотрудника.
  const conversationId = await ensureConversation(recipient, client.id, client.fullName, customerTransport);
  const sender = await agentSender(agentId);
  const text = `${renderWaFirstContactText(key, params)}\n[кнопка: ${WA_FIRST_CONTACT_BUTTON}]`;
  await appendConversationMessages(conversationId, [
    { role: "assistant", content: text, by: sender, ...(messageId ? { mid: messageId } : {}) },
  ]);

  // Писал человек — бот молчит, тот же закон, что у ручного ответа в переписке.
  const target: DeliveryTarget = { kind: "bot", id: conversationId, channel: "WHATSAPP", subscriberId: recipient, accountId: customerTransport.accountId, transport: customerTransport };
  await applyDeliveryPause(target, new Date(Date.now() + (await defaultPauseForSender(target, sender))), true);

  // Переписка известна только теперь — дописываем её в ту же строку-замок.
  await prisma.whatsAppFirstContact.update({ where: { id: lock.id }, data: { conversationId } });

  await logTimeline({
    clientId: client.id,
    actor: { kind: "agent", agentId },
    type: "SYSTEM",
    propertyId: property?.id ?? null,
    notes: property
      ? `Первое сообщение в WhatsApp про объект №${property.shortId} — ждём ответа клиента`
      : "Первое сообщение в WhatsApp — ждём ответа клиента",
  });
  void markAgentAttempt(client.id, new Date(), agentId);

  return firstContactStatus(client, agentId);
}

// ─── Ответ клиента и доставка ────────────────────────────────────────────────

/**
 * Клиент написал в WhatsApp — если это ответ на наше первое сообщение, окно
 * открыто: ссылка на объект уходит сама, сотруднику — пуш. Зовётся из вебхука
 * ПОСЛЕ того, как реплика клиента записана, чтобы в переписке ссылка шла после неё.
 * Идемпотентна: повторная доставка вебхука не отправит ссылку второй раз.
 */
export async function noteFirstContactReply(senderId: string, replyText?: string): Promise<void> {
  try {
    const row = await prisma.whatsAppFirstContact.findFirst({
      where: {
        recipient: senderId,
        repliedAt: null,
        status: { not: "FAILED" },
        sentAt: { gte: new Date(Date.now() - REPLY_MATCH_DAYS * 86400_000) },
      },
      orderBy: { sentAt: "desc" },
    });
    if (!row) return;
    const { count } = await prisma.whatsAppFirstContact.updateMany({
      where: { id: row.id, repliedAt: null },
      data: { repliedAt: new Date(), status: "REPLIED" },
    });
    if (count === 0) return;

    const client = await prisma.client.findUnique({
      where: { id: row.clientId },
      select: { id: true, shortId: true, fullName: true, deletedAt: true, assignedAgentId: true },
    });
    if (!client || client.deletedAt) return;
    // Пуш — тому, кто держит клиента СЕЙЧАС: кнопку мог нажать прежний агент,
    // а клиента с тех пор передали (Глубокий поиск 02.10, B9). Без держателя —
    // тому, кто писал.
    const notifyAgentId = client.assignedAgentId ?? row.agentId;

    const sentShortId = row.propertyId && row.conversationId
      ? await sendPropertyLink(row.conversationId, senderId, client.id, row.propertyId, row.agentId, replyText)
      : null;

    await sendPushToAgent(notifyAgentId, {
      title: "Клиент ответил в WhatsApp",
      body: sentShortId
        ? `${client.fullName}: ссылка на объект №${sentShortId} ушла сама. Пришлите видео в переписке.`
        : `${client.fullName}: теперь можно отправлять видео и фото в переписке.`,
      url: `/clients/${client.shortId}`,
      kind: "message",
      tag: `wa-first-contact-${row.id}`,
    });
  } catch (err) {
    void logSystemError("meta", `Ответ на первое сообщение в WhatsApp не обработан: ${describeError(err)}`);
  }
}

/** Ссылка на объект, про который клиент просил. Возвращает номер объекта, если ушла. */
async function sendPropertyLink(
  conversationId: string,
  recipient: string,
  clientId: string,
  propertyId: string,
  agentId: string,
  replyText?: string
): Promise<number | null> {
  const p = await prisma.property.findUnique({
    where: { id: propertyId },
    select: { id: true, shortId: true, title: true, price: true, currency: true, status: true, deletedAt: true, offSite: true, publishedOnSite: true, siteListingId: true },
  });
  if (!p || p.deletedAt || p.status === "SOLD") return null;
  const url = p.offSite
    ? (await getOrCreatePropertyShareLinks(prisma, { propertyIds: [p.id], clientId, createdByAgentId: agentId })).get(p.id)?.url ?? null
    : siteListingUrl(p);
  if (!url) return null;

  const text = buildPropertyOfferText(
    [{ shortId: p.shortId, title: p.title, price: formatPriceForClient(p.price, p.currency), url }],
    replyText ? detectClientLanguage(replyText) : "unknown"
  );
  const customerTransport = await loadCustomerTransportForConversation(conversationId);
  if (!customerTransport) return null;
  const target: DeliveryTarget = { kind: "bot", id: conversationId, channel: "WHATSAPP", subscriberId: recipient, accountId: customerTransport.accountId, transport: customerTransport };
  const delivery = await deliverToConversation(target, text, undefined, { sender: await agentSender(agentId) });
  if (!delivery.ok) {
    console.error("[whatsapp] ссылка на объект после ответа не ушла:", delivery.error);
    return null;
  }
  if (customerTransport) await recordExposures("WHATSAPP", recipient, [{ propertyId: p.id, shortId: p.shortId, kind: "LINK" }], clientId, customerTransport);
  return p.shortId;
}

/**
 * Статус доставки от Meta. «Не дошло» приходит позже, отдельным вебхуком:
 * сама отправка при этом прошла. Сотруднику — пуш с причиной словами.
 */
export async function noteFirstContactDelivery(
  waMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  errorCode?: number | null,
  error?: string
): Promise<void> {
  if (status === "sent") return;
  try {
    const next = status === "failed" ? "FAILED" : status === "read" ? "READ" : "DELIVERED";
    // Порядок статусов не откатываем: «доставлено» после «прочитано» ничего не меняет.
    const from = status === "failed" ? ["SENT", "DELIVERED", "READ"] : status === "read" ? ["SENT", "DELIVERED"] : ["SENT"];
    const failReason = status === "failed" ? describeMetaError(error ?? "", errorCode ?? null) : null;
    const { count } = await prisma.whatsAppFirstContact.updateMany({
      where: { waMessageId, status: { in: from } },
      data: { status: next, ...(failReason ? { failReason } : {}) },
    });
    if (count === 0 || status !== "failed") return;
    const row = await prisma.whatsAppFirstContact.findUnique({ where: { waMessageId } });
    if (!row) return;
    const client = await prisma.client.findUnique({ where: { id: row.clientId }, select: { shortId: true, fullName: true } });
    await sendPushToAgent(row.agentId, {
      title: "Первое сообщение в WhatsApp не дошло",
      body: `${client?.fullName ?? "Клиент"}: ${failReason}`,
      url: client ? `/clients/${client.shortId}` : "/clients",
      kind: "message",
      tag: `wa-first-contact-${row.id}`,
    });
  } catch (err) {
    console.error("[whatsapp] статус первого сообщения не записан:", describeError(err));
  }
}
