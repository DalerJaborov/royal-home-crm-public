import { maskPhonesInFreeText } from "./clientPhone.js";

// These separators and decimal digits also appear in pasted contact details.
const PHONE_CANDIDATE = /(?<!\p{Nd})(?:[+＋][\p{Zs}\t]*)?\p{Nd}(?:[\p{Zs}\t.()/\p{Pd}\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069]*\p{Nd}){8,}(?!\p{Nd})/gu;
const NON_STANDARD_PHONE_CHAR = /[^\d+\s.()-]/u;

export function maskAssistantContacts(text: string): string {
  return maskPhonesInFreeText(text.replace(PHONE_CANDIDATE, (candidate) =>
    NON_STANDARD_PHONE_CHAR.test(candidate) ? "•••••" : candidate,
  ));
}
