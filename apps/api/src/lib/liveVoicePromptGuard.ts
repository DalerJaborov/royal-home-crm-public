/**
 * ПРАВИЛА ВЫЗОВА ИНСТРУМЕНТОВ В СВОЁМ ТЕКСТЕ ЛИЧНОСТИ ЖИВОГО ГОЛОСА
 * (02.10.2026, аудит роботов №5).
 *
 * Settings.liveVoicePrompt подменяет DEFAULT_LIVE_VOICE_PROMPT целиком
 * (ai/liveVoicePersona.ts::buildLiveVoiceSystemPrompt), а в зашитом тексте лежат и
 * правила вызова инструментов: save_contact (записать имя/номер), end_call
 * (попрощаться и положить трубку), escalate_to_human (позвать живого). Меняя «тон»,
 * владелец стирал их вместе с остальным, и робот переставал сохранять контакт и
 * класть трубку, ничего при этом не показывая: звонок идёт, ошибок нет.
 *
 * Дописывать правила к чужому тексту в сборщике нельзя: тот же `roleOverride`
 * получают сценарные звонки (опрос после показа, проверка собственника,
 * приглашение на собеседование) со СВОИМИ инструментами, и чужие правила их бы
 * сбили. Поэтому охраняем в точке сохранения: текст без упоминания этих
 * инструментов не принимается, и сообщение говорит, чего не хватает.
 */
export const LIVE_VOICE_REQUIRED_TOOL_NAMES = ["save_contact", "end_call", "escalate_to_human"] as const;

/** Каких инструментов нет в тексте. Пустой массив — текст годится. */
export function missingLiveVoiceToolRules(prompt: string): string[] {
  return LIVE_VOICE_REQUIRED_TOOL_NAMES.filter((name) => !prompt.includes(name));
}

/** Как инструмент называется для человека (ошибка уходит на экран Настроек и в тост). */
export const LIVE_VOICE_TOOL_HUMAN_NAMES: Record<(typeof LIVE_VOICE_REQUIRED_TOOL_NAMES)[number], string> = {
  save_contact: "записать контакт",
  end_call: "положить трубку",
  escalate_to_human: "позвать человека",
};

/** Текст отказа для Настроек — null, когда всё на месте. Без идентификаторов
 *  инструментов: владелец читает «записать контакт», а не save_contact (02.10.2026,
 *  аудит экрана). Сам текст личности остаётся техническим: охранник ищет в нём именно
 *  имена функций, и стандартный текст-образец их содержит. */
export function liveVoicePromptToolRulesError(prompt: string): string | null {
  const missing = missingLiveVoiceToolRules(prompt);
  if (missing.length === 0) return null;
  const names = missing.map((n) => LIVE_VOICE_TOOL_HUMAN_NAMES[n as keyof typeof LIVE_VOICE_TOOL_HUMAN_NAMES]).join(", ");
  return (
    `В тексте личности нет правил: ${names}. Без них робот не запишет контакт, ` +
    `не положит трубку или не позовёт человека. Допишите, когда это делать ` +
    `(образец — стандартный текст), либо нажмите «Вернуть прежний».`
  );
}
