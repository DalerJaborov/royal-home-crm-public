import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { customerAgentLegacyChannelKey } from "./customerAgentChannelSwitch.js";

/**
 * АВАРИЙНЫЙ РУБИЛЬНИК КЛИЕНТСКОГО БОТА ПО КАНАЛАМ — «бот молчит, отвечают люди» (18.11.2026).
 *
 * `CUSTOMER_AGENT_CHANNEL_OFF` — ключи каналов через запятую или `all`:
 *   whatsapp, instagram, facebook, website, telegram, telegram_direct, youtube, arvan.
 * `arvan` — все аккаунты со своим именем компании (MessengerAccount.brandName, сегодня «Арван») в Meta-каналах; правило
 * «чей это аккаунт» одно — customerAgentLegacyChannelKey (lib/customerAgentChannelSwitch.ts). `instagram`/`facebook`
 * по-прежнему глушат ВСЕ аккаунты канала, включая Арван. Где аккаунт на входе неизвестен (комментарии, Telegram),
 * `arvan` не срабатывает — без догадок.
 * Пусто (по умолчанию) — рубильник не действует, всё работает ровно как раньше: ни одного лишнего запроса к базе.
 * Неизвестное имя пропускается (никогда не расширяется до `all`) и один раз пишется в журнал ошибок.
 *
 * На выключенном канале модель не вызывается вообще — ни новое ядро, ни старый бот. Клиенту уходит одна готовая строка
 * передачи (та же, что у ядра: ai/customerAgentRenderer.ts::customerAgentHandoverLine), сотруднику — штатный сигнал
 * «клиент ждёт ответа» (lib/clientWaitingAlert.ts::alertClientWaiting). Строка и сигнал — один раз за эпизод: пока
 * после строки передачи никто (сотрудник или бот до выключения) не ответил, следующие сообщения клиента ложатся в
 * переписку молча — второй «передал сотруднику» и второй пуш не уходят.
 *
 * Где читается (одно правило, isCustomerAgentChannelOff; там, где вход знает аккаунт или диалог, — через
 * isCustomerAgentTurnOff / isCustomerAgentConversationOff / тикет ядра, тогда работает и `arvan`):
 *  - ai/legacyQualifyDoor.ts::runLegacyQualifyTurn — дверь старого пути: Meta-диалоги старой полосы, сайт, Telegram-бот,
 *    личные сообщения Telegram-канала и их повторы; рубильник стоит раньше выбора `legacy`/`shadow`/`core`;
 *  - lib/customerIngressProducer.ts::consumeCustomerInboxTicket — Meta-диалоги нового ядра: ход не начинается, тикет
 *    уходит в HELD с причиной `customer_channel_off`, сотруднику — сигнал через штатный отчёт о неотвеченном ходе.
 *    Строки клиенту здесь НЕТ: доставка ядра живёт в lib/customerDmAgentTurn.ts (вне этой правки);
 *  - messengers/commentIngest.ts::isCommentsBotEnabled — комментарии Instagram/Facebook/YouTube (бот не отвечает,
 *    комментарии сохраняются, как при выключенном канале в Настройках);
 *  - messengers/telegramGroupComments.ts::isTelegramGroupCommentsEnabled — комментарии под постами Telegram-канала;
 *  - messengers/conversation.ts::runLeadOnlyOperator — режим «только заявки» старого пути (оператор приёма заявок);
 *  - ai/shortAgentReply.ts — короткие реплики модели вне хода: «заявка принята», напоминание молчащему (cron),
 *    просьба номера у кандидата, «ещё уточняю у собственника». Вызывающие при null берут готовую фразу или молчат.
 */
export const CUSTOMER_AGENT_OFF_CHANNELS = ["whatsapp", "instagram", "facebook", "website", "telegram", "telegram_direct", "youtube", "arvan"] as const;
export type CustomerAgentOffChannel = (typeof CUSTOMER_AGENT_OFF_CHANNELS)[number];

/** Причина HELD у тикета ядра, когда канал выключен рубильником. */
export const CUSTOMER_CHANNEL_OFF_REASON = "customer_channel_off";

type Env = Readonly<Record<string, string | undefined>>;

/** Чистая: разбор значения переменной. Неизвестные имена — отдельно, в набор не попадают. */
export function parseCustomerAgentChannelOff(raw: string | undefined): { off: ReadonlySet<CustomerAgentOffChannel>; unknown: string[] } {
  const tokens = (raw ?? "").split(",").map(token => token.trim().toLowerCase()).filter(Boolean);
  const off = new Set<CustomerAgentOffChannel>(tokens.includes("all") ? CUSTOMER_AGENT_OFF_CHANNELS : []);
  const unknown: string[] = [];
  for (const token of tokens) {
    if (token === "all") continue;
    if ((CUSTOMER_AGENT_OFF_CHANNELS as readonly string[]).includes(token)) off.add(token as CustomerAgentOffChannel);
    else unknown.push(token.slice(0, 40));
  }
  return { off, unknown };
}

/** Чистая: ключ рубильника для канала переписки (как каналы хранятся в базе). Незнакомый канал — null. */
export function customerAgentOffKey(channel: string | null | undefined): CustomerAgentOffChannel | null {
  switch (channel) {
    case "WHATSAPP": return "whatsapp";
    case "INSTAGRAM": return "instagram";
    case "FACEBOOK": return "facebook";
    case "WEBSITE": return "website";
    case "TELEGRAM": return "telegram";
    case "TELEGRAM_DIRECT": return "telegram_direct";
    case "YOUTUBE": return "youtube";
    default: return null;
  }
}

const reportedUnknown = new Set<string>();

/** Каналы, выключенные рубильником. Неизвестные имена — одна запись в журнал на значение (и на процесс). */
export function customerAgentChannelsOff(env: Env = process.env): ReadonlySet<CustomerAgentOffChannel> {
  const raw = env.CUSTOMER_AGENT_CHANNEL_OFF;
  if (!raw?.trim()) return new Set();
  const { off, unknown } = parseCustomerAgentChannelOff(raw);
  if (unknown.length) {
    const value = unknown.join(",");
    if (!reportedUnknown.has(value)) {
      reportedUnknown.add(value);
      void logSystemError("ai", `CUSTOMER_AGENT_CHANNEL_OFF: неизвестные имена каналов пропущены (${value}). ` +
        `Допустимо: ${CUSTOMER_AGENT_OFF_CHANNELS.join(", ")} или all.`,
        { dedupKey: `customer-agent-channel-off-unknown:${value}` }).catch(() => {});
    }
  }
  return off;
}

/**
 * ОДНА ФУНКЦИЯ НА ВСЕХ ВХОДАХ: выключен ли бот на канале этой переписки. По умолчанию — нет. `brandName` — имя компании
 * аккаунта переписки (MessengerAccount.brandName), если вход его знает; без него ключ `arvan` не срабатывает.
 */
export function isCustomerAgentChannelOff(channel: string | null | undefined, env: Env = process.env,
  brandName: string | null = null): boolean {
  if (!env.CUSTOMER_AGENT_CHANNEL_OFF?.trim() || !channel) return false;
  const off = customerAgentChannelsOff(env);
  const key = customerAgentOffKey(channel);
  if (key !== null && off.has(key)) return true;
  return off.has("arvan") && customerAgentLegacyChannelKey(channel, brandName) === "arvan";
}

/** Ключ `arvan` в списке и канал вообще бывает «брендовым» (Meta): только тогда есть смысл читать аккаунт. */
function arvanMayApply(channel: string | null | undefined, env: Env): boolean {
  return !!channel && customerAgentChannelsOff(env).has("arvan") && customerAgentLegacyChannelKey(channel, "brand") === "arvan";
}

/**
 * Выключен ли ход переписки, когда вход знает канал и аккаунт (или только диалог). Пусто — false без чтений. Имя компании
 * аккаунта берётся из кэша аккаунтов (messengers/accounts.ts::accountBrandName), без аккаунта — одним запросом по диалогу,
 * и только когда в списке есть `arvan`, а канал — Meta. Не удалось прочитать — `arvan` не срабатывает (ключ канала — да).
 */
export async function isCustomerAgentTurnOff(input: { channel: string | null | undefined; accountId?: string | null;
  conversationId?: string | null }, env: Env = process.env): Promise<boolean> {
  if (!env.CUSTOMER_AGENT_CHANNEL_OFF?.trim()) return false;
  if (isCustomerAgentChannelOff(input.channel, env)) return true;
  if (!arvanMayApply(input.channel, env)) return false;
  let brandName: string | null = null;
  try {
    if (input.accountId) {
      const { accountBrandName } = await import("../messengers/accounts.js");
      brandName = await accountBrandName(input.accountId);
    } else if (input.conversationId) {
      brandName = (await prisma.botConversation.findUnique({ where: { id: input.conversationId },
        select: { account: { select: { brandName: true } } } }))?.account?.brandName ?? null;
    }
  } catch { brandName = null; }
  return isCustomerAgentChannelOff(input.channel, env, brandName);
}

/** Выключен ли рубильником хоть один канал (дешёвая проверка до похода в базу). */
export function customerAgentAnyChannelOff(env: Env = process.env): boolean {
  return env.CUSTOMER_AGENT_CHANNEL_OFF?.trim() ? customerAgentChannelsOff(env).size > 0 : false;
}

/**
 * Выключен ли канал переписки, известной только по id (BotConversation, TelegramConversation или
 * TelegramDirectConversation). Пусто — false без запроса к базе; `all` — true без запроса. Сбой базы при включённом
 * рубильнике — true: вызывающие (короткие реплики модели) при «нет» берут готовую фразу, а лишний ход модели в
 * выключенном канале и есть то, от чего рубильник защищает.
 */
export async function isCustomerAgentConversationOff(conversationId: string | null | undefined, env: Env = process.env): Promise<boolean> {
  const off = customerAgentChannelsOff(env);
  if (!off.size || !conversationId) return false;
  if (off.size === CUSTOMER_AGENT_OFF_CHANNELS.length) return true;
  try {
    const bot = await prisma.botConversation.findUnique({ where: { id: conversationId },
      select: { channel: true, account: { select: { brandName: true } } } });
    if (bot) return isCustomerAgentChannelOff(bot.channel, env, bot.account?.brandName ?? null);
    if (await prisma.telegramConversation.findUnique({ where: { id: conversationId }, select: { id: true } })) return off.has("telegram");
    if (await prisma.telegramDirectConversation.findUnique({ where: { id: conversationId }, select: { id: true } })) return off.has("telegram_direct");
    return false;
  } catch {
    return true;
  }
}

/** Канал тикета нового ядра (Meta-диалоги) выключен рубильником. Пусто — false без запроса к базе. */
export async function isCustomerIngressTicketChannelOff(eventKey: string, env: Env = process.env): Promise<boolean> {
  if (!customerAgentAnyChannelOff(env)) return false;
  const ticket = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey },
    select: { endpointScope: { select: { channel: true, messengerAccount: { select: { brandName: true } } } },
      conversation: { select: { channel: true, account: { select: { brandName: true } } } } } });
  return isCustomerAgentChannelOff(ticket?.endpointScope?.channel ?? ticket?.conversation?.channel ?? null, env,
    ticket?.endpointScope?.messengerAccount?.brandName ?? ticket?.conversation?.account?.brandName ?? null);
}

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Чистая: строка передачи уже ушла в этом эпизоде. Идём от конца переписки: реплики клиента пропускаем, недошедшую
 * реплику с нашей стороны (`deliveryStatus: "failed"`) тоже; первая доставленная наша реплика решает — строка передачи
 * значит «уже сказали», любая другая (сотрудник, бот до выключения) открыла новый эпизод.
 */
export function channelOffHandoverAlreadySent(messages: unknown, handoverLines: readonly string[]): boolean {
  if (!Array.isArray(messages)) return false;
  const lines = handoverLines.map(normalized).filter(Boolean);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: unknown; content?: unknown; deliveryStatus?: unknown } | null;
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    if (m.deliveryStatus === "failed") continue;
    const content = typeof m.content === "string" ? normalized(m.content) : "";
    return lines.some(line => content.includes(line));
  }
  return false;
}

async function storedMessages(channel: string, conversationId: string): Promise<unknown> {
  const where = { where: { id: conversationId }, select: { messages: true } } as const;
  const row = channel === "TELEGRAM" ? await prisma.telegramConversation.findUnique(where)
    : channel === "TELEGRAM_DIRECT" ? await prisma.telegramDirectConversation.findUnique(where)
    : await prisma.botConversation.findUnique(where);
  return row?.messages ?? null;
}

const STAFF_WHY = "бот в этом канале временно выключен: ответьте клиенту сами. Клиенту бот ответил, что передал сообщение сотруднику.";

/**
 * Ход на выключенном канале (без модели): `line` — клиенту строка передачи, сотруднику сказано (или сказать некого —
 * тогда запись в журнал на этот чат); `silent` — в этом эпизоде строка уже была (или сигнала нет намеренно: клиент в
 * корзине, чата нет). Никогда не бросает: сбой чтения переписки — `line` (клиент не остаётся без ответа).
 */
export async function handOverChannelOffTurn(input: { channel: string; conversationId: string | null | undefined;
  handoverLines: readonly string[] }): Promise<"line" | "silent"> {
  const conversationId = input.conversationId ?? null;
  try {
    if (conversationId && channelOffHandoverAlreadySent(await storedMessages(input.channel, conversationId), input.handoverLines)) return "silent";
  } catch { /* the customer still gets the line below */ }
  let outcome: "agent" | "director" | "already" | "skipped" | "excluded" = "skipped";
  if (conversationId) {
    try {
      const { alertClientWaiting } = await import("./clientWaitingAlert.js");
      outcome = await alertClientWaiting({ conversationId, trigger: "handover", why: STAFF_WHY,
        source: input.channel === "TELEGRAM" ? "telegram" : input.channel === "TELEGRAM_DIRECT" ? "telegramDirect" : "bot" });
    } catch { outcome = "skipped"; }
  }
  // Сигнала нет намеренно (клиент в корзине, чата нет): обещать человека было бы неправдой — молчим, как дверь ядра.
  if (outcome === "excluded") return "silent";
  if (outcome === "skipped") {
    void logSystemError("ai", `Бот на канале ${input.channel} выключен рубильником: клиенту ушло «передал сотруднику», ` +
      `но сигнал сотруднику не ушёл (чат ${conversationId ?? "без номера"}): откройте переписку и ответьте сами.`,
      { dedupKey: `channel-off-unalerted:${input.channel}:${conversationId ?? "unknown"}` }).catch(() => {});
  }
  return "line";
}

/** Подпись каналов для экрана «Состояние функций». */
export const CUSTOMER_AGENT_OFF_LABELS: Record<CustomerAgentOffChannel, string> = {
  whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", website: "сайт", telegram: "Telegram-бот",
  telegram_direct: "личные сообщения Telegram-канала", youtube: "YouTube", arvan: "Арван (все аккаунты бренда)",
};
