/** A narrow server consent boundary, not a language/intent model. Unrecognized
 * wording stays none/review. It never changes whole-chat opt-out or schedules. */
export type CustomerCallbackConsentDecision = "requested" | "cancelled" | "continue_phone" | "needs_review" | "none";
/** Tiny lexical candidate only. It is never requested consent without an actual
 * accepted DM question witness, and never changes public/voice/website rights. */
export function isCustomerCallbackAffirmative(text: string): boolean {
  return /^(?:да|ҳа)[.!]*$/iu.test(text.normalize("NFC").trim());
}
const CALL_REQUEST = /(?<![\p{L}])(?:(?:пере|по)?звоните|наберите\s+(?:мне|меня)|call\s+me|занг\s+(?:занед|кунед)|тамос\s+гиред)(?![\p{L}])/iu;
const CALL_NEGATIVE = /(?<![\p{L}])(?:не\s+(?:пере|по)?звон(?:и|ите|ить)|не\s+надо\s+(?:мне\s+)?звонить|занг\s+назан(?:ед)?|занг\s+накунед|don't\s+call)(?![\p{L}])/iu;
const DIRECT_CANCEL = /^(?:(?:пожалуйста|илтимос),?\s*)?(?:не\s+(?:пере|по)?звон(?:и|ите|ить)(?:\s+(?:мне|нам|меня|больше))?|не\s+надо\s+(?:мне\s+)?звонить|занг\s+назан(?:ед)?|занг\s+накунед|don't\s+call(?:\s+me)?)[.!?\s]*$/iu;
const REPORTED = /[«»"“”]|(?<![\p{L}])(?:он\s+сказал|она\s+сказала|мне\s+сказали|сказал(?:а|и)?\s+что|написал(?:а|и)?|гуфт(?:анд)?|навишт)(?![\p{L}])/iu;
export function customerCallbackConsentDecision(text: string): CustomerCallbackConsentDecision {
  const value = text.normalize("NFC").trim();
  if (!value || value.length > 8000) return "none";
  if (CALL_NEGATIVE.test(value)) return DIRECT_CANCEL.test(value) && !REPORTED.test(value) ? "cancelled" : "needs_review";
  if (CALL_REQUEST.test(value)) return REPORTED.test(value) ? "needs_review" : "requested";
  // This is only a continuation candidate. The caller/executor still checks
  // exact authenticated current IN, its real phone and durable original consent.
  const phone = value.replace(/^(?:мой\s+номер|номер|рақами\s+ман|рақам)\s*[:=-]?\s*/iu, "");
  if (/^[+\d\s().-]+$/.test(phone) && /^\d{9,15}$/.test(phone.replace(/\D/g, ""))) return "continue_phone";
  return "none";
}
