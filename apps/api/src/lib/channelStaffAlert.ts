import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { scrubMentionedClientPhonesInText } from "./clientPhoneMasking.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";
import { TG_PREFIX } from "./conversationId.js";

/**
 * «КЛИЕНТ ЖДЁТ ЧЕЛОВЕКА» ДЛЯ КАНАЛОВ БЕЗ СВОЕГО ЯДРА (один мозг, шаг 3, 16–17.11.2026).
 *
 * Когда ядро на канале Telegram/сайт/YouTube зовёт сотрудника (или просит действие, которого на этом канале нет, или не
 * может прочитать вход), клиенту не уходит ответ по существу — значит, человек обязан узнать сразу.
 *  - Чаты BotConversation (сайт и Meta) — через ОДНУ дверь `alertClientWaiting` (lib/clientWaitingAlert.ts): эпизод
 *    молчания, закреплённый агент или руководство, плюс общий сторож молчания каждые 10 минут.
 *  - Telegram (TelegramConversation, личные сообщения канала — TelegramDirectConversation) сторож BotConversation не видит:
 *    пуш здесь, на КАЖДОЕ неотвеченное сообщение (ревью #224 M3: окно 6 ч теряло второй вопрос после ответа сотрудника);
 *    сообщения одной пачки (в пределах 2 минут) — одним пушем. Плюс свой сторож `runTelegramSilenceSweep` (cron).
 * Никогда не бросает исключение: уведомление не должно стоить клиенту его записи в чате.
 */
const BATCH_MS = 2 * 60 * 1000;

export type ChannelStaffWhy = "escalate" | "action_needs_staff" | "bot_retired" | "unreadable_input" | "silence";

export async function alertChannelStaff(input: { channel: string;
  /** TelegramConversation.id for TELEGRAM, TelegramDirectConversation.id for TELEGRAM_DIRECT, BotConversation.id otherwise. */
  conversationId: string | null | undefined; text: string; why: ChannelStaffWhy;
  /** Provider message id of the customer's message (dedupe of one message); null = batch window. */
  eventId?: string | null }): Promise<"sent" | "already" | "skipped"> {
  try {
    if (!input.conversationId) return "skipped";
    if (input.channel !== "TELEGRAM" && input.channel !== "TELEGRAM_DIRECT") {
      const { alertClientWaiting } = await import("./clientWaitingAlert.js");
      const outcome = await alertClientWaiting(input.why === "escalate" ? { conversationId: input.conversationId, trigger: "escalate" }
        : { conversationId: input.conversationId, trigger: "failed", why: WHY_TEXT[input.why] });
      return outcome === "skipped" ? "skipped" : "sent";
    }
    const select = { id: true, username: true, clientId: true,
      client: { select: { shortId: true, fullName: true, deletedAt: true, assignedAgent: { select: { id: true, isActive: true } } } } } as const;
    const direct = input.channel === "TELEGRAM_DIRECT";
    const chat = direct ? await prisma.telegramDirectConversation.findUnique({ where: { id: input.conversationId }, select })
      : await prisma.telegramConversation.findUnique({ where: { id: input.conversationId }, select });
    if (!chat || chat.client?.deletedAt) return "skipped";
    const owner = chat.client?.assignedAgent?.isActive ? chat.client.assignedAgent.id : null;
    const recipients = owner ? [owner] : await findAgentsWithPermission("messages.view");
    if (!recipients.length) {
      void logSystemError("telegram", `Клиент в Telegram ждёт ответа, а уведомить некого (чат ${chat.id}).`,
        { dedupKey: "channel-staff-alert-no-recipient", quietPult: true });
      return "skipped";
    }
    const key = `${direct ? "td" : "tg"}:${chat.id}:${input.eventId ? `m${input.eventId}` : `b${Math.floor(Date.now() / BATCH_MS)}`}`;
    const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt")
      VALUES (${randomUUID()},'channel-staff-alert',${key},now()) ON CONFLICT ("channel","messageId") DO NOTHING`;
    if (claimed !== 1) return "already"; // a person was already told about this message (or this batch)
    // clientOwnWords keeps the customer's voice transcript (stripUntrusted would drop it: review #224 L6).
    const raw = clientOwnWords(input.text ?? "").replace(/\s+/gu, " ").trim() || "[голосовое или вложение без текста]";
    const excerpt = (await scrubMentionedClientPhonesInText(raw, chat.clientId)).text.slice(0, 160);
    const name = chat.client?.fullName?.trim() || (chat.username ? `@${chat.username}` : "клиент из Telegram");
    // Direct-message chats are shown inside the client card only (routes/conversations.ts); without a card there is no CRM
    // screen for them at all — say so (review #224 L1).
    const where = direct && !chat.client ? " Ответить можно только в самом Telegram (личные сообщения канала)." : "";
    await sendPushToAgents(recipients, { kind: "message", title: `Ответьте вручную: ${name}`,
      body: `«${excerpt}». ${WHY_TEXT[input.why]}${where}`,
      url: direct ? (chat.client ? `/clients/${chat.client.shortId}` : "/messages") : `/messages?open=${TG_PREFIX}${chat.id}`,
      tag: `channel-staff-${chat.id}` });
    return "sent";
  } catch (error) {
    void logSystemError("ai", `Уведомление «клиент ждёт человека» не отправлено: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "channel-staff-alert-failed", quietPult: true });
    return "skipped";
  }
}

const WHY_TEXT: Record<ChannelStaffWhy, string> = {
  escalate: "Бот передал разговор человеку: ответьте клиенту сами.",
  action_needs_staff: "Клиент просит действие (показ, звонок, запись), которое бот в этом канале не оформляет: ответьте сами.",
  bot_retired: "Автоответ в этом канале выключен: ответьте клиенту сами.",
  unreadable_input: "Бот не смог прочитать сообщение (голосовое без расшифровки, фото или файл): посмотрите и ответьте сами.",
  silence: "Клиент ждёт ответа больше 30 минут: ответьте сами.",
};

type StoredMessage = { role?: unknown; content?: unknown; at?: unknown };
/** Pure: the customer's last words if the chat ends with them (nobody answered after), with the time of the first of them. */
export function unansweredTail(messages: unknown): { text: string; since: Date | null; index: number } | null {
  const list = Array.isArray(messages) ? messages as StoredMessage[] : [];
  let last = list.length - 1;
  if (last < 0 || list[last]?.role !== "user") return null;
  let first = last;
  while (first > 0 && list[first - 1]?.role === "user") first--;
  const at = typeof list[first]?.at === "string" ? new Date(list[first]!.at as string) : null;
  const text = list.slice(first, last + 1).map(item => typeof item.content === "string" ? item.content : "").join("\n");
  return { text, since: at && !Number.isNaN(at.getTime()) ? at : null, index: first };
}

export const TELEGRAM_SILENCE_MINUTES = 30;
const SWEEP_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const SWEEP_LIMIT = 300;

/**
 * Сторож молчания Telegram (ревью #224 M3): Telegram-чаты лежат вне BotConversation, и общий сторож их не видит.
 * Раз в 10 минут: чат, где последним пишет клиент дольше 30 минут (и не дольше суток), — «ответьте вручную», один раз на
 * эпизод (ключ — позиция первой неотвеченной реплики). Пауза оператора — не молчание бота, но клиент всё равно ждёт:
 * сторож зовёт человека и тогда. Предел выборки — 300 чатов за тик.
 */
export async function runTelegramSilenceSweep(now = new Date()): Promise<{ alerted: number }> {
  const since = new Date(now.getTime() - SWEEP_LOOKBACK_MS);
  const quietBefore = new Date(now.getTime() - TELEGRAM_SILENCE_MINUTES * 60 * 1000);
  let alerted = 0;
  const rows = await prisma.telegramConversation.findMany({ where: { lastMessageAt: { gte: since, lte: quietBefore } },
    select: { id: true, messages: true }, orderBy: { lastMessageAt: "desc" }, take: SWEEP_LIMIT });
  for (const row of rows) {
    const tail = unansweredTail(row.messages);
    if (!tail) continue;
    if (tail.since && tail.since.getTime() > quietBefore.getTime()) continue;
    const outcome = await alertChannelStaff({ channel: "TELEGRAM", conversationId: row.id, text: tail.text, why: "silence",
      eventId: `silence-${tail.index}` });
    if (outcome === "sent") alerted++;
  }
  return { alerted };
}
