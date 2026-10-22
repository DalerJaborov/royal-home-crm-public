import { maskPhones, type MessageSender } from "@royal-home/shared";
import { withManualCustomerDeliveryIntent } from "./customerManualDeliveryIntent.js";
import { isOutboundBlockedError, type OutboundOrigin } from "./outboundShield.js";
import { prisma, type TxClient } from "../db.js";
import { ownPropertyInterestConversationWhere } from "./ownBotConversationScope.js";
import { claimPropertyChatReply, rollbackPropertyChatReply, lockDeliveryOwnershipFence, sameDeliveryOwnershipFence,
  type DeliveryOwnershipFence, type PropertyChatClaimUndo } from "./propertyChatReply.js";
import { customerTransportInput, findScopedBotConversation, loadCustomerTransportForConversation,
  type CustomerTransportHint, type CustomerTransportReference } from "./customerConversationScope.js";
import { WEBSITE_CHANNEL } from "../messengers/channels.js";
import type { DeliveryTarget } from "./conversationState.js";
import { TG_PREFIX } from "./conversationId.js";

export { isClientLostOrAbandoned, isStalePause, type DeliveryTarget } from "./conversationState.js";
import {
  asMetaChannel,
  isMetaChannelEnabled,
  sendMessage as sendMetaMessage,
  sendAudio as sendMetaAudio,
  sendImage as sendMetaImage,
  sendVideo as sendMetaVideo,
  type MetaChannel,
} from "../messengers/meta.js";
// Из отдельного модуля, а не из meta.js: чистая проверка, которую тест доставки
// теперь берёт настоящую вместо копии (см. lib/messagingWindow.ts).
import { isMessagingWindowClosedError } from "./messagingWindow.js";
import { appendConversationMessages, appendTelegramConversationMessages } from "../messengers/appendMessages.js";
import {
  sendMessage as sendTelegramMessage,
  sendPhoto as sendTelegramPhoto,
  sendVideo as sendTelegramVideo,
  sendVoice as sendTelegramVoice,
  isTelegramEnabled,
  TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
} from "../telegram/api.js";
import { recordLesson } from "./botLessons.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";
import { guardBackgroundFailure, trackBackgroundTask } from "./shutdownState.js";
import { transcodeToOggOpus, transcodeToM4a, isSilentAudio } from "./audioTranscode.js";
import { saveOutgoingVoice } from "./outgoingVoice.js";
import { uploadOutgoingMedia } from "./outgoingMedia.js";
import { r2PresignDownloadUrl, isR2Configured } from "./r2Client.js";
import { publicUploadUrl, crmPublicBase } from "./crmPublicUrl.js";
import { transcribeAudio } from "../ai/transcribe.js";
import { checkAgentVoiceMessage } from "../ai/voiceComplianceGuard.js";
import { alertVoiceViolation } from "./voiceSecurityAlert.js";
import { checkAgentPhoneAsk } from "./agentPhoneAskDetector.js";
import { markAgentAttempt } from "./clientWorkStalled.js";
import { closeStaleNextActions } from "./nextActionAutoClose.js";
import { closeAutoTasks } from "./autoTasks.js";
import { findAgentsWithPermission } from "./recipients.js";
import { closeLeadPushNotifications } from "../push.js";
import { detectOperatorShowingAgreement } from "./operatorShowingDetector.js";
import { rememberAgentReply } from "../ai/styleLearning.js";

/** Capture before ASR/uploads/pause; the provider revalidates this exact revision before POST. */
async function captureDeliveryTransport(target: DeliveryTarget): Promise<CustomerTransportReference | null> {
  if (target.kind !== "bot" || target.channel === WEBSITE_CHANNEL) return null;
  const current = await loadCustomerTransportForConversation(target.id);
  if (!current || current.channel !== target.channel) return null;
  if (target.transport && (
    current.endpointScopeId !== target.transport.endpointScopeId ||
    current.transportKey !== target.transport.transportKey ||
    current.scopeRevision !== target.transport.scopeRevision ||
    current.accountId !== target.transport.accountId
  )) return null;
  return target.transport ?? current;
}

const TRANSPORT_CHANGED = { ok: false as const, status: 409,
  error: "Аккаунт переписки изменился или недоступен. Обновите переписку перед отправкой." };

/**
 * Клиент, которому уходит сообщение (18.08.2026, см. lib/nextActionAutoClose.ts):
 * оператор/бот ответил клиенту — новое реальное взаимодействие, значит старые
 * открытые подсказки «Мой фокус» этого клиента больше не актуальны. Диалог мог
 * ещё не превратиться в лида (clientId пуст) — тогда закрывать нечего.
 *
 * Отдельный запрос вместо чтения из update() выше: у update() под рукой всегда
 * есть свежий clientId только там, где вызывающий явно выбрал его в select —
 * проще и безопаснее одним общим маленьким запросом на все три функции.
 */
async function closeStaleNextActionsForTarget(target: DeliveryTarget): Promise<void> {
  try {
    const clientId =
      target.kind === "telegram"
        ? (await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId
        : (await prisma.botConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId;
    if (clientId) {
      await closeStaleNextActions(clientId);
      // «Написать в чат нельзя, окно закрыто — позвоните…» (lib/agentUnansweredAlarm.ts) —
      // сообщение ушло, значит окно на самом деле было открыто (21.09.2026,
      // lib/autoTasks.ts). Вызывается и на входящее (клиент ответил сам), и на
      // исходящее — оба варианта означают «связь есть».
      await closeAutoTasks(clientId, ["chat_window_closed"]);
    }
  } catch (err) {
    console.error("[переписка] закрытие старых подсказок:", err instanceof Error ? err.message : err);
  }
}

/**
 * Пауза бота после ручного сообщения оператора, когда вызывающий не задал свой срок.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 18.08.2026: любой ручной ответ агента (текст/голос/медиа, из CRM
 * или из самого мессенджера) означает ПОЛНУЮ передачу диалога агенту — то же самое,
 * что раньше делал только пресет «Бессрочно» в интерфейсе. Раньше здесь стояли 10
 * минут: бот мог сам вернуться в разговор, который агент уже ведёт вручную, и
 * ответить поверх него. Теперь дефолт — тот же принцип «навсегда», что и у пресета
 * «Бессрочно» в apps/web/src/lib/botPauseOptions.ts (10 лет вперёд, а не буквальное
 * «навсегда» — не оставляет в БД магического null-like значения; снимается только
 * кнопкой «Вернуть боту»).
 *
 * Агент по-прежнему может явно задать более короткий срок через pausedUntilOverride —
 * это меняет только сам дефолт, а не саму возможность выбора.
 */
export const OPERATOR_REPLY_PAUSE_MS = 60 * 24 * 365 * 10 * 60 * 1000;

/**
 * Короткая пауза (10 минут, прежнее поведение) — дефолт для случаев, когда ответ
 * НЕ от закреплённого за клиентом агента (см. defaultPauseForSender ниже).
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 18.08.2026 (уточнение к «бессрочно» выше): «бессрочно»
 * оправдано только когда отвечает СВОЙ агент клиента — он реально забирает
 * диалог себе. Если директор/администратор разово ответил лиду, у которого
 * ещё нет закреплённого агента (или закреплён кто-то другой), это разовая
 * помощь, а не передача диалога — бот не должен молчать годами из-за неё.
 */
export const OPERATOR_REPLY_PAUSE_MS_SHORT = 10 * 60 * 1000;

/**
 * ОТВЕТ ИЗ ПРИЛОЖЕНИЯ META (эхо, мимо CRM) — 12 ЧАСОВ, А НЕ 10 МИНУТ (28.09.2026).
 *
 * Жалоба владельца со скриншотом: директор ответил клиенту из приложения Facebook,
 * а бот продолжал писать тому же человеку. Эхо ставило ту же короткую паузу, что и
 * разовая помощь из CRM, — через 10 минут бот возвращался в разговор, который живой
 * человек ещё вёл. Кто держал телефон, Meta не сообщает, поэтому «бессрочно»
 * (только своему агенту, решение 18.08) здесь не годится; 12 часов покрывают
 * рабочий разговор целиком, а наутро бот снова отвечает сам. Раньше вернуть
 * бота — кнопка «Вернуть боту» в переписке.
 */
export const OPERATOR_ECHO_PAUSE_MS = 12 * 60 * 60 * 1000;

/**
 * Дефолтная длительность паузы для ручного ответа без явного pausedUntilOverride:
 * бессрочно — только если отвечает сотрудник, закреплённый за клиентом этого
 * диалога (Client.assignedAgentId), иначе короткая пауза (см. OPERATOR_REPLY_PAUSE_MS_SHORT).
 *
 * Разово отвечающий директор/незакреплённый агент, и любой ответ клиенту без
 * карточки (clientId ещё нет — диалог не стал лидом) — короткая пауза: некого
 * сверять с assignedAgentId, значит это не «передача диалога агенту».
 */
export async function defaultPauseForSender(target: DeliveryTarget, sender?: MessageSender): Promise<number> {
  if (!sender || sender.kind !== "agent") return OPERATOR_REPLY_PAUSE_MS_SHORT;
  try {
    const clientId =
      target.kind === "telegram"
        ? (await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId
        : (await prisma.botConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId;
    if (target.kind === "bot" && await prisma.botConversation.findFirst({
      where: { id: target.id, ...ownPropertyInterestConversationWhere(sender.agentId) }, select: { id: true },
    })) return OPERATOR_REPLY_PAUSE_MS;
    if (!clientId) return OPERATOR_REPLY_PAUSE_MS_SHORT;
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { assignedAgentId: true, agentAttentionRequestedAt: true },
    });
    if (client?.assignedAgentId !== sender.agentId) return OPERATOR_REPLY_PAUSE_MS_SHORT;
    // Свой агент ответил сам — реальный контакт состоялся, ту же метку гасит
    // и pauseConversationsAfterRealContact (звонок) в этом же файле ниже.
    if (client.agentAttentionRequestedAt) {
      await prisma.client.update({ where: { id: clientId }, data: { agentAttentionRequestedAt: null } }).catch(() => {});
    }
    return OPERATOR_REPLY_PAUSE_MS;
  } catch (err) {
    console.error("[переписка] проверка закреплённого агента для паузы:", err instanceof Error ? err.message : err);
    // Не удалось проверить — безопаснее короткая пауза, чем случайное «навсегда».
    return OPERATOR_REPLY_PAUSE_MS_SHORT;
  }
}

/**
 * Поставить паузу бота после отправки и вернуть срок, который реально стоит.
 *
 * Срок по умолчанию (оператор не выбирал его сам) и любая отправка от имени бота
 * НИКОГДА не укорачивают уже действующую паузу (23.09.2026). Раньше запись была
 * безусловной: свой агент ответил клиенту — пауза на 10 лет; следом CRM сама
 * слала напоминание о показе, вопрос об отзыве или «уточняю у собственника»
 * (без отправителя-агента — короткая пауза), и срок сжимался до 10 минут. Через
 * 10 минут бот снова вёл разговор параллельно с агентом, клиент получал два
 * противоречащих ответа, агент об этом не знал.
 *
 * Явный срок, который выбрал живой человек (инбокс: «пауза на час»), ставится как
 * есть — укоротить паузу сознательно агент по-прежнему может.
 */
export async function applyDeliveryPause(
  target: Pick<DeliveryTarget, "kind" | "id">,
  pausedUntil: Date,
  keepLonger: boolean,
  database: Pick<TxClient, "botConversation" | "telegramConversation"> = prisma
): Promise<Date> {
  const now = new Date();
  const isTelegram = target.kind === "telegram";
  if (!keepLonger) {
    if (isTelegram) await database.telegramConversation.update({ where: { id: target.id }, data: { pausedUntil, botPausedAt: now } });
    else await database.botConversation.update({ where: { id: target.id }, data: { pausedUntil, botPausedAt: now } });
    return pausedUntil;
  }
  // botPausedAt двигается только вместе со сроком: действующую паузу начал не этот
  // вызов, и «пауза протухла» (conversationState.isStalePause) считается от её начала.
  const where = { id: target.id, OR: [{ pausedUntil: null }, { pausedUntil: { lt: pausedUntil } }] };
  const data = { pausedUntil, botPausedAt: now };
  const { count } = isTelegram
    ? await database.telegramConversation.updateMany({ where, data })
    : await database.botConversation.updateMany({ where, data });
  if (count > 0) return pausedUntil;
  const current = isTelegram
    ? await database.telegramConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } })
    : await database.botConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } });
  if (!current) throw new Error(`Диалог ${target.id} не найден`);
  return current.pausedUntil ?? pausedUntil;
}

/**
 * Что нужно, чтобы откатить паузу, поставленную applyDeliveryPause (аудит
 * CHANNEL-NEW-08, 04.10.2026): прежние значения и срок, который поставили МЫ.
 */
export type PauseUndo = {
  target: Pick<DeliveryTarget, "kind" | "id">;
  prevPausedUntil: Date | null;
  prevBotPausedAt: Date | null;
  placed: Date;
  placedBotPausedAt: Date | null;
  ownershipFence: DeliveryOwnershipFence;
  claimUndo?: PropertyChatClaimUndo | null;
  pauseChanged?: boolean;
};

/**
 * applyDeliveryPause + снимок прежней паузы для отката. Откат нужен, только если
 * срок в базе поставили мы: когда действующая пауза длиннее и вызов её не тронул
 * (keepLonger), возвращаем undo = null, откатывать нечего. Claim, снимок и
 * пауза атомарны; ошибка снимка откатывает транзакцию до отправки.
 */
async function applyDeliveryPauseUndoable(
  target: Pick<DeliveryTarget, "kind" | "id">,
  pausedUntil: Date,
  keepLonger: boolean,
  sender?: MessageSender
): Promise<{ ok: true; pausedUntil: Date; undo: PauseUndo | null } | { ok: false; status: number; error: string }> {
  return prisma.$transaction(async tx => {
    const initialFence = await lockDeliveryOwnershipFence(tx, target);
    if (!initialFence) return { ok: false as const, status: 409, error: "Диалог изменился. Обновите чат и отправьте сообщение ещё раз." };
    const claim = target.kind === "bot" ? await claimPropertyChatReply(target.id, sender, tx) : { ok: true as const, undo: null };
    if (!claim.ok) return claim;
    const select = { pausedUntil: true, botPausedAt: true } as const;
    const prev =
      target.kind === "telegram"
        ? await tx.telegramConversation.findUnique({ where: { id: target.id }, select })
        : await tx.botConversation.findUnique({ where: { id: target.id }, select });
    if (!prev) throw new Error("Delivery lost its native conversation");
    const effective = await applyDeliveryPause(target, pausedUntil, keepLonger, tx);
    const placedRow = target.kind === "telegram" ? await tx.telegramConversation.findUnique({ where: { id: target.id }, select })
      : await tx.botConversation.findUnique({ where: { id: target.id }, select });
    const ownershipFence = await lockDeliveryOwnershipFence(tx, target);
    if (!placedRow || !ownershipFence) throw new Error("Delivery lost its customer inquiry anchor");
    const pauseChanged = prev.pausedUntil?.getTime() !== placedRow.pausedUntil?.getTime() ||
      prev.botPausedAt?.getTime() !== placedRow.botPausedAt?.getTime();
    if (!pauseChanged && !claim.undo) return { ok: true, pausedUntil: effective, undo: null };
    return {
      ok: true,
      pausedUntil: effective,
      undo: { target, prevPausedUntil: prev.pausedUntil, prevBotPausedAt: prev.botPausedAt,
        placed: effective, placedBotPausedAt: placedRow.botPausedAt, ownershipFence, claimUndo: claim.undo, pauseChanged },
    };
  });
}

/**
 * Откатить паузу после ТОЧНО неудавшейся отправки (решение владельца 04.10.2026,
 * CHANNEL-NEW-08): клиенту заведомо ничего не ушло (закрытое окно, щит, сбой до
 * самой отправки), значит оператор диалог не взял, и бот молчать не должен.
 *
 * Монотонная ownership revision и обе даты не дают затереть чужую паузу,
 * даже если новый оператор вернул прежние даты (A→B→A).
 * Если исход отправки неизвестен (таймаут/сбой транспорта) — НЕ вызывать: там
 * сообщение могло дойти, и бот не должен отвечать поверх человека.
 * Сбой самого отката не ломает ответ вызывающему: пауза просто останется.
 */
async function rollbackDeliveryPause(undo: PauseUndo | null): Promise<void> {
  if (!undo) return;
  try {
    await prisma.$transaction(async tx => {
      const current = await lockDeliveryOwnershipFence(tx, undo.target);
      if (!sameDeliveryOwnershipFence(current, undo.ownershipFence)) return;
    // Compare the FINAL epoch captured after both claim and pause. Restore both
    // in the same transaction; an A→B→A owner/pause cannot revive this undo.
      if (undo.claimUndo) await rollbackPropertyChatReply({ ...undo.claimUndo, ownershipFence: undo.ownershipFence }, tx);
      if (undo.pauseChanged === false) return;
      const where = { id: undo.target.id, pausedUntil: undo.placed, botPausedAt: undo.placedBotPausedAt };
      const data = { pausedUntil: undo.prevPausedUntil, botPausedAt: undo.prevBotPausedAt };
      if (undo.target.kind === "telegram") await tx.telegramConversation.updateMany({ where, data });
      else await tx.botConversation.updateMany({ where, data });
    });
  } catch (err) {
    console.error("[переписка] откат паузы после неудачной отправки:", err instanceof Error ? err.message : err);
  }
}

/**
 * Текущая пауза как есть, без единой записи (24.09.2026, ночная проверка).
 *
 * Только для `sender: "system"` в `deliverToConversation` ниже — служебная
 * рассылка (просьба подтвердить показ, напоминание) не должна ставить паузу
 * бота вовсе, даже если её раньше не было или срок истёк: клиент получает
 * служебный вопрос не от оператора, и бот не обязан на это молчать. Пауза,
 * которую уже поставил кто-то другой (агент/бот), этим вызовом не трогается —
 * ни продлить, ни снять. Нет активной паузы — возвращаем «сейчас»: для
 * вызывающих `system`-веткой значение результата нигде не читается, а
 * семантически «сейчас» и есть «бот не на паузе».
 */
async function currentPausedUntil(target: Pick<DeliveryTarget, "kind" | "id">): Promise<Date> {
  const isTelegram = target.kind === "telegram";
  const current = isTelegram
    ? await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } })
    : await prisma.botConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } });
  return current?.pausedUntil ?? new Date();
}

/**
 * Рука сотрудника или инициатива CRM.
 *
 * `agent` — живой человек нажал «Отправить» в CRM: щит такое не ограничивает
 * никогда (решение владельца 17.09.2026). Всё остальное — `bot`/`system`,
 * то есть автоматическая рассылка, и правила щита к ней применимы полностью.
 */
function senderOrigin(sender?: MessageSender): OutboundOrigin {
  return sender?.kind === "agent" ? "staff" : "bot";
}

export type DeliveryResult =
  | { ok: true; masked: boolean; pausedUntil: Date }
  | { ok: false; status: number; error: string; code?: "window_closed" };

/**
 * Отправка сообщения клиенту в тот канал, откуда он писал.
 *
 * Вынесено из POST /conversations/:id/reply, чтобы тем же путём могла ходить отправка
 * из карточки клиента: инбокс закрыт правом messages.view (рядовой агент переписку бота
 * не видит), а отправлять подобранные объекты своему клиенту агент обязан уметь.
 *
 * Порядок шагов сохранён от исходного маршрута и важен:
 *  - пауза ставится ДО отправки: оператор вступает в диалог самим фактом сообщения, и чем
 *    раньше бот замолкает, тем меньше окно, в котором он ответит поверх человека. Если
 *    отправка сорвётся ТОЧНО (закрытое окно, щит), пауза откатывается (CHANNEL-NEW-08,
 *    04.10.2026): клиенту ничего не ушло, оператор диалог не взял. Если исход неизвестен
 *    (таймаут, сбой транспорта) — бот просто помолчит, это безопаснее двойного ответа;
 *  - телефоны маскируются ДО отправки, чтобы увести переписку в личный WhatsApp через
 *    свой номер агент не мог. Ссылки и почта не трогаются — ссылка на объект уходит целой;
 *  - в историю пишется то, что клиент РЕАЛЬНО получил (с маской), и только после успешной
 *    доставки: сообщения, которого клиент не видел, в переписке быть не должно.
 */
export async function deliverToConversation(
  target: DeliveryTarget,
  text: string,
  /** Оператор может задать свой срок паузы (инбокс это умеет); по умолчанию — бессрочно (см. OPERATOR_REPLY_PAUSE_MS). */
  pausedUntilOverride?: Date,
  options?: {
    /** Живой человек отвечает ВМЕСТО бота — записать случай на обучение. Не ставится
     *  для служебных отправок (ссылки на объекты): там бот не ошибался. */
    learnFromOverride?: boolean;
    /** Кто в самом деле пишет — для подписи в переписке (см. MessageSender). Не
     *  задано — «system»: большинство служебных отправок (просьба подтвердить
     *  показ, напоминание) без человека за штурвалом, и «system» честнее, чем
     *  молча приписывать их боту или безымянному «кому-то». */
    sender?: MessageSender;
  }
): Promise<DeliveryResult> {
  const isTelegram = target.kind === "telegram";
  const capturedTransport = await captureDeliveryTransport(target);
  if (!isTelegram && target.channel !== WEBSITE_CHANNEL && !capturedTransport) return TRANSPORT_CHANGED;
  /**
   * ЧАТ НА САЙТЕ — ТРАНСПОРТА НЕТ, И ЭТО НОРМА (23.08.2026).
   *
   * У мессенджеров ответ надо КУДА-ТО отправить: Graph API, Telegram. У чата на
   * сайте отправлять некуда — посетитель сам забирает новые реплики (см. вебхук
   * /website-chat в routes/webhooks.ts). Поэтому здесь пропускается ровно один шаг
   * — сетевая отправка; всё остальное общее: пауза бота, маскировка телефонов,
   * запись в переписку, обучение на ответе живого агента. Отдельная ветка
   * доставки для сайта была бы вторым путём, а два пути расходятся молча.
   */
  const isWebsite = !isTelegram && target.channel === WEBSITE_CHANNEL;
  const metaChannel = isTelegram || isWebsite ? null : asMetaChannel(target.channel);
  const canSendViaMeta = metaChannel !== null && (await isMetaChannelEnabled(metaChannel));

  if (isWebsite ? false : isTelegram ? !isTelegramEnabled() : !canSendViaMeta) {
    return {
      ok: false,
      status: 503,
      error: isTelegram
        ? "Отправка не настроена (TELEGRAM_BOT_TOKEN)"
        : metaChannel
          ? `Ответ в ${metaChannel} не отправить: канал выключен или не заданы ключи в Настройках → Meta.`
          : `Канал ${target.kind === "bot" ? target.channel : ""} больше не поддерживается: отвечать можно в WhatsApp, Instagram, Messenger и Telegram.`,
    };
  }

  // Снимок последней реплики бота — ДО того, как допишем ответ оператора: после
  // дописывания последним окажется сам оператор, и учиться будет не на чем.
  const lastBotMessage = options?.learnFromOverride ? await lastAssistantMessage(target) : null;

  /**
   * СЛУЖЕБНАЯ ОТПРАВКА («system») ПАУЗУ НЕ СТАВИТ (24.09.2026, ночная проверка).
   *
   * `sender` не задан или явно `{kind:"system"}` — то же самое (см. запись
   * реплики ниже: `options?.sender ?? {kind:"system"}`) — просьба подтвердить
   * показ, напоминание и другой автоматический текст без человека за штурвалом.
   * До этой правки такая отправка всё равно писала/продлевала паузу бота
   * «оператор взял разговор» (не укорачивая действующую — applyDeliveryPause,
   * 23.09.2026, #801 — но и это неверно): клиент получал служебный вопрос, а
   * бот потом молчал, как будто с ним говорит человек. Действующую паузу (её
   * поставил агент или бот) не трогаем совсем — currentPausedUntil читает, не пишет.
   *
   * Срок по умолчанию для остальных отправителей и отправка от имени бота
   * действующую паузу не укорачивают (applyDeliveryPause); явный срок оператора
   * ставится как есть.
   */
  const isSystemSender = !options?.sender || options.sender.kind === "system";
  let pauseUndo: PauseUndo | null = null;
  let pausedUntil: Date;
  if (isSystemSender) {
    pausedUntil = await currentPausedUntil(target);
  } else {
    // Откат при ТОЧНО неудавшейся отправке (закрытое окно, щит) — ниже в catch;
    // при неизвестном исходе пауза остаётся (CHANNEL-NEW-08, решение 04.10.2026).
    const placed = await applyDeliveryPauseUndoable(
      target,
      pausedUntilOverride ?? new Date(Date.now() + (await defaultPauseForSender(target, options?.sender))),
      !pausedUntilOverride || options?.sender?.kind === "bot",
      options?.sender
    );
    if (!placed.ok) return placed;
    pausedUntil = placed.pausedUntil;
    pauseUndo = placed.undo;
  }

  const { text: outgoing, masked } = maskPhones(text);

  // The provider loads credentials for the captured namespace inside the guarded send.
  // No late account/default-token lookup outside its error/rollback boundary.
  const accountToken = undefined;

  // Идентификатор отправленного сообщения у Meta: клиент может ответить именно на
  // него («ответить» в мессенджере), и по нему в переписке нарисуется цитата.
  // У Telegram своего идентификатора здесь не берём — цитаты пока только у Meta.
  let sentMid: string | null = null;
  try {
    // Чат на сайте: отправлять некуда — реплика просто ложится в переписку ниже,
    // и посетитель заберёт её следующим опросом.
    if (isWebsite) sentMid = null;
    // Щит исходящих стоит в обоих транспортах (lib/outboundShield.ts). Отсюда
    // ему нужно знать только одно: рука сотрудника это или автомат.
    else if (isTelegram)
      await sendTelegramMessage(target.subscriberId, outgoing, undefined, undefined, {
        origin: senderOrigin(options?.sender),
      });
    else
      sentMid = await withManualCustomerDeliveryIntent(options?.sender, () => sendMetaMessage(metaChannel!, target.subscriberId, outgoing, accountToken, {
        origin: senderOrigin(options?.sender),
        transport: capturedTransport!,
      }));
  } catch (err) {
    console.error("[conversations] отправка сообщения:", err instanceof Error ? err.message : err);
    // Закрытое 24-часовое окно — отдельный, узнаваемый случай (владелец
    // 22.08.2026): агент должен увидеть ПОЧЕМУ не ушло, а не общее «не удалось».
    // Telegram такого ограничения не знает — проверяем только Meta.
    //
    // ПРОВЕРЯЕМ ДО logSystemError (25.08.2026): это штатное ограничение платформы,
    // а не поломка CRM, и Graph API кладёт в текст ошибки уникальный fbtrace_id —
    // 10-минутная дедупликация журнала по тексту его не ловит, и КАЖДОЕ закрытое
    // окно будило директора как «новый вид ошибки» (найдено по журналу: 4 записи
    // с этим кодом за несколько минут 25.08.2026). Агент уже видит понятный текст
    // ниже — второй раз объяснять то же самое директору не о чем.
    // Щит исходящих — отказ осмысленный, и агент должен увидеть ПОЧЕМУ.
    if (isOutboundBlockedError(err)) {
      await rollbackDeliveryPause(pauseUndo);
      return { ok: false, status: 409, error: `Сообщение не отправлено: ${err.message}` };
    }
    if (!isTelegram && err instanceof Error && isMessagingWindowClosedError(err.message)) {
      await rollbackDeliveryPause(pauseUndo);
      return {
        ok: false,
        status: 502,
        code: "window_closed",
        error:
          "Клиент не писал последние 24 часа — WhatsApp и Instagram запрещают отправлять свободный текст, пока он не напишет первым. Дождитесь его сообщения или позвоните.",
      };
    }
    // Часть вызовов сюда — фоновые (напоминания о показе, ответ на «уточню у
    // собственника» без карточки под рукой): там нет запроса, ждущего 502, и без
    // записи в журнал отказ пропадал бесследно — экран «Здоровье системы» этого
    // не видел, как и уже исправлено для остальных отправок в meta.ts/ownerQuestionAnswer.ts.
    void logSystemError(isTelegram ? "telegram" : "meta", `Сообщение клиенту не отправлено: ${describeError(err)}`);
    return { ok: false, status: 502, error: "Не удалось отправить сообщение" };
  }

  // Ответ оператора сохраняем как assistant — ИИ увидит его в контексте, когда бота вернут.
  const message = [
    {
      role: "assistant" as const,
      content: outgoing,
      by: options?.sender ?? { kind: "system" as const },
      ...(sentMid ? { mid: sentMid } : {}),
    },
  ];
  if (isTelegram) await appendTelegramConversationMessages(target.id, message);
  else await appendConversationMessages(target.id, message);
  void closeStaleNextActionsForTarget(target);

  // Агент договорился о показе словами, а не кнопкой «Назначить показ» (18.08.2026,
  // см. lib/operatorShowingDetector.ts) — не должно задерживать сам ответ клиенту.
  void detectOperatorShowingAgreement(target, outgoing, options?.sender).catch((err) =>
    void logSystemError("ai", `Разбор договорённости о показе (ручной ответ): ${describeError(err)}`)
  );

  // Живой сотрудник вмешался в разговор — значит бот ответил не так, а человек
  // показал, как надо. Запоминаем пару «вопрос клиента → его ответ» образцом
  // манеры (просьба владельца 22.08.2026, см. ai/styleLearning.ts). Фоново и тем
  // же способом, что разбор договорённости о показе выше: обучение не имеет права
  // задерживать ответ клиенту и не имеет права его сорвать.
  void rememberAgentStyleExample(target, outgoing, options?.sender).catch((err) =>
    console.error("[переписка] образец манеры не сохранён:", err instanceof Error ? err.message : err)
  );

  // Человек ответил вместо бота — значит бот не справился, а этот ответ и есть
  // правильный. Учимся на паре. Не ждём: обучение не должно задерживать ответ в UI.
  if (lastBotMessage) {
    void recordLesson({
      kind: "operator_override",
      channel: isTelegram ? "TELEGRAM" : target.channel,
      conversationId: target.id,
      botMessage: lastBotMessage,
      humanMessage: outgoing,
    });
  }

  // Детектор «агент спросил номер» (требование 11 аудита 02.09.2026).
  // Проверяем ИСХОДНЫЙ текст агента (до маскировки), потому что маска заменяет
  // цифры на ****, и паттерн «+992» уже не сработает. Фоново — не задерживаем ответ.
  if (options?.sender && options.sender.kind === "agent") {
    const clientId =
      target.kind === "telegram"
        ? (await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId ?? null
        : (await prisma.botConversation.findUnique({ where: { id: target.id }, select: { clientId: true } }))?.clientId ?? null;
    void checkAgentPhoneAsk({
      agentId: options.sender.agentId,
      agentName: options.sender.agentName ?? "Агент",
      clientId,
      clientName: null,
      channel: "text",
      text,
    }).catch((err) =>
      console.error("[phone-ask] текстовое сообщение:", err instanceof Error ? err.message : err)
    );

    /**
     * ЖИВОЙ ЧЕЛОВЕК ОТВЕТИЛ — ПРЕДЕЛ ИИ БОЛЬШЕ НЕ «ГОРИТ» (найдено 07.09.2026,
     * тот же класс, что и lead-escalated-*). `notifyStaff` (lib/aiDailyBudget.ts)
     * рассылает «🤖 Бот передал диалог вам» либо ОДНОМУ агенту клиента, либо, если
     * карточки нет, ВСЕМ с правом messages.view — а закрытия не было вовсе: пуш
     * оставался в шторке у всех получателей даже после того, как кто-то из них уже
     * подключился и ответил. Закрываем для обоих возможных наборов получателей —
     * лишнее закрытие несуществующего уведомления безопасно.
     */
    void (async () => {
      const recipients = new Set(await findAgentsWithPermission("messages.view"));
      if (clientId) {
        const client = await prisma.client.findUnique({ where: { id: clientId }, select: { assignedAgentId: true } });
        if (client?.assignedAgentId) recipients.add(client.assignedAgentId);
      }
      await closeLeadPushNotifications([...recipients].map((id) => ({ agentId: id, tag: `ai-budget-${target.id}` })));
    })().catch((err) => console.error("[push] закрытие предела ИИ после ответа агента:", err));

    // lastContactAt (07.09.2026): ручной ответ агента в переписке раньше НЕ двигал
    // эту метку вовсе — её обновляли только звонок/показ/запись в хронологии
    // (см. doc-comment у Client.lastContactAt в schema.prisma). Из-за этого
    // алармы «клиент без контакта N дней» (lib/agentOffCrmAlarm.ts и другие,
    // читающие lastContactAt) ложно срабатывали бы на агента, который на самом
    // деле активно переписывается с клиентом через инбокс CRM, просто не звонит
    // и не жмёт «показ»/«добавить взаимодействие».
    if (clientId) {
      trackBackgroundTask(
        prisma.client
          .update({ where: { id: clientId }, data: { lastContactAt: new Date() } })
          .catch((err) => {
            if (guardBackgroundFailure("lastContactAt после переписки", err)) return;
            console.error("[переписка] lastContactAt не обновлён:", err instanceof Error ? err.message : err);
          })
      );
      /**
       * ПОПЫТКА АГЕНТА СВЯЗАТЬСЯ (владелец 08.09.2026, см. lib/clientWorkStalled.ts).
       * Отправленное сообщение — второй и последний способ, которым агент может
       * дотянуться до клиента (первый — звонок через CRM). Больше ему дотянуться
       * нечем: номера он не видит. Значит эти два источника и составляют полную
       * картину «агент пытался».
       */
      // Только НАЗНАЧЕННОМУ агенту: ответ на «уточню у собственника» уходит от
      // имени того, кто ответил, а ответить мог владелец — чужая работа не должна
      // обнулять счётчик тишины агента (см. lib/clientWorkStalled.ts).
      void markAgentAttempt(clientId, new Date(), options.sender.agentId);
    }
  }

  return { ok: true, masked, pausedUntil };
}

export type VoiceDeliveryResult =
  | { ok: true; pausedUntil: Date }
  | { ok: false; status: number; error: string; blocked?: boolean; code?: "window_closed" };

/**
 * Голосовое БОТА устарело: диалог взят оператором (пауза впереди), клиент отписался
 * или диалога уже нет. Для живого сотрудника проверка не нужна: он сам и ставит паузу.
 * Возвращает причину отказа или null.
 */
async function botVoiceStaleReason(target: DeliveryTarget, sender: MessageSender): Promise<string | null> {
  if (sender.kind !== "bot") return null;
  const row =
    target.kind === "telegram"
      ? await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true } })
      : await prisma.botConversation.findUnique({ where: { id: target.id }, select: { pausedUntil: true, optedOutAt: true } });
  if (!row) return "Диалог удалён, голосовое бота не отправлено";
  if ("optedOutAt" in row && row.optedOutAt) return "Клиент отписался, голосовое бота не отправлено";
  if (row.pausedUntil && row.pausedUntil.getTime() > Date.now()) {
    return "Диалог взят оператором, голосовое бота не отправлено";
  }
  return null;
}

/**
 * Отправка ГОЛОСОВОГО сотрудника клиенту (16.08.2026, по просьбе владельца: «всегда
 * писать неудобно» + «если агент пытается через голосовые сказать свой номер или
 * выманить номер — блок и тревога руководству»).
 *
 * Только каналы Meta: у Telegram-бота своей отправки медиа в этой CRM нет, и заводить
 * её ради голосового — отдельная задача. Текстовый путь (deliverToConversation) для
 * Telegram как работал, так и работает.
 *
 * Порядок шагов — и он жёсткий, менять местами нельзя:
 *  1. перекодировать в ogg/opus (иначе Meta отклонит сам файл);
 *  2. расшифровать — БЕЗ текста охрана слепа, поэтому сбой расшифровки блокирует
 *     отправку («fail closed»), а не пропускает голосовое непроверенным;
 *  3. прогнать текст через checkAgentVoiceMessage — так же, как maskPhones для
 *     текстового ответа, только для голоса пропустить нельзя НИЧЕГО: замаскировать
 *     часть аудиодорожки невозможно, поэтому нарушение блокирует отправку целиком;
 *  4. пауза бота — ПОСЛЕ проверки охраной (заблокированная попытка не повод молчать
 *     всем, включая бота), но ДО самой отправки, как у текста. Если дальше клиенту
 *     заведомо ничего не ушло (файл не обработался/не сохранился, закрытое окно),
 *     пауза откатывается (CHANNEL-NEW-08, 04.10.2026); при неизвестном исходе
 *     транспорта остаётся: сообщение могло дойти;
 *  5. отправка, запись в историю, ровно тем же путём (mid, подпись), что у текста.
 */
export async function deliverVoiceToConversation(
  target: DeliveryTarget,
  audio: { buffer: Buffer },
  options: {
    pausedUntilOverride?: Date;
    sender: MessageSender;
    /** Для тревоги руководству — кто и кому. Не обязательно клиент CRM (диалог мог
     *  ещё не превратиться в лида). */
    clientId: string | null;
    clientName: string | null;
  }
): Promise<VoiceDeliveryResult> {
  const isTelegram = target.kind === "telegram";
  const capturedTransport = await captureDeliveryTransport(target);
  if (!isTelegram && target.channel !== WEBSITE_CHANNEL && !capturedTransport) return TRANSPORT_CHANGED;
  const isWebsite = !isTelegram && target.channel === WEBSITE_CHANNEL;
  // Чат на сайте — честная причина другая: канал включён и ключи ни при чём,
  // просто голосовые в веб-чат пока не доставляются (нет транспорта под них,
  // см. докстринг deliverToConversation выше). Раньше сюда падал общий текст
  // про «канал выключен или не заданы ключи в Настройках → Meta», который для
  // WEBSITE неверен и вводит в заблуждение (11.09.2026 — то же для медиа ниже).
  if (isWebsite) {
    return { ok: false, status: 422, error: "Чат на сайте пока не умеет отправлять файлы и голосовые, отправьте текстом" };
  }
  const metaChannel = isTelegram ? null : asMetaChannel(target.channel);
  if (isTelegram ? !isTelegramEnabled() : !metaChannel || !(await isMetaChannelEnabled(metaChannel))) {
    return {
      ok: false,
      status: 503,
      error: isTelegram
        ? "Отправка не настроена (TELEGRAM_BOT_TOKEN)"
        : `Ответ в ${target.channel} не отправить: канал выключен или не заданы ключи в Настройках → Meta.`,
    };
  }

  // Фоновое голосовое бота идёт ВДОГОНКУ уже отправленному тексту, и пока оно
  // готовится (перекодирование, расшифровка, проверка), оператор может взять диалог
  // (CHANNEL-NEW-09). Проверяем до дорогих шагов и ещё раз перед паузой и отправкой.
  const staleBefore = await botVoiceStaleReason(target, options.sender);
  if (staleBefore) return { ok: false, status: 409, error: staleBefore };

  const ogg = await transcodeToOggOpus(audio.buffer);
  if (!ogg) {
    return { ok: false, status: 422, error: "Не удалось обработать голосовое — попробуйте записать ещё раз или напишите текстом" };
  }

  /**
   * ТИШИНА ДО GEMINI, А НЕ ПОСЛЕ (16.08.2026). Молчащая запись до модели вообще не
   * доходит: тишине нечего расшифровывать, а Gemini на пустом звуке иногда СОЧИНЯЕТ
   * правдоподобную фразу вместо честной пустой строки — и та ложится в переписку
   * как будто агент это сказал (см. audioTranscode.ts → isSilentAudio, разбор
   * найденного случая). Голосовое при этом всё равно уходит клиенту: тишина в
   * тексте-подписи не повод не отправлять звук.
   */
  const transcript = (await isSilentAudio(ogg)) ? "" : await transcribeAudio(ogg, "voice.ogg", "audio/ogg");
  if (transcript === null) {
    // Блокировка отправки здесь ШТАТНАЯ (checkAgentVoiceMessage ниже без
    // расшифровки просто нечего проверять), но раньше причина оседала только в
    // ответе 422 самому агенту — если он не пересказал текст ошибки, в журнале
    // «Здоровье системы» не оставалось следа, почему конкретное голосовое не
    // ушло клиенту (24.09.2026, разбор «голосовые/расшифровка»).
    const agentName = options.sender.kind === "agent" ? options.sender.agentName : "Сотрудник";
    void logSystemError(
      isTelegram ? "telegram" : "meta",
      `Голосовое сотрудника не отправлено: не удалось расшифровать для проверки (${agentName})`
    );
    return { ok: false, status: 422, error: "Не удалось проверить голосовое (расшифровка недоступна) — попробуйте ещё раз позже" };
  }

  const guard = await checkAgentVoiceMessage(transcript);
  if (guard.blocked) {
    const agentName = options.sender.kind === "agent" ? options.sender.agentName : "Сотрудник";
    const reason = guard.reason ?? "нарушение правил переписки";
    // Пометка прямо в переписке — агент и любой, кто потом откроет диалог, видят,
    // что попытка была и почему её остановили; в клиентскую ленту это НЕ уходит,
    // клиент этого сообщения никогда не получал.
    const note = [
      {
        role: "assistant" as const,
        content: `[⛔ голосовое от ${agentName} заблокировано автоматикой: ${reason}]`,
        by: { kind: "system" as const },
      },
    ];
    if (target.kind === "bot") await appendConversationMessages(target.id, note);
    else if (isTelegram) await appendTelegramConversationMessages(target.id, note);
    void alertVoiceViolation({
      agentName,
      clientName: options.clientName,
      clientId: options.clientId,
      reason,
      transcriptExcerpt: transcript,
    });
    return { ok: false, status: 422, blocked: true, error: `Голосовое не отправлено: ${reason}. Событие ушло руководству.` };
  }

  // Расшифровка и проверка занимают секунды: за это время диалог могли забрать.
  const staleAfter = await botVoiceStaleReason(target, options.sender);
  if (staleAfter) return { ok: false, status: 409, error: staleAfter };

  // Срок по умолчанию и отправка от имени бота действующую паузу не укорачивают
  // (applyDeliveryPause); явный срок оператора ставится как есть.
  const placed = await applyDeliveryPauseUndoable(
    target,
    options.pausedUntilOverride ?? new Date(Date.now() + (await defaultPauseForSender(target, options.sender))),
    !options.pausedUntilOverride || options.sender.kind === "bot",
    options.sender
  );
  if (!placed.ok) return placed;
  const { pausedUntil, undo: pauseUndo } = placed;
  // Пауза оператора успела встать между проверкой и записью: applyDeliveryPause её
  // не укорачивает и возвращает действующую. Для бота это «пауза впереди» — не шлём.
  if (options.sender.kind === "bot" && pausedUntil.getTime() > Date.now()) {
    return { ok: false, status: 409, error: "Диалог взят оператором, голосовое бота не отправлено" };
  }

  // Instagram/Messenger отклоняют ogg/opus (Graph API HTTP 400 "This attachment
  // format is not supported") — ждут audio/mp4 (см. audioTranscode.ts). WhatsApp
  // Cloud API и Telegram, наоборот, принимают только ogg/opus. Расшифровка выше
  // всегда на ogg — это внутренний служебный файл, каналу его формат не виден.
  const isM4aChannel = metaChannel === "INSTAGRAM" || metaChannel === "FACEBOOK";
  const outBuffer = isM4aChannel ? await transcodeToM4a(audio.buffer) : ogg;
  if (!outBuffer) {
    await rollbackDeliveryPause(pauseUndo);
    return { ok: false, status: 422, error: "Не удалось обработать голосовое — попробуйте записать ещё раз или напишите текстом" };
  }

  /**
   * ЗАПИСЬ НА ДИСК — ЕДИНСТВЕННЫЙ ШАГ ПОСЛЕ ПАУЗЫ, КОТОРЫЙ УМЕЛ БРОСИТЬ.
   *
   * Вся эта функция устроена как «возвращаю отказ, а не бросаю»: у неё для того и
   * заведён `VoiceDeliveryResult`, и роут (routes/conversations.ts,
   * routes/clients/communications.ts) на этом построен — он читает `status` и
   * `error` и показывает их агенту. `saveOutgoingVoice` из этого договора выпадал:
   * кончившееся место или том только на чтение бросали наружу, роут отдавал голый
   * 500 без поля `error`, а бот к этому моменту УЖЕ поставлен на паузу запросом
   * выше — то есть замолчал из-за голосового, которое никто не отправлял (с 04.10.2026
   * такой отказ откатывает паузу, CHANNEL-NEW-08). В журнал
   * при этом не попадало ничего.
   */
  let publicPath: string;
  try {
    publicPath = await saveOutgoingVoice(outBuffer, isM4aChannel ? "m4a" : "ogg");
  } catch (err) {
    void logSystemError(
      isTelegram ? "telegram" : "meta",
      `Голосовое сотрудника не сохранено на диск: ${describeError(err)}`
    );
    await rollbackDeliveryPause(pauseUndo);
    return { ok: false, status: 503, error: "Голосовое не сохранилось на диске CRM — попробуйте ещё раз" };
  }
  const absoluteUrl = publicUploadUrl(publicPath);
  if (!absoluteUrl) {
    await rollbackDeliveryPause(pauseUndo);
    return { ok: false, status: 503, error: "Публичный адрес CRM не настроен (CRM_PUBLIC_URL) — голосовое отправить нельзя" };
  }

  // Тот же маркер, что и у текстового ответа (см. deliverToConversation) —
  // голосовое от оператора обязано уйти аккаунтом, в который писал клиент.
  // У Telegram аккаунтов нет — маркер один, из TELEGRAM_BOT_TOKEN.
  const accountToken = undefined;

  let sentMid: string | null = null;
  try {
    if (isTelegram) await sendTelegramVoice(target.subscriberId, absoluteUrl);
    else sentMid = await withManualCustomerDeliveryIntent(options.sender, () => sendMetaAudio(metaChannel!, target.subscriberId, absoluteUrl, accountToken, capturedTransport!));
  } catch (err) {
    // Закрытое окно — не поломка CRM, не логируем (см. deliverToConversation выше
    // за подробным объяснением: fbtrace_id в тексте ошибки ломает дедупликацию
    // журнала, и без этой проверки каждое закрытое окно будило бы директора).
    if (!isTelegram && err instanceof Error && isMessagingWindowClosedError(err.message)) {
      await rollbackDeliveryPause(pauseUndo);
      return {
        ok: false,
        status: 502,
        code: "window_closed",
        error:
          "Клиент не писал последние 24 часа — WhatsApp и Instagram запрещают отправлять свободные сообщения, пока он не напишет первым.",
      };
    }
    void logSystemError(isTelegram ? "telegram" : "meta", `Голосовое сотрудника не отправлено: ${describeError(err)}`);
    return { ok: false, status: 502, error: "Не удалось отправить голосовое" };
  }

  const voiceMessage = [
    {
      role: "assistant" as const,
      // Текст — расшифровка: бот, когда его вернут, должен видеть, что уже
      // проговорено, а не только пометку «[🎤]» без содержания.
      content: transcript || "[🎤 голосовое]",
      attachments: [{ kind: "audio" as const, mime: isM4aChannel ? "audio/mp4" : "audio/ogg", url: publicPath }],
      by: options.sender,
      ...(sentMid ? { mid: sentMid } : {}),
    },
  ];
  if (isTelegram) await appendTelegramConversationMessages(target.id, voiceMessage);
  else await appendConversationMessages(target.id, voiceMessage);
  void closeStaleNextActionsForTarget(target);

  // Голосовое от агента — тот же детектор и та же метка, что у текстового ответа
  // (см. deliverToConversation выше): раньше здесь не проверялось вовсе, и агент
  // мог, например, попросить номер голосом в переписке без единого следа.
  if (options.sender.kind === "agent") {
    void checkAgentPhoneAsk({
      agentId: options.sender.agentId,
      agentName: options.sender.agentName ?? "Агент",
      clientId: options.clientId,
      clientName: options.clientName,
      channel: "voice",
      text: transcript,
    }).catch((err) => console.error("[phone-ask] голосовое сообщение:", err instanceof Error ? err.message : err));
    if (options.clientId) {
      trackBackgroundTask(
        prisma.client
          .update({ where: { id: options.clientId }, data: { lastContactAt: new Date() } })
          .catch((err) => {
            if (guardBackgroundFailure("lastContactAt после голосового", err)) return;
            console.error("[переписка] lastContactAt не обновлён (голосовое):", err instanceof Error ? err.message : err);
          })
      );
      // Голосовое от агента — такая же попытка связаться, как текст (см. выше).
      // Тот же принцип, что у текста выше: засчитываем только агенту карточки.
      void markAgentAttempt(options.clientId, new Date(), options.sender.agentId);
    }
  }

  return { ok: true, pausedUntil };
}

/**
 * ГОЛОСОВОЙ ОТВЕТ БОТА В MESSENGERS/CONVERSATION.TS — ПОСЛЕДНЯЯ МИЛЯ (13.09.2026).
 *
 * finishQualifyTurn (messengers/conversation.ts) считает готовый WAV и отдаёт
 * его дальше в MessengerTurnResult.replyVoiceWav — но сама отправка текста
 * происходит НЕ в conversation.ts, а у ВЫЗЫВАЮЩЕГО (routes/webhooks.ts,
 * lib/stuckConversations.ts), и там нет под рукой id BotConversation:
 * processMessengerTurn ищет/заводит диалог внутри себя и наружу его не отдаёт.
 *
 * Эта функция — тот самый недостающий кусок: тот же (channel, subscriberId),
 * которым уже пользовался processMessengerTurn (уникальный ключ
 * BotConversation.channel_subscriberId) — и повторный upsert не нужен: диалог
 * уже точно существует, раз мы отвечаем на него текстом секундой раньше.
 *
 * ВАЖНО: `pausedUntilOverride: new Date()` — обязателен, не косметика.
 * `deliverVoiceToConversation` считает пауза (defaultPauseForSender) для
 * ЖИВОГО оператора, перехватывающего диалог у бота (agent → 10 мин или
 * бессрочно). Бот здесь отвечает САМ СЕБЕ голосом вдогонку своему же
 * текстовому ответу — без override функция поставила бы `pausedUntil` на
 * 10 минут вперёд и молча выключила бы бота из диалога до следующего
 * сообщения клиента (conversation.ts:1668, `pausedInDb`). Дата «сейчас»
 * технически «ставит» паузу, но `pausedUntil.getTime() > Date.now()` к
 * моменту проверки уже false — бот остаётся активным.
 */
export async function deliverBotVoiceReply(
  channel: string,
  subscriberId: string,
  wav: Buffer,
  clientInfo: { clientId: string | null; clientName: string | null },
  transport?: CustomerTransportHint
): Promise<void> {
  const conversation = await findScopedBotConversation(customerTransportInput(channel, subscriberId, transport));
  if (!conversation) return; // не должно происходить (см. докстринг), но не ронять звонок из-за одной строки
  const capturedTransport = await loadCustomerTransportForConversation(conversation.id);
  if (!capturedTransport) return;
  const target: DeliveryTarget = { kind: "bot", id: conversation.id, channel, subscriberId, accountId: conversation.accountId, transport: capturedTransport };
  const result = await deliverVoiceToConversation(
    target,
    { buffer: wav },
    { sender: { kind: "bot" }, clientId: clientInfo.clientId, clientName: clientInfo.clientName, pausedUntilOverride: new Date() }
  );
  if (!result.ok) {
    console.error(`[голосовой ответ] не доставлен (${channel}/${subscriberId}):`, result.error);
  }
}

/**
 * Лимиты ИСХОДЯЩЕГО фото/видео (18.08.2026, гибридный режим видео — 18.08.2026
 * вечер) — по каналу и по типу, отдельно от MAX_BYTES/MAX_MEDIA_BYTES в
 * messengers/attachments.ts: те про ВХОДЯЩИЕ вложения от клиента и их трогать
 * нельзя. Цифры — реальные пределы Graph API: WhatsApp отдельно режет фото (5 МБ)
 * и видео (16 МБ), Instagram и Messenger — общий предел 25 МБ на любое вложение.
 *
 * ФОТО: как и раньше, это жёсткий потолок — файл больше лимита ОТКЛОНЯЕТСЯ
 * (сжимать фото для отправки не наш случай, размер обычно и так укладывается).
 *
 * ВИДЕО: с этой правки лимит больше не причина отказа — он решает только
 * «отправить файлом через Graph API или ссылкой на R2» (владелец 18.08.2026:
 * ролик объекта в исходном качестве может весить 100-300 МБ, а перекодирование
 * ради лимита Meta отклонено — теряет качество). См. deliverMediaToConversation.
 */
const OUTGOING_MEDIA_LIMITS: Record<MetaChannel, { image: number; video: number }> = {
  WHATSAPP: { image: 5 * 1024 * 1024, video: 16 * 1024 * 1024 },
  INSTAGRAM: { image: 25 * 1024 * 1024, video: 25 * 1024 * 1024 },
  FACEBOOK: { image: 25 * 1024 * 1024, video: 25 * 1024 * 1024 },
};
/**
 * Тот же лимит, что и у getFile (telegram/api.ts::TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES,
 * «сколько бот может скачать») — здесь Telegram точно так же сам скачивает файл
 * по presigned-ссылке, разница только в направлении (мы отдаём, а не забираем).
 * Раньше здесь стояла отдельная захардкоженная константа 16 МБ (реальный,
 * не документированный жёстко предел облачного Bot API при sendPhoto/sendVideo
 * по URL) — забыли поднять вместе с переездом на свой Bot API сервер (найдено
 * 19.09.2026, тот же класс дыры — lib/socialPublish.ts::publishTelegramVideo):
 * оператор не мог отправить клиенту видео крупнее 16 МБ через Telegram, хотя
 * сервер давно тянет до 2 ГБ.
 */

function humanMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} МБ`;
}

export type MediaDeliveryResult =
  | { ok: true; pausedUntil: Date }
  | { ok: false; status: number; error: string; code?: "window_closed" };

/**
 * Отправка ФОТО/ВИДЕО сотрудника клиенту (18.08.2026, тот же запрос владельца,
 * что и голосовые: «нужно уметь скинуть фото объекта прямо из инбокса», без
 * обходного пути через карточку объекта).
 *
 * Только каналы Meta — та же причина, что и у deliverVoiceToConversation:
 * своей отправки медиа у Telegram-бота в этой CRM нет.
 *
 * Порядок шагов:
 *  1. отклонить Telegram и незнакомый mime сразу — до всякой записи на диск;
 *  2. ФОТО больше канального лимита — отказ (см. OUTGOING_MEDIA_LIMITS). ВИДЕО
 *     больше лимита канала (18.08.2026, гибридный режим) — НЕ отказ: файл всё
 *     равно уходит в R2, а клиенту вместо самого файла (Graph API его бы не
 *     принял) уходит текстовое сообщение со ссылкой на просмотр;
 *  3. пауза бота — ДО отправки, как и у текста/голоса (см. deliverToConversation);
 *  4. загрузить в Cloudflare R2 (владелец 18.08.2026: «не на локальном диске, чтобы
 *     не забивать место на сервере» — тот же бакет/клиент, что и у видео-галереи
 *     объекта, см. lib/r2Client.ts);
 *  5а. файл уложился в лимит канала — отправить Meta presigned-ссылку, Meta
 *      забирает файл своими серверами сразу после ответа send-запроса, 600 секунд
 *      жизни ссылки (см. r2PresignDownloadUrl) с большим запасом хватает;
 *  5б. видео больше лимита — отправить ОБЫЧНЫМ текстом ссылку на наш стабильный
 *      маршрут (routes/mediaProxy.ts), который подписывает R2-ключ заново при
 *      каждом открытии — presigned-ссылка сюда не годится, истечёт за 10 минут;
 *  Отказ на шаге 4/5, когда клиенту заведомо ничего не ушло (R2 не принял файл,
 *  закрытое окно), откатывает паузу (CHANNEL-NEW-08, 04.10.2026). Сбой транспорта с
 *  неизвестным исходом паузу оставляет: лучше бот помолчит лишнее, чем ответит
 *  поверх попытки оператора, которая могла дойти.
 *  6. запись в историю — в `attachments[].url` в обоих случаях кладём НЕ
 *     presigned-ссылку, а стабильный путь через routes/mediaProxy.ts — с тем же
 *     mid-приёмом, что у текста и голоса.
 */
export async function deliverMediaToConversation(
  target: DeliveryTarget,
  /** Байты в памяти — или файл на диске (загрузка из переписки до 300 МБ): его
   *  в память целиком не читаем, он уходит в R2 частями (аудит 23.09.2026, №74). */
  media: { mimetype: string; originalname?: string } & ({ buffer: Buffer } | { path: string; size: number }),
  options: {
    pausedUntilOverride?: Date;
    sender: MessageSender;
    caption?: string;
  }
): Promise<MediaDeliveryResult> {
  const isTelegram = target.kind === "telegram";
  const capturedTransport = await captureDeliveryTransport(target);
  if (!isTelegram && target.channel !== WEBSITE_CHANNEL && !capturedTransport) return TRANSPORT_CHANGED;
  const isWebsite = !isTelegram && target.channel === WEBSITE_CHANNEL;
  // Та же честная причина, что у голосовых выше: канал сайта работает, файлы
  // в веб-чат просто пока не доставляются, ключи Meta тут ни при чём.
  if (isWebsite) {
    return { ok: false, status: 422, error: "Чат на сайте пока не умеет отправлять файлы и голосовые, отправьте текстом" };
  }
  const metaChannel = isTelegram ? null : asMetaChannel(target.channel);
  if (isTelegram ? !isTelegramEnabled() : !metaChannel || !(await isMetaChannelEnabled(metaChannel))) {
    return {
      ok: false,
      status: 503,
      error: isTelegram
        ? "Отправка не настроена (TELEGRAM_BOT_TOKEN)"
        : `Ответ в ${target.channel} не отправить: канал выключен или не заданы ключи в Настройках → Meta.`,
    };
  }

  const isImage = media.mimetype.startsWith("image/");
  const isVideo = media.mimetype.startsWith("video/");
  if (!isImage && !isVideo) {
    return { ok: false, status: 400, error: "Допустимы только изображения или видео" };
  }
  // SVG — это исполняемый документ (скрипты внутри), а не фотография: заявленный
  // клиентом Content-Type сохраняется как есть и отдаётся при раздаче через
  // mediaProxy, то есть пропущенный svg открывался бы в браузере с исполнением.
  // Фото из мессенджеров всегда растровые — честному сценарию запрет не мешает.
  if (/svg/i.test(media.mimetype)) {
    return { ok: false, status: 400, error: "SVG не поддерживается — отправьте фото (JPG/PNG/WebP)" };
  }

  const limit = isTelegram ? TELEGRAM_BOT_DOWNLOAD_LIMIT_BYTES : OUTGOING_MEDIA_LIMITS[metaChannel!][isImage ? "image" : "video"];
  const size = "buffer" in media ? media.buffer.length : media.size;
  const overLimit = size > limit;
  // ФОТО больше лимита — отказ, как и раньше. ВИДЕО больше лимита — не отказ,
  // а отправка ссылкой вместо файла (см. блок-комментарий функции). Telegram
  // получает файл по ссылке в любом случае (см. ниже), поэтому «отправка
  // ссылкой вместо файла» ему не нужна — но фото больше предела всё равно
  // отклоняем: sendPhoto с гигантским файлом Telegram сам не примет.
  if (isImage && overLimit) {
    return {
      ok: false,
      status: 400,
      error: `Файл слишком большой: для фото в ${isTelegram ? "Telegram" : metaChannel} предел ${humanMb(limit)}`,
    };
  }
  const sendAsLink = !isTelegram && isVideo && overLimit;

  if (!isR2Configured()) {
    return { ok: false, status: 503, error: "Хранилище файлов (R2) не настроено — фото/видео отправить нельзя" };
  }
  // Ссылка на большое видео обязана быть доступна КЛИЕНТУ снаружи — без адреса
  // CRM отправить её нечем (в отличие от файла в лимите: там Meta ходит напрямую
  // на R2 по presigned-ссылке, наш публичный адрес ей не нужен).
  if (sendAsLink && !crmPublicBase()) {
    return { ok: false, status: 503, error: "Публичный адрес CRM не настроен (CRM_PUBLIC_URL) — большое видео отправить нельзя" };
  }
  if (isTelegram && isVideo && overLimit) {
    return { ok: false, status: 400, error: `Файл слишком большой: для видео в Telegram предел ${humanMb(limit)}` };
  }

  // Срок по умолчанию и отправка от имени бота действующую паузу не укорачивают
  // (applyDeliveryPause); явный срок оператора ставится как есть.
  const placed = await applyDeliveryPauseUndoable(
    target,
    options.pausedUntilOverride ?? new Date(Date.now() + (await defaultPauseForSender(target, options.sender))),
    !options.pausedUntilOverride || options.sender.kind === "bot",
    options.sender
  );
  if (!placed.ok) return placed;
  const { pausedUntil, undo: pauseUndo } = placed;

  const ext = (media.mimetype.split("/")[1] || (isImage ? "jpg" : "mp4")).split(";")[0];
  let r2Key: string;
  // И Meta (в лимите), и Telegram забирают файл сами по presigned-ссылке —
  // она публична и временна (600 секунд), «наш» публичный адрес CRM тут не нужен.
  let presignedUrl: string | null = null;
  try {
    r2Key = await uploadOutgoingMedia(
      target.id,
      "buffer" in media ? media.buffer : { path: media.path, size: media.size },
      ext,
      media.mimetype
    );
    if (!sendAsLink) presignedUrl = await r2PresignDownloadUrl(r2Key);
  } catch (err) {
    void logSystemError("storage", `Фото/видео сотрудника не загружено в R2: ${describeError(err)}`);
    await rollbackDeliveryPause(pauseUndo);
    return { ok: false, status: 502, error: "Не удалось сохранить файл — попробуйте ещё раз" };
  }
  if (!sendAsLink && !presignedUrl) {
    await rollbackDeliveryPause(pauseUndo);
    return { ok: false, status: 503, error: "Хранилище файлов (R2) недоступно — файл отправить нельзя" };
  }

  // Стабильный путь для истории переписки — НЕ presigned-ссылка (та истекает за 10
  // минут). Маршрут mediaProxy.ts подписывает ключ заново при каждом открытии.
  const mediaProxyPath = `/api/v1/media/chat/${encodeURIComponent(target.id)}/${r2Key.split("/").pop()}`;

  // Тот же маркер, что у текста и голоса — вложение обязано уйти аккаунтом, в
  // который писал клиент (messengers/accounts.ts). У Telegram аккаунтов нет.
  const accountToken = undefined;

  const { text: caption, masked: _masked } = options.caption ? maskPhones(options.caption) : { text: "", masked: false };

  let sentMid: string | null = null;
  let historyContent: string;
  try {
    if (isTelegram) {
      historyContent = caption || (isImage ? "[📷 фото]" : "[🎥 видео]");
      if (isImage) await sendTelegramPhoto(target.subscriberId, presignedUrl!, caption || undefined);
      else await sendTelegramVideo(target.subscriberId, presignedUrl!, caption || undefined);
    } else if (sendAsLink) {
      // Видео больше лимита канала: Graph API его бы отклонил файлом, поэтому
      // клиенту уходит обычное текстовое сообщение со ссылкой на просмотр.
      const link = `${crmPublicBase()}${mediaProxyPath}`;
      historyContent = `${caption ? `${caption}\n` : ""}Видео объекта: ${link}`;
      // Фото/видео из CRM грузит живой сотрудник — для щита это рука, а не бот.
      sentMid = await withManualCustomerDeliveryIntent(options.sender, () => sendMetaMessage(metaChannel!, target.subscriberId, historyContent, accountToken, {
        origin: "staff",
        transport: capturedTransport!,
      }));
    } else {
      historyContent = caption || (isImage ? "[📷 фото]" : "[🎥 видео]");
      sentMid = isImage
        ? await withManualCustomerDeliveryIntent(options.sender, () => sendMetaImage(metaChannel!, target.subscriberId, presignedUrl!, accountToken, capturedTransport!))
        : await withManualCustomerDeliveryIntent(options.sender, () => sendMetaVideo(metaChannel!, target.subscriberId, presignedUrl!, accountToken, capturedTransport!));
    }
  } catch (err) {
    // Закрытое окно — не поломка CRM, не логируем (см. deliverToConversation выше
    // за подробным объяснением: fbtrace_id в тексте ошибки ломает дедупликацию
    // журнала, и без этой проверки каждое закрытое окно будило бы директора).
    if (!isTelegram && err instanceof Error && isMessagingWindowClosedError(err.message)) {
      await rollbackDeliveryPause(pauseUndo);
      return {
        ok: false,
        status: 502,
        code: "window_closed",
        error:
          "Клиент не писал последние 24 часа — WhatsApp и Instagram запрещают отправлять свободные сообщения, пока он не напишет первым.",
      };
    }
    void logSystemError(isTelegram ? "telegram" : "meta", `${isImage ? "Фото" : "Видео"} сотрудника не отправлено: ${describeError(err)}`);
    return { ok: false, status: 502, error: `Не удалось отправить ${isImage ? "фото" : "видео"}` };
  }

  const message = [
    {
      role: "assistant" as const,
      content: historyContent,
      attachments: [{ kind: (isImage ? "image" : "video") as "image" | "video", mime: media.mimetype, url: mediaProxyPath }],
      by: options.sender,
      ...(sentMid ? { mid: sentMid } : {}),
    },
  ];
  if (isTelegram) await appendTelegramConversationMessages(target.id, message);
  else await appendConversationMessages(target.id, message);
  void closeStaleNextActionsForTarget(target);

  return { ok: true, pausedUntil };
}

/**
 * Последняя реплика ИМЕННО БОТА — то, на что оператор сейчас возразит своим ответом.
 *
 * Ручной ответ агента тоже хранится как role=assistant (leadQualifier.ts об этом
 * прямо пишет), и до 26.08.2026 два сообщения агента подряд рождали ЛОЖНЫЙ урок:
 * второй вызов записывал в BotLesson «репликой бота» предыдущее сообщение самого
 * агента, а ночной разбор выводил правило из несуществующей ошибки бота. Учимся
 * только когда последний assistant — реально бот (by отсутствует или kind=bot).
 */
async function lastAssistantMessage(target: DeliveryTarget): Promise<string | null> {
  try {
    const row =
      target.kind === "telegram"
        ? await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { messages: true } })
        : await prisma.botConversation.findUnique({ where: { id: target.id }, select: { messages: true } });
    const messages = (Array.isArray(row?.messages) ? row.messages : []) as {
      role?: string;
      content?: string;
      by?: { kind?: string };
    }[];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "assistant") continue;
      const byKind = messages[i]?.by?.kind;
      // Человеческая реплика (agent/manual) — урока нет: бот тут ни при чём.
      if (byKind && byKind !== "bot" && byKind !== "system") return null;
      return messages[i].content ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Последняя реплика КЛИЕНТА — по ней определяется язык, на котором ему писать
 * (см. lib/propertyOfferText.ts). Того же источника держится и бот: язык считается
 * по последнему сообщению человека, а не по карточке.
 */
export async function lastClientMessage(target: DeliveryTarget): Promise<string | null> {
  return lastMessageOfRole(target, "user");
}

/**
 * ОБРАЗЕЦ МАНЕРЫ ИЗ РУЧНОГО ОТВЕТА (22.08.2026, просьба владельца «чтобы бот умнел
 * с каждой перепиской», как в боте Ширин Свитс).
 *
 * Точка врезки та же, что у detectOperatorShowingAgreement: ручной ответ уже ушёл
 * клиенту. Отбор тоже тот же — учимся только у ЖИВОГО человека:
 *  - "agent" — сотрудник ответил из CRM, знаем кто именно;
 *  - "manual" — ответили руками из самого мессенджера, автор неизвестен (Meta
 *    называет только аккаунт страницы), но манера всё равно человеческая;
 *  - "bot"/"system"/подпись не задана — это сам бот или служебная рассылка CRM
 *    (напоминание о показе, пересланный ответ собственника). Учиться на своих же
 *    словах бессмысленно, а на шаблоне рассылки — вредно.
 *
 * Вопрос клиента берётся ИЗ ИСТОРИИ, а не передаётся аргументом: ответ агента уже
 * дописан выше, но он `assistant`, и последняя реплика `user` — по-прежнему та, на
 * которую сотрудник отвечал.
 *
 * Телефоны из пары вычищает сам styleLearning (sanitizeStyleText) — образец уходит
 * в промт ЧУЖИХ разговоров, и чужому номеру там не место.
 */
async function rememberAgentStyleExample(
  target: DeliveryTarget,
  agentText: string,
  sender?: MessageSender
): Promise<void> {
  if (!sender || (sender.kind !== "agent" && sender.kind !== "manual")) return;
  await rememberAgentReply({
    clientText: (await lastClientMessage(target)) ?? "",
    agentText,
    agentId: sender.kind === "agent" ? sender.agentId : null,
    source: "TAKEOVER",
    channel: target.kind === "telegram" ? "TELEGRAM" : target.channel,
  });
}

/**
 * Когда клиент последний раз писал в этот диалог — по отметке `at` его реплик.
 * Нужна правилу окна Meta (lib/messagingWindow.ts::isMessagingWindowOpen):
 * агент видит «уйдёт / не уйдёт» до нажатия. Отказ базы — null, как у соседей.
 */
export async function lastClientMessageAt(target: DeliveryTarget): Promise<Date | null> {
  try {
    const row =
      target.kind === "telegram"
        ? await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { messages: true } })
        : await prisma.botConversation.findUnique({ where: { id: target.id }, select: { messages: true } });
    const messages = (Array.isArray(row?.messages) ? row.messages : []) as { role?: string; at?: string }[];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role !== "user") continue;
      const at = messages[i]?.at ? new Date(messages[i].at!) : null;
      return at && !Number.isNaN(at.getTime()) ? at : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Общий обход истории с конца. Отказ базы — это `null`: и подсказка про язык, и
 *  обучение на паре реплик обязаны молча уступить самой отправке. */
async function lastMessageOfRole(target: DeliveryTarget, role: "user" | "assistant"): Promise<string | null> {
  try {
    const row =
      target.kind === "telegram"
        ? await prisma.telegramConversation.findUnique({ where: { id: target.id }, select: { messages: true } })
        : await prisma.botConversation.findUnique({ where: { id: target.id }, select: { messages: true } });
    const messages = (Array.isArray(row?.messages) ? row.messages : []) as { role?: string; content?: string }[];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === role) return messages[i].content ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Подпись отправителя для человека, инициировавшего отправку.
 *
 * Имя читается заново на каждый вызов, а не берётся из req.agent (там его нет —
 * middleware несёт только права), но и не кэшируется: реплика, ушедшая клиенту,
 * должна нести то имя, что было в момент отправки, а не то, что стоит в базе
 * сейчас — если агента потом переименуют, старые подписи не обязаны съезжать.
 */
export async function agentSender(agentId: string): Promise<MessageSender> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
  return { kind: "agent", agentId, agentName: agent?.fullName ?? "Сотрудник" };
}

/** Диалог клиента для отправки из его карточки. Telegram берём вторым: канал бота —
 *  основной для входящих, и если клиент писал в оба, отвечать логичнее туда же. */
export async function findClientDeliveryTarget(clientId: string): Promise<DeliveryTarget | null> {
  const [bot, telegram] = await Promise.all([
    // findFirst, не findUnique (19.08.2026) — у клиента может быть несколько
    // диалогов бот-платформы; отвечаем в тот, где переписка активнее всего сейчас.
    //
    // client: { deletedAt: null } (27.08.2026) — карточка могла уехать в Корзину
    // между тем, как повод для сообщения появился (вопрос собственнику, показ),
    // и тем, как этот повод сработал: бот писал удалённому человеку «ещё уточняю
    // у собственника, скоро вернусь» — обещание, за которым уже некому следить.
    // Единая точка, а не правка на каждом вызывающем: их несколько (crons,
    // напоминания о показах, ответы собственника), и разошлись бы по одному.
    // nulls: "last" (28.09.2026): у Postgres DESC ставит NULL ПЕРВЫМ, а
    // диалог, заведённый «Написать в WhatsApp первыми», живёт без
    // lastMessageAt, пока клиент не ответит. Такой пустой диалог забирал себе
    // любую отправку из карточки — и Meta отказывала по окну 24 часов, хотя
    // клиент писал в Instagram час назад. Жалоба владельца: «агенты не могут
    // отправлять объекты, такая проблема была и не решена».
    prisma.botConversation.findFirst({
      where: { clientId, client: { deletedAt: null } },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      select: { id: true, channel: true, subscriberId: true, accountId: true },
    }),
    // У Telegram адрес получателя — chatId (в едином инбоксе он и подставляется
    // как subscriberId, см. fromTelegram в routes/conversations.ts).
    prisma.telegramConversation.findFirst({
      where: { clientId, client: { deletedAt: null } },
      select: { id: true, chatId: true },
    }),
  ]);
  if (bot) {
    const transport = await loadCustomerTransportForConversation(bot.id);
    if (bot.channel === WEBSITE_CHANNEL || transport) return {
      kind: "bot", id: bot.id, channel: bot.channel, subscriberId: bot.subscriberId,
      accountId: bot.accountId, ...(transport ? { transport } : {}),
    };
  }
  if (telegram) return { kind: "telegram", id: telegram.id, subscriberId: telegram.chatId };
  return null;
}

/**
 * Диалог, КУДА отправлять (28.09.2026). Из чата — именно тот, что открыт у
 * агента (id инбокса: `<uuid>` или `tg_<uuid>`), и только если он этого
 * клиента. Без id — самый живой диалог клиента (findClientDeliveryTarget).
 * `undefined` — переданный id чужой или не существует: это ошибка интерфейса,
 * а не «клиент не писал», и молча слать в другой диалог нельзя.
 */
export async function resolveSendTarget(clientId: string, inboxId?: string): Promise<DeliveryTarget | null | undefined> {
  if (!inboxId) return findClientDeliveryTarget(clientId);
  if (inboxId.startsWith(TG_PREFIX)) {
    const tg = await prisma.telegramConversation.findFirst({
      where: { id: inboxId.slice(TG_PREFIX.length), clientId },
      select: { id: true, chatId: true },
    });
    return tg ? { kind: "telegram", id: tg.id, subscriberId: tg.chatId } : undefined;
  }
  const bot = await prisma.botConversation.findFirst({
    where: { id: inboxId, clientId },
    select: { id: true, channel: true, subscriberId: true, accountId: true },
  });
  if (!bot) return undefined;
  const transport = await loadCustomerTransportForConversation(bot.id);
  if (bot.channel !== WEBSITE_CHANNEL && !transport) return undefined;
  return { kind: "bot", id: bot.id, channel: bot.channel, subscriberId: bot.subscriberId,
    accountId: bot.accountId, ...(transport ? { transport } : {}) };
}

/**
 * Та же логика, но для целого списка клиентов двумя запросами вместо двух на
 * каждого: findClientDeliveryTarget в цикле по напоминаниям о показах (до 100
 * штук за тик, каждый тик — 5 минут) держал до 200 обращений к базе подряд.
 */
export async function findClientDeliveryTargets(clientIds: string[]): Promise<Map<string, DeliveryTarget>> {
  const result = new Map<string, DeliveryTarget>();
  if (clientIds.length === 0) return result;

  const [bots, telegrams] = await Promise.all([
    // client: { deletedAt: null } — тот же фильтр, что и в findClientDeliveryTarget
    // выше и по той же причине.
    // Тот же порядок, что у одиночной версии: самый живой диалог первым,
    // пустые (lastMessageAt = NULL) в конце — иначе из нескольких диалогов
    // клиента побеждал случайный, в том числе ещё безответный.
    prisma.botConversation.findMany({
      where: { clientId: { in: clientIds }, client: { deletedAt: null } },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      select: { id: true, clientId: true, channel: true, subscriberId: true, accountId: true },
    }),
    prisma.telegramConversation.findMany({
      where: { clientId: { in: clientIds }, client: { deletedAt: null } },
      select: { id: true, clientId: true, chatId: true },
    }),
  ]);
  // Telegram сначала, бот — следом и перезаписывает: тот же приоритет, что и
  // у одиночной версии (канал бота основной, если писал в оба).
  for (const t of telegrams) {
    if (t.clientId) result.set(t.clientId, { kind: "telegram", id: t.id, subscriberId: t.chatId });
  }
  const botChosen = new Set<string>();
  for (const b of bots) {
    if (!b.clientId || botChosen.has(b.clientId)) continue;
    const transport = await loadCustomerTransportForConversation(b.id);
    if (b.channel !== WEBSITE_CHANNEL && !transport) continue;
    botChosen.add(b.clientId);
    result.set(b.clientId, { kind: "bot", id: b.id, channel: b.channel, subscriberId: b.subscriberId,
      accountId: b.accountId, ...(transport ? { transport } : {}) });
  }
  return result;
}

/**
 * РЕАЛЬНЫЙ КОНТАКТ АГЕНТА — ЕДИНСТВЕННОЕ, ЧТО ГАСИТ БОТА (решение владельца
 * 18.09.2026, отмена решения 05.09.2026 «hasActiveAssignedAgent»). Раньше бот
 * замолкал уже в момент НАЗНАЧЕНИЯ агента — тем же ходом, что и приём заявки, —
 * не дожидаясь, пока агент реально поговорит с клиентом. На практике это
 * убивало механику «спроси имя/доп. номер следующим ходом» (19.08.2026):
 * ответ клиента на прямой вопрос бота улетал в тишину, а не агенту, потому что
 * агент уже формально назначен, хоть ещё не звонил и не писал.
 *
 * Теперь бот ведёт разговор полноценно (как до приёма заявки — квалификатор,
 * ответы на вопросы, а не одна каноническая фраза), пока не случится ОДНО из
 * двух: (1) агент ответил вручную в переписке — это уже отслеживается через
 * `defaultPauseForSender`/`deliverToConversation` выше и `handleOutgoingEcho`
 * (routes/webhooks.ts), отдельного кода не требует; (2) агент СОСТОЯЛСЯ
 * созвонился с клиентом (`Interaction.callAttempt === "TALKED"`,
 * lib/telephony/callTracker.ts::finishCall) — вот для этого случая и нужна
 * эта функция: она ставит клиенту ТУ ЖЕ «бессрочную» паузу, что и ручной
 * ответ его закреплённого агента в CRM, тем же полем и той же константой
 * (`OPERATOR_REPLY_PAUSE_MS`), а не изобретает второй параллельный механизм.
 *
 * Ставим паузу ВСЕМ диалогам клиента (бот-платформа И Telegram, а не только
 * «основному» по `findClientDeliveryTarget`) — раз человек уже поговорил с
 * агентом голосом, продолжать вести с ним переписку в ЛЮБОМ канале не за чем.
 * Сообщения не отправляем (в отличие от `deliverToConversation`) — тут не
 * ответ клиенту, а факт «разговор состоялся», зафиксированный после звонка.
 */
export async function pauseConversationsAfterRealContact(clientId: string): Promise<void> {
  const pausedUntil = new Date(Date.now() + OPERATOR_REPLY_PAUSE_MS);
  const botPausedAt = new Date();
  // $transaction, а не Promise.all (22.09.2026): три записи задают ОДНО состояние
  // «агент уже поговорил с человеком». Порознь перезапуск процесса посередине
  // оставлял бота писать клиенту в том канале, до которого запись не дошла,
  // поверх живого разговора — это видно клиенту напрямую.
  await prisma.$transaction([
    prisma.botConversation.updateMany({ where: { clientId }, data: { pausedUntil, botPausedAt } }),
    prisma.telegramConversation.updateMany({ where: { clientId }, data: { pausedUntil, botPausedAt } }),
    // Реальный контакт — тот самый ответ на просьбу «дайте живого агента»
    // (см. Client.agentAttentionRequestedAt, messengers/conversation.ts):
    // раз агент дозвонился, список сообщений может перестать держать карточку
    // первой и красной. updateMany, а не update: у большинства клиентов метка
    // и так null, лишний findUnique ради условного update не нужен.
    prisma.client.updateMany({ where: { id: clientId }, data: { agentAttentionRequestedAt: null } }),
  ]);
}
