import { NO_TEXT_NOTE } from "@royal-home/shared";
import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { sendPushToAgents } from "../push.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { scrubMentionedClientPhonesInText } from "./clientPhoneMasking.js";
import { findAgentsWithPermission } from "./recipients.js";
import { logSystemError } from "./systemError.js";
import { TG_PREFIX } from "./conversationId.js";
import type { ChannelCoreStaffReason } from "./customerChannelCore.js";
import { loadBotAnswersItself, staffSignalAllowed, type StaffSignalKind } from "./botAnswersItself.js";

/**
 * «КЛИЕНТ ЖДЁТ ЧЕЛОВЕКА» ДЛЯ КАНАЛОВ БЕЗ СВОЕГО ЯДРА (один мозг, шаг 3, 16–17.11.2026).
 *
 * Когда ядро на канале Telegram/сайт/YouTube зовёт сотрудника (или просит действие, которого на этом канале нет, не
 * может прочитать вход или отказывает так, что повтор ничего не даст), клиенту не уходит ответ по существу — значит,
 * человек обязан узнать сразу. Клиенту канал отправляет строку «передал сотруднику» (ревью #223 R1-4); `skipped`
 * («уведомить некого», ошибка базы) дверь ядра пишет в журнал ошибок, `already` — человеку уже сказали раньше,
 * `excluded` (клиент в корзине, чата нет) — сигнала нет намеренно, и дверь ядра молчит (ревью 0e463b02 N5). Отписка сигнал
 * сотруднику не глушит: клиент сам ждёт человека (отписка — только «бот не пишет первым»).
 *  - Чаты BotConversation (сайт и Meta) — через ОДНУ дверь `alertClientWaiting` (lib/clientWaitingAlert.ts), повод
 *    `handover`: текст пуша говорит правду — клиенту уже сказано, что ответит человек (ревью #223 N8).
 *  - Telegram-бот (TelegramConversation) и личные сообщения канала (TelegramDirectConversation; канал `TELEGRAM_DIRECT`,
 *    ревью #223 N2) — пуш здесь, на КАЖДОЕ неотвеченное сообщение (ревью #224 M3: окно 6 ч теряло второй вопрос после
 *    ответа сотрудника); сообщения одной пачки (в пределах 2 минут) — одним пушем.
 * Молчание дольше 30 минут во всех этих чатах, включая обе таблицы Telegram, ловит один сторож — `runClientSilenceSweep`
 * (cron.ts, `client-silence-sweep`). Второго сторожа для Telegram нет и не нужно (ревью #223 N5: дубль удалён).
 * Никогда не бросает исключение: уведомление не должно стоить клиенту его записи в чате.
 */
const BATCH_MS = 2 * 60 * 1000;

export type ChannelStaffWhy = ChannelCoreStaffReason | "bot_retired";
/** After these the customer hears the handover line (legacyQualifyDoor.ts), and the push says so. */
const HANDED_OVER: ReadonlySet<ChannelStaffWhy> = new Set(["escalate", "action_needs_staff", "unreadable_input", "core_refused", "core_unavailable"]);
const HANDED_OVER_NOTE = " Клиенту бот отвечает, что передал сообщение сотруднику.";
/** Для двери «Бот отвечает сам»: ядро недоступно и бот на канале выключен — техсбой, остальное — «передал сотруднику». */
export function channelStaffSignalKind(why: ChannelStaffWhy): StaffSignalKind {
  return why === "core_unavailable" || why === "bot_retired" ? "technical" : "answered_handover";
}

export async function alertChannelStaff(input: { channel: string;
  /** TelegramConversation.id for TELEGRAM, TelegramDirectConversation.id for TELEGRAM_DIRECT, BotConversation.id otherwise. */
  conversationId: string | null | undefined; text: string; why: ChannelStaffWhy;
  /** Provider message id of the customer's message (dedupe of one message); null = batch window. */
  eventId?: string | null;
  /** Номер клиента известен: при «бот отвечает сам» человек всё равно узнаёт — это заявка (lib/botAnswersItself.ts). */
  phoneKnown?: boolean }): Promise<"sent" | "already" | "skipped" | "excluded" | "self"> {
  try {
    if (!input.conversationId) return "skipped";
    if (input.channel !== "TELEGRAM" && input.channel !== "TELEGRAM_DIRECT") {
      const { alertClientWaiting } = await import("./clientWaitingAlert.js");
      const outcome = await alertClientWaiting(HANDED_OVER.has(input.why)
        ? { conversationId: input.conversationId, trigger: "handover", why: `${WHY_TEXT[input.why]}${HANDED_OVER_NOTE}`,
          ...(input.phoneKnown ? { phoneKnown: true } : {}) }
        : { conversationId: input.conversationId, trigger: "failed", why: WHY_TEXT[input.why] });
      // «Уже сказали» (сторож молчания или прошлый ход занял эпизод) — не «некого»: клиенту можно сказать «передал» (R1-2).
      // `excluded` (client in the trash, no chat): no signal by design — the door stays silent instead (review 0e463b02 N5).
      // An opted-out customer who waits for a person is still signalled (opt-out = the bot does not write first).
      return outcome === "agent" || outcome === "director" ? "sent" : outcome;
    }
    const select = { id: true, username: true, clientId: true,
      client: { select: { shortId: true, fullName: true, deletedAt: true, assignedAgent: { select: { id: true, isActive: true } } } } } as const;
    const direct = input.channel === "TELEGRAM_DIRECT";
    const chat = direct ? await prisma.telegramDirectConversation.findUnique({ where: { id: input.conversationId }, select })
      : await prisma.telegramConversation.findUnique({ where: { id: input.conversationId }, select });
    if (!chat || chat.client?.deletedAt) return "excluded";
    const owner = chat.client?.assignedAgent?.isActive ? chat.client.assignedAgent.id : null;
    // «Бот отвечает сам» (18.11.2026, lib/botAnswersItself.ts): чат без карточки и без своего агента — руководство не зовём,
    // клиенту вместо «передал сотруднику» бот сам отвечает шагом к номеру (ai/legacyQualifyDoor.ts).
    const signal = { kind: channelStaffSignalKind(input.why), ownAgent: !!owner, hasCard: !!chat.clientId, phoneKnown: input.phoneKnown === true };
    if (!staffSignalAllowed({ on: true, ...signal }) && !staffSignalAllowed({ on: await loadBotAnswersItself(), ...signal })) return "self";
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
    const raw = clientOwnWords(input.text ?? "").replace(/\s+/gu, " ").trim() || NO_TEXT_NOTE;
    const excerpt = (await scrubMentionedClientPhonesInText(raw, chat.clientId)).text.slice(0, 160);
    const name = chat.client?.fullName?.trim() || (chat.username ? `@${chat.username}` : "клиент из Telegram");
    // Direct-message chats are shown inside the client card only (routes/conversations.ts); without a card there is no CRM
    // screen for them at all — say so (review #224 L1).
    const where = direct && !chat.client ? " Ответить можно только в самом Telegram (личные сообщения канала)." : "";
    await sendPushToAgents(recipients, { kind: "message", title: `Ответьте вручную: ${name}`,
      body: `«${excerpt}». ${WHY_TEXT[input.why]}${HANDED_OVER.has(input.why) ? HANDED_OVER_NOTE : ""}${where}`,
      url: direct ? (chat.client ? `/clients/${chat.client.shortId}` : "/messages") : `/messages?open=${TG_PREFIX}${chat.id}`,
      tag: `channel-staff-${chat.id}` });
    return "sent";
  } catch (error) {
    // One entry per chat (review 0e463b02 N4): a channel-wide key swallowed every other chat for 10 minutes.
    void logSystemError("ai", `Уведомление «клиент ждёт человека» не отправлено (чат ${input.conversationId ?? "без номера"}): ` +
      `${error instanceof Error ? error.message : String(error)}`,
      { dedupKey: `channel-staff-alert-failed:${input.conversationId ?? "none"}`, quietPult: true });
    return "skipped";
  }
}

const WHY_TEXT: Record<ChannelStaffWhy, string> = {
  escalate: "Бот передал разговор человеку: ответьте клиенту сами.",
  action_needs_staff: "Клиент просит действие (показ, звонок, запись), которое бот в этом канале не оформляет: ответьте сами.",
  bot_retired: "Автоответ в этом канале выключен: ответьте клиенту сами.",
  unreadable_input: "Бот не смог прочитать сообщение (голосовое без расшифровки, фото или файл): посмотрите и ответьте сами.",
  core_refused: "Бот не смог ответить по существу: ответьте клиенту сами.",
  core_unavailable: "ИИ не ответил после нескольких попыток: ответьте клиенту сами.",
};
