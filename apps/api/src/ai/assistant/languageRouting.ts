import { detectClientLanguage, languageInstruction, type ClientLanguage } from "../clientLanguage.js";
import type { GeminiRuntime } from "../geminiSettings.js";
import { clientOwnWords } from "../untrustedContent.js";

// Supported by the existing generateContent transport; review preview availability before release.
export const ASSISTANT_TAJIK_MODEL = "gemini-3.1-pro-preview";

export function assistantLanguage(messages: readonly { role: string; content: string }[]): ClientLanguage {
  for (const message of [...messages].reverse()) {
    if (message.role !== "user") continue;
    const text = clientOwnWords(message.content);
    if (/(?:ответь|отвечай|напиши|пиши|переведи)\s+(?:пожалуйста\s+)?(?:на\s+таджикском|по-таджикски)/iu.test(text)) return "tg";
    if (/(?:ответь|отвечай|напиши|пиши|переведи)\s+(?:пожалуйста\s+)?(?:на\s+русском|по-русски)/iu.test(text)) return "ru";
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
      ? "\nПиши простым разговорным таджикским, без сложных литературных оборотов. Имена, номера карточек, суммы, валюты, даты и ссылки сохраняй точно. Не выдумывай перевод имени или неизвестный факт; уточни непонятное."
      : ""),
  };
}
