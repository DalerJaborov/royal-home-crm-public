import { asMetaChannel, isMetaChannelEnabled, sendMessage as sendMetaMessage } from "./meta.js";
import { asBotChannel, loadBotChannelToggles } from "./botChannels.js";
import { WEBSITE_CHANNEL } from "./channels.js";
import { isMessagingWindowClosedError } from "../lib/messagingWindow.js";
import { admitOutbound, isOutboundBlockedError } from "../lib/outboundShield.js";

/**
 * Отправка в тот канал, откуда клиент писал.
 *
 * Раньше жила только внутри cron.ts (напоминания молчащим), но нужна везде, откуда
 * бот пишет клиенту НЕ в ответ на вебхук в реальном времени — например, фоновый
 * повтор хода после того, как ИИ был занят (см. ai/aiRetryQueue.ts).
 */
/**
 * @returns отправлено ли сообщение. `false` — бот в этом канале выключен, и это
 * не ошибка: вызывающему нечего чинить, повторять тоже нечего.
 *
 * mid отправленного сообщения отдаётся отдельной функцией sendBotMessageWithMid
 * (ниже): вызывающему, который пишет реплику в историю, он нужен, чтобы эхо Meta
 * потом опознавалось как наше (аудит №4 — иначе напоминание, отправленное
 * worker'ом, приходило в api эхом и сходило за ручной ответ сотрудника).
 */
export async function sendBotMessage(
  channel: string,
  subscriberId: string,
  text: string,
  /** Маркер аккаунта, которому принадлежит диалог (messengers/accounts.ts). Не задан —
   *  маркер по умолчанию, то есть поведение до появления второго аккаунта. */
  accountToken?: string
): Promise<boolean> {
  return (await sendBotMessageWithMid(channel, subscriberId, text, accountToken)).sent;
}

/** То же самое, но с mid отправленного сообщения — для тех, кто пишет реплику в
 *  историю диалога (mid там опознаёт наше эхо). */
export async function sendBotMessageWithMid(
  channel: string,
  subscriberId: string,
  text: string,
  accountToken?: string
): Promise<{ sent: boolean; mid: string | null }> {
  /**
   * РУБИЛЬНИК БОТА ПРОВЕРЯЕТСЯ ЗДЕСЬ, А НЕ ТОЛЬКО У ВЫЗЫВАЮЩИХ.
   *
   * Раньше проверялся только `isMetaChannelEnabled` — а это совсем другой вопрос:
   * «канал подключён» (ключи, вебхуки, metaEnabled), а не «боту разрешено
   * говорить». Владелец мог выключить бота в Настройках, а ход, уже стоявший в
   * очереди повторов (ai/aiRetryQueue.ts пробует до четырёх часов), через
   * двадцать минут успешно получал ответ модели и уходил клиенту. Рубильник, до
   * которого дотягивается не всё, хуже отсутствующего: им пользуются, когда бот
   * ведёт себя плохо, и именно тогда он и обязан работать.
   *
   * В cron.ts та же проверка есть на своём месте (напоминания идут пачкой по 200
   * диалогов, и читать настройки на каждый — N+1), поэтому здесь она повторная и
   * дешёвая: один запрос на одно сообщение, отправляемое живому человеку.
   */
  const botChannel = asBotChannel(channel);
  if (botChannel) {
    const toggles = await loadBotChannelToggles();
    if (!toggles.channels[botChannel]) return { sent: false, mid: null };
  }

  /**
   * ЧАТ НА САЙТЕ: «отправка» — это запись в переписку, сети здесь нет (23.08.2026).
   *
   * Посетитель забирает новые реплики сам (см. messengers/websiteChat.ts), поэтому
   * успехом считается сам факт, что сообщение легло в диалог, — его пишет
   * вызывающий, как и для остальных каналов. Без этой ветки любое служебное
   * сообщение в веб-диалог (например, напоминание замолчавшему клиенту) падало бы
   * с «канал выключен — отправить некуда», хотя канал в полном порядке.
   */
  if (channel === WEBSITE_CHANNEL) {
    /**
     * ЩИТ И ЗДЕСЬ (17.09.2026). Сети нет, но человек на другом конце есть: он
     * заберёт реплику опросом и увидит её ровно так же, как в мессенджере.
     * Единственный путь бота, который транспорт не прикрывает, — значит,
     * проверка стоит явно, иначе в чате на сайте петля была бы разрешена.
     */
    const verdict = await admitOutbound({ channel, subscriberId, text });
    if (!verdict.allowed) {
      console.warn(`[щит] ${channel} → ${subscriberId}: ${verdict.reasonText}`);
      return { sent: false, mid: null };
    }
    return { sent: true, mid: null };
  }

  const metaChannel = asMetaChannel(channel);
  if (metaChannel && (await isMetaChannelEnabled(metaChannel))) {
    try {
      const mid = await sendMetaMessage(metaChannel, subscriberId, text, accountToken);
      return { sent: true, mid };
    } catch (err) {
      /**
       * ЗАКРЫТОЕ ОКНО — НЕ ПОЛОМКА, А ШТАТНЫЙ ОТКАЗ ПЛАТФОРМЫ (12.09.2026).
       *
       * Интерактивная доставка (lib/conversationDelivery.ts) окно распознаёт и
       * объясняет агенту, а этот, фоновый, путь — нет: он бросал общее исключение,
       * и у всех вызывающих (напоминания молчащим в cron.ts, повтор хода после
       * занятого ИИ, запрос номера в askCandidatePhone.ts) оно тонуло в
       * `catch → console.error` наравне с настоящими сбоями. В журнале это
       * выглядело как ошибка отправки, хотя чинить нечего: человек просто не
       * писал сутки.
       *
       * Возвращаем «не отправлено» — ровно тот же ответ, что и при выключенном
       * канале. Вызывающие уже умеют его обрабатывать (в cron.ts `continue`,
       * без записи реплики в историю), и повторять тем же текстом бессмысленно:
       * окно откроется только когда напишет сам клиент.
       */
      /**
       * ЩИТ НЕ ВЫПУСТИЛ — ТОЖЕ ШТАТНЫЙ ОТКАЗ, А НЕ ПОЛОМКА (17.09.2026).
       *
       * Ответ тот же, что у выключенного канала и закрытого окна: «не
       * отправлено». Это важно ровно одним: вызывающие (напоминания в cron.ts,
       * просьба о номере в askCandidatePhone.ts) на `sent: false` НЕ пишут
       * реплику в историю переписки — а значит, заблокированное сообщение не
       * превратится в запись, которой человек никогда не видел, и следующий
       * крон не станет на неё отвечать. Ровно этим и была петля 17.09.
       */
      if (isOutboundBlockedError(err)) return { sent: false, mid: null };
      const message = err instanceof Error ? err.message : String(err);
      if (isMessagingWindowClosedError(message)) {
        console.log(
          `[окно] ${channel}: клиент ${subscriberId} не писал больше суток — фоновое сообщение не отправлено`
        );
        return { sent: false, mid: null };
      }
      throw err;
    }
  }
  throw new Error(`Канал ${channel} выключен — сообщение отправить некуда`);
}
