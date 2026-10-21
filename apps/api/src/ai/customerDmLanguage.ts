import { detectClientLanguage } from "./clientLanguage.js";
import { clientOwnWords } from "./untrustedContent.js";

/** A requested reply language is different from the language of the sentence
 * requesting it. Scope this to customer DM, leaving voice/legacy routing alone. */
export function customerDmLanguagePreference(input: string): "ru" | "tg" | null {
  const text = clientOwnWords(input).normalize("NFKC").trim().toLowerCase().replace(/[.!?]+$/gu, "").trim();
  const requested = /^(?:ответь(?:те)?|пиши(?:те)?|напиши(?:те)?|говори(?:те)?)(?:,?\s+пожалуйста)?\s+(?:на\s+(русском|таджикском)|по[-\s](русски|таджикски))(?:\s|,|$)/u.exec(text);
  if (requested) return /рус/u.test(requested[1] ?? requested[2]) ? "ru" : "tg";
  if (/^(?:на русском|по[-\s]русски)(?:,?\s+пожалуйста)?$/u.test(text) || /^(?:бо|ба)\s+(?:забони\s+)?рус[ӣи]\s+(?:нависед|гап занед)$/u.test(text)) return "ru";
  if (/^(?:на таджикском|по[-\s]таджикски)(?:,?\s+пожалуйста)?$/u.test(text) ||
      /^то[ҷч]ик[ӣи](?:ш|ша)?\s+(?:мегрифт[ӣи]|гап\s+зан(?:ед)?|навис(?:ед)?)(?:\s|$)/u.test(text)) return "tg";
  return null;
}
export function detectCustomerDmLanguage(input: string) {
  return customerDmLanguagePreference(input) ?? detectClientLanguage(input);
}
