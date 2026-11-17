import { detectClientLanguage, languageInstruction, type ClientLanguage } from "../clientLanguage.js";
import type { GeminiRuntime } from "../geminiSettings.js";
import { customerDmLanguagePreference } from "../customerDmLanguage.js";
import { clientOwnWords } from "../untrustedContent.js";

// Supported by the existing generateContent transport; review preview availability before release.
export const ASSISTANT_TAJIK_MODEL = "gemini-3.1-pro-preview";

/** Сколько последних сообщений сотрудника просмотреть в поисках явной просьбы о языке. */
const LANGUAGE_REQUEST_LOOKBACK = 6;

// Only bounded style adjectives inside a positive command; never infer a switch from a language name alone.
const RUSSIAN_FORM_COMMAND = /^(?:\s*пожалуйста[, ]*)?\s*(?:ответь|отвечай|напиши|пиши|переведи)\s+(?:пожалуйста\s+)?(?:на\s+(?:(?:прост(?:ой|ом)|разговорн(?:ый|ом))\s+){0,2}(таджикск(?:ом|ий)|русск(?:ом|ий))|по-(таджикски|русски))(?=[:\s]|$)/iu;
// «Бо русӣ нависед», «Ба забони тоҷикӣ ҷавоб деҳ», «Тоҷикӣ гап зан» (17.11.2026): так просят по-таджикски, и
// предложение на таджикском раньше само читалось как просьба писать по-таджикски — наоборот тому, что просили.
const TAJIK_ASK = String.raw`(?:нависед|навис|[ҷч]авоб\s+де[ҳх](?:ед)?|[ҷч]авоб\s+диҳед|гап\s+зан(?:ед)?|бигӯед|бигӯ|гӯед)`;
const TAJIK_LANGUAGE = String.raw`(рус[ӣи]|то[ҷч]ик[ӣи])`;
const TAJIK_FORM_BEFORE = new RegExp(String.raw`^(?:лутфан,?\s+)?(?:(?:бо|ба)\s+)?(?:забони\s+)?${TAJIK_LANGUAGE}\s+${TAJIK_ASK}(?=\s|$)`, "iu");
const TAJIK_FORM_AFTER = new RegExp(String.raw`^(?:лутфан,?\s+)?${TAJIK_ASK}\s+(?:бо|ба)\s+(?:забони\s+)?${TAJIK_LANGUAGE}(?=\s|$)`, "iu");

/**
 * Явная просьба сотрудника об языке ответа в ОДНОМ сообщении: русские обороты («ответь по-таджикски»),
 * таджикские («Бо русӣ нависед») и ответ «не понимаю по-русски» (общий разбор клиентского бота:
 * ai/customerDmLanguage.ts). Название языка само по себе не просьба.
 */
export function explicitAssistantLanguageRequest(message: string): "ru" | "tg" | null {
  const text = clientOwnWords(message);
  for (const clause of text.split(/[,.!?;\n]/u).reverse()) {
    const russian = RUSSIAN_FORM_COMMAND.exec(clause);
    if (russian) return /таджик/iu.test(russian[0]) ? "tg" : "ru";
    const tajik = TAJIK_FORM_BEFORE.exec(clause.trim()) ?? TAJIK_FORM_AFTER.exec(clause.trim());
    if (tajik) return /^рус/iu.test(tajik[1]) ? "ru" : "tg";
  }
  return customerDmLanguagePreference(text);
}

/**
 * Язык разговора. Просьба «отвечай по-русски» живёт, пока сотрудник не попросит иначе (в пределах последних
 * LANGUAGE_REQUEST_LOOKBACK его сообщений): раньше она действовала один ход, и следующий ответ снова
 * шёл на языке, которым человек писал. Нет просьбы — язык последнего сообщения с понятным языком.
 */
export function assistantLanguage(messages: readonly { role: string; content: string }[]): ClientLanguage {
  const own = [...messages].reverse().filter(message => message.role === "user");
  for (const message of own.slice(0, LANGUAGE_REQUEST_LOOKBACK)) {
    const requested = explicitAssistantLanguageRequest(message.content);
    if (requested) return requested;
  }
  for (const message of own) {
    const language = detectClientLanguage(clientOwnWords(message.content));
    if (language !== "unknown") return language;
  }
  return "unknown";
}

/**
 * Готовые фразы помощницы (частичный ответ, «отключили посреди хода») — на таджикском, если
 * сотрудник пишет по-таджикски или вперемешку. Одно правило на все такие фразы: то же, по которому
 * ход переключается на таджикскую модель ниже.
 */
export function repliesInTajik(language: ClientLanguage): boolean {
  return language === "tg" || language === "mixed";
}

export function assistantLanguagePolicy(messages: readonly { role: string; content: string }[], runtime: GeminiRuntime) {
  const language = assistantLanguage(messages);
  const strong = repliesInTajik(language);
  return {
    language,
    // Never mutate the shared runtime cache or silently downgrade Tajik to Flash.
    runtime: strong ? { ...runtime, model: ASSISTANT_TAJIK_MODEL, fallbackModels: [], liteModel: "" } : runtime,
    instruction: languageInstruction(language) + (strong
      ? "\nИспользуй простые разговорные слова выбранного выше языка, без сложных литературных оборотов. Сохраняй стандартное письменное написание; не сокращай слова по произношению и не используй диалектные формы, если сотрудник явно этого не попросил. Имена, номера карточек, суммы, валюты, даты и ссылки сохраняй точно. Не выдумывай перевод имени или неизвестный факт; уточни непонятное."
      : ""),
  };
}
