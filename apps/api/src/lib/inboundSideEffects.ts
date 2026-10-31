/**
 * ДЕЙСТВИЯ CRM НА ВХОДЯЩЕЕ СООБЩЕНИЕ КЛИЕНТА — ОДНО МЕСТО ДЛЯ ЛЮБОГО МОЗГА
 * (31.10.2026, шаг 1 плана удаления старого бота).
 *
 * До этой правки всё, что CRM делает, когда клиент пишет, жило только внутри
 * старого хода (`messengers/conversation.ts`, `processMessengerTurnImpl`): пуш
 * агенту «ваш клиент написал», пуш по чату объекта, возврат из «Потерянных»,
 * автопилот карточки, «новый запрос от знакомого клиента», явный отказ, ответ на
 * опрос о сделке, досье и тепловая карта. Клиент, которого ведёт новое ядро
 * (`lib/customerDmAgentTurn.ts`), писал — и ничего из этого не происходило:
 * агент даже не узнавал, что его клиент написал.
 *
 * Решение владельца: старый бот уходит целиком, поэтому эти действия живут
 * здесь и срабатывают на КАЖДОЕ принятое входящее, независимо от того, какой
 * движок отвечает и ответил ли он вообще.
 *
 * Кто зовёт:
 *  - ядро и «scoped»-квалификатор — `recordScopedCustomerInput`
 *    (`lib/customerQualifierLedger.ts`), ровно один раз на сообщение: вызов стоит
 *    за отметкой `inputRecordedAt`, которая ставится в той же транзакции, что и
 *    запись реплики. Повтор задания, восстановление и повторная доставка до
 *    этой ветки не доходят;
 *  - старый ход — в начале хода, вместо прежних разрозненных вызовов.
 *
 * ИДЕМПОТЕНТНОСТЬ ПО СОБЫТИЮ. Сверх отметки ядра — замок по идентификатору
 * сообщения у поставщика в `ProcessedMessage` (свой «канал»
 * `INBOUND_SIDE_EFFECTS`, уникальная пара — сам замок, гонку двух доставок
 * решает ограничение БД). Повторная доставка того же сообщения не шлёт второй
 * пуш и не делает второго возврата из «Потерянных». Сообщение без
 * идентификатора (повтор зависшего хода оператором) замка не берёт — как и
 * раньше в старом ходе.
 *
 * ЧЕГО ЯДРО ЗДЕСЬ НЕ ДЕЛАЕТ — привязку переписки WhatsApp к найденной по номеру
 * карточке (`BotConversation.clientId`). Это поле входит в `bindingRevision`
 * ядра (триггер `customer_native_revisions`): запись в него посреди хода
 * переводит ход в HELD, и бот молча не отвечает на это сообщение. Для ядра
 * карточка по номеру WhatsApp находится только ЧТЕНИЕМ — пуш и остальные
 * действия получают её, а связку делает само ядро (`save_contact`).
 */
import { prisma } from "../db.js";
import { detectClientLanguage } from "../ai/clientLanguage.js";
import { analyzeMessageForPropertyCounts } from "../ai/chatPropertyCount.js";
import { notifyAgentOfClientMessage } from "./clientMessageAlert.js";
import { notifyPropertyChatMessage } from "./propertyChatMessageAlert.js";
import { checkExplicitRefusal } from "./explicitRefusalDetector.js";
import { checkClientInactiveSignal } from "./clientInactiveTextDetector.js";
import { runClientAutopilotInBackground } from "./clientAutopilot.js";
import { detectNewInquiryFromKnownClient } from "./newInquiryDetector.js";
import { reactivateClientFromLost } from "./clientLifecycle.js";
import { returningAgentStillAvailable } from "./returningClientRouting.js";
import { recordAudienceMessage } from "./audienceHeatmap.js";
import { linkContactProfileToClient, recordContactTurn } from "./contactProfiles.js";
import { tryHandleDealReviewReply } from "./dealReviewIntake.js";
import {
  findClientByPhoneDigits,
  linkWhatsAppConversationToClient,
  rememberWhatsAppPhone,
  whatsAppPhoneFromSubscriberId,
} from "./whatsappPhone.js";

/** «Канал» замка в `ProcessedMessage`: не пересекается с отметками вебхука (WHATSAPP/INSTAGRAM/...). */
export const INBOUND_SIDE_EFFECTS_LOCK = "INBOUND_SIDE_EFFECTS";

const UNIQUE_VIOLATION = "P2002";

export interface InboundSideEffectsInput {
  /** Кто принял сообщение. `core` — ядро и scoped-квалификатор, `legacy` — старый ход. */
  source: "core" | "legacy";
  channel: string;
  /** Идентификатор собеседника в канале (psid/igsid/wa_id/сессия сайта). */
  peer: string;
  /** Родная переписка (`BotConversation.id`), в которую легло входящее. */
  conversationId: string;
  /** Текст сообщения клиента (может быть пустым — вложение без подписи). */
  text: string;
  /** Идентификатор сообщения у поставщика — ключ идемпотентности. */
  eventId?: string | null;
  /** Считать ли сообщение в тепловую карту аудитории (старый ход: не повтор и не сотрудник). */
  countAudience?: boolean;
}

export type InboundSideEffectsResult =
  | { status: "duplicate" }
  | {
      status: "applied";
      /** Живая (не удалённая) карточка, к которой относится сообщение, или null. */
      clientId: string | null;
      /** Ответ на опрос о сделке разобран — старый ход отвечает этой фразой без модели. */
      dealReview: { reply: string } | null;
    };

/** Замок по событию. true — действия ещё не выполнялись, выполняем мы. */
async function claimInboundEvent(channel: string, eventId: string | null | undefined): Promise<boolean> {
  if (!eventId) return true;
  try {
    await prisma.processedMessage.create({
      data: { channel: INBOUND_SIDE_EFFECTS_LOCK, messageId: `${channel}:${eventId}`, completedAt: new Date() },
    });
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === UNIQUE_VIOLATION) return false;
    // База не дала поставить отметку — действия всё равно выполняем: потерять пуш
    // агенту о сообщении клиента хуже, чем в редком случае прислать его дважды.
    console.error("[inbound-effects] замок события не записан:", err instanceof Error ? err.name : "UnknownError");
    return true;
  }
}

/** Карточка по номеру WhatsApp. Старый ход связывает переписку, ядро — только читает (см. шапку). */
async function resolveClientId(input: InboundSideEffectsInput, linkedClientId: string | null): Promise<string | null> {
  if (input.source === "legacy") {
    const link = await linkWhatsAppConversationToClient(input.conversationId, input.channel, input.peer);
    return link.linked ? link.clientId : linkedClientId;
  }
  const waPhone = whatsAppPhoneFromSubscriberId(input.channel, input.peer);
  if (!waPhone) return linkedClientId;
  if (linkedClientId) {
    await rememberWhatsAppPhone(linkedClientId, waPhone);
    return linkedClientId;
  }
  const existing = await findClientByPhoneDigits(waPhone);
  if (!existing || existing.deletedAt) return null;
  await rememberWhatsAppPhone(existing.id, waPhone);
  return existing.id;
}

/**
 * Единая точка входа. Ждёт только то, от чего зависит ход старого бота (карточка,
 * досье, опрос о сделке); пуши и разборы уходят в фон и ход не задерживают.
 * Ядро зовёт её без ожидания вовсе.
 */
export async function applyInboundSideEffects(input: InboundSideEffectsInput): Promise<InboundSideEffectsResult> {
  if (!(await claimInboundEvent(input.channel, input.eventId))) return { status: "duplicate" };
  const text = input.text.trim();

  const conversation = await prisma.botConversation.findUnique({
    where: { id: input.conversationId },
    select: { clientId: true, contactProfileId: true, propertyChatAgentId: true },
  });
  if (!conversation) return { status: "applied", clientId: null, dealReview: null };

  let clientId = await resolveClientId(input, conversation.clientId);
  // Карточка в Корзине — не повод слать агенту пуш о клиенте, которого нет ни в
  // одном списке (аудит №4, 27.08). Старый ход сам отвязывает такую переписку.
  if (clientId) {
    const owner = await prisma.client.findUnique({ where: { id: clientId }, select: { deletedAt: true } });
    if (!owner || owner.deletedAt) clientId = null;
  }

  if (conversation.contactProfileId && clientId) await linkContactProfileToClient(conversation.contactProfileId, clientId);
  if (input.countAudience !== false) void recordAudienceMessage(input.channel);
  if (conversation.contactProfileId) {
    await recordContactTurn({
      profileId: conversation.contactProfileId,
      language: text ? detectClientLanguage(text) : null,
      conversationId: input.conversationId,
    });
  }

  // Ответ на опрос о сделке: оценка и рекомендация записываются до всего
  // остального, и сообщение дальше не считается «клиент написал» (Пачка 11).
  if (clientId) {
    const review = await tryHandleDealReviewReply(clientId, text).catch((err) => {
      console.error("[отзыв] перехват ответа упал:", err instanceof Error ? err.message : err);
      return { handled: false as const };
    });
    if (review.handled) return { status: "applied", clientId, dealReview: { reply: review.reply ?? "" } };
  }

  if (clientId) {
    void notifyAgentOfClientMessage(clientId, text, input.channel, input.peer,
      conversation.propertyChatAgentId ? input.conversationId : undefined);
  }
  void notifyPropertyChatMessage(input.conversationId);
  void analyzeMessageForPropertyCounts(clientId, text);
  if (clientId) {
    void checkExplicitRefusal({ clientId, text }).catch((err) =>
      console.error("[отказ] проверка явного отказа в переписке:", err instanceof Error ? err.message : err)
    );
  }

  // Старый ход делает следующие шаги сам, позже: после склейки сообщений и
  // расшифровки голосового (см. applyKnownClientMessageEffects и
  // checkClientInactiveSignal в conversation.ts). Ядру ждать нечего.
  if (input.source === "core" && clientId) {
    if (text) void checkClientInactiveSignal(clientId, text);
    await applyKnownClientMessageEffects(clientId, text);
  }
  return { status: "applied", clientId, dealReview: null };
}

/**
 * Сообщение от уже известного клиента (карточка есть): возврат из
 * «Потерянных», автопилот карточки, новый повод обратиться.
 *
 * Возврат — ДО автопилота: иначе пересчёт `client_message` читает ещё LOST и
 * молча пропускает карточку (ai/scoring.ts::SCORABLE_CLIENT_STATUSES).
 * Правило возврата (18.09.2026, «он же сам обратился»; исход B1, 02.10.2026):
 * прежнему агенту — принятым, с таймером возврата и пушем; прежний недоступен —
 * в очередь руководителя.
 */
export async function applyKnownClientMessageEffects(clientId: string, text: string): Promise<void> {
  const lostCheck = await prisma.client.findUnique({
    where: { id: clientId },
    select: { status: true, lastAgentId: true, deletedAt: true },
  });
  if (lostCheck && !lostCheck.deletedAt && lostCheck.status === "LOST") {
    const previousAgentId = await returningAgentStillAvailable(lostCheck.lastAgentId);
    await reactivateClientFromLost({
      clientId,
      reason: previousAgentId
        ? "Написал сам, потерянный клиент — возвращён прежнему агенту"
        : "Написал сам, потерянный клиент — прежний агент недоступен, очередь руководителя",
      agentId: previousAgentId ?? undefined,
      accept: !!previousAgentId,
      returnTimer: !!previousAgentId,
    }).catch((err) =>
      console.error("[messenger] реактивация LOST по сообщению:", err instanceof Error ? err.message : err)
    );
  }
  if (text) runClientAutopilotInBackground(clientId, "client_message");
  void detectNewInquiryFromKnownClient(clientId, text);
}
