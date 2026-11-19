import { assistantLimitReasonOf, type AssistantLimitReason } from "./attemptLimit.js";

/**
 * ЧТО СКАЗАТЬ ЧЕЛОВЕКУ ПРИ ОТКАЗЕ ДЕНЕЖНОЙ ЗАЩИТЫ — ОДНА ТАБЛИЦА НА ВСЕ ВХОДЫ (19.11.2026).
 *
 * Ответ помощницы (CRM, Telegram), голосовые, файлы, мастер объекта и чеки берут текст
 * отсюда: на проде 19.11 общий «лимит вызовов ИИ достигнут или учёт недоступен»
 * прочитали как «деньги кончились», хотя запрос был просто слишком большим.
 * Конверт хода и потолок шагов — тоже «сузьте вопрос»: следующий, более узкий вопрос
 * пройдёт, а «продолжим завтра» было бы неправдой. «Вы» по-русски, «шумо» по-таджикски.
 */
export type AssistantLimitCode = "too_large" | "daily_limit" | "unavailable" | "aborted" | "internal";

/**
 * Код по одной причине, без знания хода. attempt_cap и money_turn здесь — «велико»; основной
 * ход помощницы уточняет их сам (assistant.ts, failureOf): были ли в ходе отказы по размеру
 * или попытки ушли на повторы после сбоя Google.
 */
export function assistantLimitCode(reason: AssistantLimitReason): AssistantLimitCode {
  switch (reason) {
    case "input_too_large":
    case "attempt_cap":
    case "money_turn":
      return "too_large";
    case "money_daily":
    case "attempts_daily":
      return "daily_limit";
    case "aborted":
      return "aborted";
    case "day_rollover":
      return "internal";
    case "accounting_unavailable":
    case "policy_expired":
    case "unsupported_request":
      return "unavailable";
  }
}

export const ASSISTANT_LIMIT_TEXTS: Record<"too_large" | "daily_limit" | "unavailable", { ru: string; tg: string }> = {
  too_large: {
    ru: "Ответ получается слишком большим. Сузьте вопрос: например, один день, один агент или первые 10 строк.",
    tg: "Ҷавоб аз ҳад калон мешавад. Саволро тангтар кунед: масалан, як рӯз, як агент ё 10 сатри аввал.",
  },
  daily_limit: {
    ru: "На сегодня предел расходов на ИИ исчерпан, продолжим завтра. Руководителю уже сообщено.",
    tg: "Имрӯз ҳадди хароҷоти ИИ тамом шуд, пагоҳ идома медиҳем. Ба роҳбар хабар дода шуд.",
  },
  unavailable: {
    ru: "Помощница временно недоступна, уже чиним.",
    tg: "Ёрдамчӣ муваққатан дастрас нест, мо аллакай ислоҳ карда истодаем.",
  },
};

/**
 * Текст для БОКОВЫХ путей (голосовые, файлы, мастер объекта, чеки): только дневной предел и
 * недоступный учёт — о них человеку надо знать, «пришлите ещё раз» там не поможет. Остальное
 * — null, у входа своё прежнее сообщение. Потолок попыток и конверт хода там съедают повторы
 * после 503/таймаута Google (у чека потолок — одна попытка), а не размер: «сузьте вопрос…
 * один агент» про фото чека было бы неправдой (ревью 19.11.2026). Велик вход — тоже null:
 * у разбора одного файла нечего сужать, а его «пришлите ещё раз» прежнее.
 */
export function assistantLimitText(err: unknown, lang: "ru" | "tg" = "ru"): string | null {
  const reason = assistantLimitReasonOf(err);
  if (!reason) return null;
  const code = assistantLimitCode(reason);
  return code === "daily_limit" || code === "unavailable" ? ASSISTANT_LIMIT_TEXTS[code][lang] : null;
}
