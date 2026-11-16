import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { scrubMentionedClientPhonesInText } from "./clientPhoneMasking.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";
import { TG_PREFIX } from "./conversationId.js";

/**
 * «КЛИЕНТ ЖДЁТ ЧЕЛОВЕКА» ДЛЯ КАНАЛОВ БЕЗ СВОЕГО ЯДРА (один мозг, шаг 3, 16.11.2026).
 *
 * Когда ядро на канале Telegram/сайт/YouTube решило позвать сотрудника (или просит действие, которого на этом канале
 * нет), клиенту ничего не уходит — значит, человек обязан узнать сразу, иначе это молчаливая потеря.
 *  - Чаты BotConversation (сайт и Meta) — через ОДНУ дверь `alertClientWaiting` (lib/clientWaitingAlert.ts): тот же
 *    эпизод молчания, тот же адресат (закреплённый агент, иначе руководство), без второго пуша.
 *  - Telegram живёт в своей таблице (TelegramConversation), сторож молчания её не видит: пуш здесь, закреплённому
 *    агенту или всем, кто читает все чаты, не чаще раза в 6 часов на чат (атомарная метка, как у customerHeldMessage).
 * Никогда не бросает исключение: уведомление не должно стоить клиенту его записи в чате.
 */
const WINDOW_MS = 6 * 60 * 60 * 1000;

export async function alertChannelStaff(input: { channel: string;
  /** TelegramConversation.id for TELEGRAM, TelegramDirectConversation.id for TELEGRAM_DIRECT, BotConversation.id otherwise. */
  conversationId: string | null | undefined; text: string;
  why: "escalate" | "action_needs_staff" | "bot_retired" }): Promise<"sent" | "skipped"> {
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
    if (!recipients.length) return "skipped";
    const claimed = await prisma.$executeRaw`INSERT INTO "ProcessedMessage" ("id","channel","messageId","createdAt")
      VALUES (${randomUUID()},'channel-staff-alert',${`${direct ? "td" : "tg"}:${chat.id}:${Math.floor(Date.now() / WINDOW_MS)}`},now())
      ON CONFLICT ("channel","messageId") DO NOTHING`;
    if (claimed !== 1) return "skipped";
    const raw = clientOwnWords(input.text ?? "").replace(/\s+/gu, " ").trim() || "[сообщение без текста]";
    const excerpt = (await scrubMentionedClientPhonesInText(raw, chat.clientId)).text.slice(0, 160);
    const name = chat.client?.fullName?.trim() || (chat.username ? `@${chat.username}` : "клиент из Telegram");
    await sendPushToAgents(recipients, { kind: "message", title: `Ответьте вручную: ${name}`,
      // Direct-message chats are shown inside the client card only (routes/conversations.ts); without a card — the inbox.
      body: `«${excerpt}». ${WHY_TEXT[input.why]}`,
      url: direct ? (chat.client ? `/clients/${chat.client.shortId}` : "/messages") : `/messages?open=${TG_PREFIX}${chat.id}`,
      tag: `channel-staff-${chat.id}` });
    return "sent";
  } catch (error) {
    void logSystemError("ai", `Уведомление «клиент ждёт человека» не отправлено: ${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: "channel-staff-alert-failed", quietPult: true });
    return "skipped";
  }
}

const WHY_TEXT: Record<"escalate" | "action_needs_staff" | "bot_retired", string> = {
  escalate: "Бот передал разговор человеку: ответьте клиенту сами.",
  action_needs_staff: "Клиент просит действие (показ, звонок, запись), которое бот в этом канале не оформляет: ответьте сами.",
  bot_retired: "Автоответ в этом канале выключен: ответьте клиенту сами.",
};
