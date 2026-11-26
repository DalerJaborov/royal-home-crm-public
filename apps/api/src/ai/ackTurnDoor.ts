/**
 * ОДНА ДВЕРЬ «ОК / СПАСИБО / ПОКА → РЕАКЦИЯ, А НЕ ТЕКСТ» (владелец 26.11.2026).
 *
 * Живой случай (Instagram, ядро, режим «только заявки»): бот: «Спасибо, номер получил, агент вам позвонит.»,
 * клиент: «Ок», бот: «Ваша заявка у агента, он с вами свяжется.» — фразу lead_reminder выбрал оператор приёма
 * заявок, потому что ход дошёл до него. Старый путь (messengers/conversation.ts) и Telegram останавливали такой ход
 * кодом, а ядро (lib/customerDmAgentTurn.ts) и временный узкий путь (messengers/customerQualifierTurn.ts) — нет.
 *
 * Решение принимает КОД, до модели и до оператора, здесь и только здесь. Все пути хода клиента зовут эту функцию:
 *  - старый путь Meta — messengers/conversation.ts (до режима «только заявки» и до модели);
 *  - ядро — lib/customerDmAgentTurn.ts (до разбора вложений, оператора и модели);
 *  - узкий путь — messengers/customerQualifierTurn.ts;
 *  - Telegram и Direct Messages — через messengers/silentTurn.ts::silentTurnReason.
 * Сторож: tests/ack-reaction-door-26-11.test.ts (таблица фраз и порядок вызова в каждом пути).
 *
 * Ответ «да» — реакция (сердечко в Instagram/Messenger, ❤️ в WhatsApp, 👍 в Telegram); не вышло — тишина.
 * Реплика клиента к этому моменту уже в переписке: агент её видит, заявка не теряется.
 *
 * Правило:
 *  - вложение (фото, голос, файл) — никогда не «ок»: это содержание;
 *  - бот ещё ничего не говорил — обычный ход (поздороваться);
 *  - сообщение целиком из вежливости, согласия, прощания (ai/ackOnly.ts: без цифр, без вопроса, без нового содержания);
 *  - бот ждал ответа («?», предложение «Если хотите…», просьба номера) — «ок/да/хорошо» это ответ, обычный ход;
 *    прощание («Пока», «Спасибо, до свидания», «Рахмат, худо ҳофиз») ответом не бывает — реакция и тогда; голое «Спасибо»
 *    на предложение звонка — согласие (заявка), обычный ход; в разговоре о вакансии — реакция.
 */
import { botAwaitsAnswer, isAckOnlyMessage, isFarewellClosingMessage, isThanksOnlyMessage, isWaitOnlyMessage } from "./ackOnly.js";

export type AckReactionTurnInput = {
  /** Слова клиента этого хода (склеенная пачка, вместе с отложенными сообщениями). */
  text: string;
  /** В ходе было вложение — тогда это не «ок». */
  hasMedia: boolean;
  /** Последняя реплика бота (или сотрудника) ДО этого хода; нет — бот ещё не говорил. */
  lastBotText: string | null | undefined;
  /** Когда бот это сказал (мс); нужно для «Жду»: сразу после обещания — закрытие, через часы — напоминание. */
  lastBotAt?: number | null;
  /** Сейчас (мс), для теста; по умолчанию Date.now(). */
  now?: number;
  /** Разговор о вакансии: там «спасибо» на вопрос бота — тоже закрытие (11.11.2026, бот слал блок вакансии заново). */
  jobTopic?: boolean;
};

/** «Жду» в течение этого времени после реплики бота — закрытие («агент позвонит» → «Жду»), позже — напоминание о себе. */
export const WAIT_CLOSES_WITHIN_MS = 3 * 60 * 60 * 1000;

export function ackReactionTurn(input: AckReactionTurnInput): boolean {
  if (input.hasMedia) return false;
  if (!input.lastBotText?.trim()) return false;
  if (!isAckOnlyMessage(input.text)) {
    // Одно ожидание («Жду», «Буду ждать») — реакция только сразу после обещания бота, не на его вопрос.
    if (!isWaitOnlyMessage(input.text) || input.lastBotAt == null || botAwaitsAnswer(input.lastBotText)) return false;
    const age = (input.now ?? Date.now()) - input.lastBotAt;
    return age >= 0 && age <= WAIT_CLOSES_WITHIN_MS;
  }
  if (!botAwaitsAnswer(input.lastBotText)) return true;
  // Бот ждал ответа: реакцией закрывает только прощание (и «спасибо» в разговоре о вакансии). Голое «спасибо» на
  // предложение звонка оператор считает согласием — это заявка, её не теряем (ревью 26.11.2026).
  return isFarewellClosingMessage(input.text) || (!!input.jobTopic && isThanksOnlyMessage(input.text));
}

/**
 * Слова клиента вообще похожи на «ок / спасибо / пока» — дешёвая проверка до чтения последней реплики бота из базы
 * (ядро читает её только тогда, lib/customerLastBotLine.ts). Окончательно решает ackReactionTurn.
 */
export function ackReactionCandidate(text: string): boolean {
  return isAckOnlyMessage(text) || isWaitOnlyMessage(text);
}

/** Реплика переписки (BotConversation.messages / ChatMessage) — только поля, нужные двери. */
export type BotLineEntry = { role?: unknown; content?: unknown; at?: unknown; attachments?: unknown; deliveryStatus?: unknown };

/**
 * ПОСЛЕДНИЕ СЛОВА БОТА (или сотрудника) — одна функция на все пути (ревью 26.11.2026). Пропускает то, что не слова:
 * фото/файл (вложения, пометка «[📷 фото объекта]»), ссылку и геометку («📍 https://…»), неотправленное. Иначе после
 * «Хотите посмотреть?» + фото «Да» клиента ушло бы в реакцию и согласие потерялось.
 * @param before реплики позже этого момента (мс) не берём.
 */
export function lastBotSpeech(history: readonly BotLineEntry[], before?: number): { text: string; at: number | null } | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m?.role !== "assistant" || typeof m.content !== "string") continue;
    if (Array.isArray(m.attachments) && m.attachments.length > 0) continue;
    if (m.deliveryStatus === "failed") continue;
    const words = m.content.replace(/https?:\/\/\S+/giu, " ").replace(/\[[^\]]*\]/gu, " ");
    if (!/\p{L}.*\p{L}/su.test(words)) continue;
    const parsed = typeof m.at === "string" ? Date.parse(m.at) : typeof m.at === "number" ? m.at : NaN;
    const at = Number.isFinite(parsed) ? parsed : null;
    if (before != null && at != null && at > before) continue;
    return { text: m.content, at };
  }
  return null;
}

/** Причина намеренной тишины хода ядра, ответившего реакцией (lib/customerIntendedSilence.ts). */
export const ACK_REACTION_HELD = "ack_only_reaction";
