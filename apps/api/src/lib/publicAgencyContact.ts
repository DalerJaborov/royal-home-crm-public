/** Owner decision 14.10.2026: public agency contact is a telephone, not WhatsApp.
 * Transport credentials, sender numbers and routing are configured separately. */
const PUBLIC_PHONE = "+992 44 650 14 14";
export const PUBLIC_AGENCY_CONTACT = {
  phone: PUBLIC_PHONE,
  digits: PUBLIC_PHONE.replace(/\D/g, ""),
  channel: "telephone",
} as const;

/** Historical bot contact is unusable; customer quotes do not revive it. */
export function isRetiredPublicAgencyPhone(digits: string): boolean {
  return digits === RETIRED_PHONE_DIGITS || digits === RETIRED_PHONE_DIGITS.slice(-9);
}

export function isPublicAgencyPhone(digits: string): boolean {
  return digits === PUBLIC_AGENCY_CONTACT.digits || digits === PUBLIC_AGENCY_CONTACT.digits.slice(-9);
}

const RETIRED_PHONE_DIGITS = "992777776001";

function phonePattern(digits: string): string {
  const separated = (value: string) => value.split("").join("[ \\t()\\-]*");
  return `(?:\\+?${separated(digits)}|${separated(digits.slice(-9))})(?!\\d)`;
}

// Retired-phone correction changes an explicit agency-labelled span at sentence
// start, preserving its surroundings. Owner/client labels and quotes do not match.
const RETIRED_AGENCY_LABEL = new RegExp(
  `(^|[.!?][ \\t]+)(?:рақами\\s+мо|наш\\s+номер|(?:номер|телефон)\\s+(?:агентства|компании))[ \\t]*:[ \\t]*${phonePattern(RETIRED_PHONE_DIGITS)}`,
  "giu"
);
const PUBLIC_WHATSAPP_CLAIM = new RegExp(
  `(^|(?<=[.!?])[ \\t]+)(?:(?:наш|наша|наш\\s+номер)[ \\t]+|(?:напишите|пишите|нависед)[ \\t]+(?:(?:нам|мо)[ \\t]+)?(?:на|в|ба|дар)[ \\t]+)?(?:whats[ \\t]*app|ватсап|вотсап)(?:[ \\t]+(?:компании|агентства|мо))?[ \\t:–—-]*${phonePattern(PUBLIC_AGENCY_CONTACT.digits)}(?:[ \\t]*[.!?])?`,
  "giu"
);

/** Detect language from the untouched reply, excluding only the spans we repair. */
export function publicAgencyContactContext(text: string): string {
  return text
    .replace(RETIRED_AGENCY_LABEL, (_match, prefix: string) => prefix)
    .replace(PUBLIC_WHATSAPP_CLAIM, (_match, prefix: string) => prefix);
}

/** Correct only explicit company-contact facts from the trusted canonical data. */
export function renderPublicAgencyContact(text: string, language?: "ru" | "tg"): string {
  // Repair only a sentence-leading explicit company contact/invitation span,
  // preserving prices, places, questions and other sentences in the bubble.
  const corrected = text.replace(RETIRED_AGENCY_LABEL, (_match, prefix: string) => `${prefix}${publicAgencyCallReply(language)}`);
  return corrected.replace(PUBLIC_WHATSAPP_CLAIM, (_match, prefix: string) => `${prefix}${publicAgencyCallReply(language)}`);
}

export function publicAgencyCallReply(language?: "ru" | "tg"): string {
  if (language === "ru") return `Позвоните: ${PUBLIC_AGENCY_CONTACT.phone}.`;
  if (language === "tg") return `Занг занед: ${PUBLIC_AGENCY_CONTACT.phone}.`;
  return PUBLIC_AGENCY_CONTACT.phone;
}
