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
 * Текст для человека, если ошибка — отказ денежной защиты с причиной, о которой стоит
 * сказать (велик вопрос, дневной предел, учёт недоступен); иначе null — у входа своё
 * сообщение. Отмена и переход через полночь — тоже null: там повтор и так поможет.
 */
export function assistantLimitText(err: unknown, lang: "ru" | "tg" = "ru"): string | null {
  const reason = assistantLimitReasonOf(err);
  if (!reason) return null;
  const code = assistantLimitCode(reason);
  return code === "too_large" || code === "daily_limit" || code === "unavailable" ? ASSISTANT_LIMIT_TEXTS[code][lang] : null;
}
