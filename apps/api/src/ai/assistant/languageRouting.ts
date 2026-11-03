import { detectClientLanguage, languageInstruction, type ClientLanguage } from "../clientLanguage.js";
import type { GeminiRuntime } from "../geminiSettings.js";
import { clientOwnWords } from "../untrustedContent.js";

// Supported by the existing generateContent transport; review preview availability before release.
export const ASSISTANT_TAJIK_MODEL = "gemini-3.1-pro-preview";

export function assistantLanguage(messages: readonly { role: string; content: string }[]): ClientLanguage {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    const text = clientOwnWords(message.content);
    for (const clause of text.split(/[,.!?;\n]/u).reverse()) {
      // Only bounded style adjectives inside a positive command; never infer a switch from a language name alone.
      const command = /^(?:\s*пожалуйста[, ]*)?\s*(?:ответь|отвечай|напиши|пиши|переведи)\s+(?:пожалуйста\s+)?(?:на\s+(?:(?:прост(?:ой|ом)|разговорн(?:ый|ом))\s+){0,2}(таджикск(?:ом|ий)|русск(?:ом|ий))|по-(таджикски|русски))(?=[:\s]|$)/iu.exec(clause);
      if (command) return /таджик/iu.test(command[0]) ? "tg" : "ru";
    }
    const language = detectClientLanguage(text);
    if (language !== "unknown") return language;
  }
  return "unknown";
}

export function assistantLanguagePolicy(messages: readonly { role: string; content: string }[], runtime: GeminiRuntime) {
  const language = assistantLanguage(messages);
  const strong = language === "tg" || language === "mixed";
  return {
    language,
    // Never mutate the shared runtime cache or silently downgrade Tajik to Flash.
    runtime: strong ? { ...runtime, model: ASSISTANT_TAJIK_MODEL, fallbackModels: [], liteModel: "" } : runtime,
    instruction: languageInstruction(language) + (strong
      ? "\nИспользуй простые разговорные слова выбранного выше языка, без сложных литературных оборотов. Сохраняй стандартное письменное написание; не сокращай слова по произношению и не используй диалектные формы, если сотрудник явно этого не попросил. Имена, номера карточек, суммы, валюты, даты и ссылки сохраняй точно. Не выдумывай перевод имени или неизвестный факт; уточни непонятное."
      : ""),
  };
}
