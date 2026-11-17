import { customerAsksForCall, isCustomerShortCallbackYes } from "../ai/customerAskSignals.js";

/** A narrow server consent boundary, not a language/intent model. Unrecognized
 * wording stays none/review. It never changes whole-chat opt-out or schedules.
 * Vocabulary lives in one place, ai/customerAskSignals.ts (14.11.2026): the old
 * five-phrase list here rejected «позвони мне», «можете позвонить?», «пусть
 * позвонят», «свяжитесь со мной», «zang zaned» while the model understood them. */
export type CustomerCallbackConsentDecision = "requested" | "cancelled" | "continue_phone" | "needs_review" | "none";
/** Short yes/number reply. It is NEVER requested consent by itself: it counts
 * only with the actual accepted DM witness that the bot's own previous turn asked
 * the fixed callback question (lib/customerAcceptedCallbackQuestion.ts), and
 * never changes public/voice/website rights. «Да, конечно», «Хорошо», «Бале»,
 * «Ҳа, албатта», «Алишер 927123456» qualify; «Да?», «Да, но не звоните» do not. */
export function isCustomerCallbackAffirmative(text: string): boolean {
  return isCustomerShortCallbackYes(text);
}
const CALL_REQUEST = /(?<![\p{L}])(?:(?:пере|по)?звоните|наберите\s+(?:мне|меня)|call\s+me|занг\s+(?:занед|кунед)|тамос\s+гиред)(?![\p{L}])/iu;
const CALL_NEGATIVE = /(?<![\p{L}])(?:не\s+(?:пере|по)?звон(?:и|ите|ить)|не\s+надо\s+(?:мне\s+)?звонить|занг\s+назан(?:ед)?|занг\s+накунед|don't\s+call)(?![\p{L}])/iu;
const DIRECT_CANCEL = /^(?:(?:пожалуйста|илтимос),?\s*)?(?:не\s+(?:пере|по)?звон(?:и|ите|ить)(?:\s+(?:мне|нам|меня|больше))?|не\s+надо\s+(?:мне\s+)?звонить|занг\s+назан(?:ед)?|занг\s+накунед|don't\s+call(?:\s+me)?)[.!?\s]*$/iu;
// Quotes and third-person reports stay review. First-person «я вам написал,
// позвоните» is the customer's own request and is no longer cancelled by it.
const REPORTED = /[«»"“”]|(?<![\p{L}])(?:он\s+сказал|она\s+сказала|они\s+сказали|мне\s+сказали|(?<!я\s)сказал(?:а|и)?\s+что|(?:он|она|они)\s+написал(?:а|и)?|(?<!я\s)написал(?:а|и)?\s+что|гуфт(?:анд)?|навишт(?:анд)?)(?![\p{L}])/iu;
export function customerCallbackConsentDecision(text: string): CustomerCallbackConsentDecision {
  const value = text.normalize("NFC").trim();
  if (!value || value.length > 8000) return "none";
  if (CALL_NEGATIVE.test(value)) return DIRECT_CANCEL.test(value) && !REPORTED.test(value) ? "cancelled" : "needs_review";
  if (CALL_REQUEST.test(value) || customerAsksForCall(value)) return REPORTED.test(value) ? "needs_review" : "requested";
  // This is only a continuation candidate. The caller/executor still checks
  // exact authenticated current IN, its real phone and durable original consent.
  const phone = value.replace(/^(?:мой\s+номер|номер|рақами\s+ман|рақам)\s*[:=-]?\s*/iu, "");
  if (/^[+\d\s().-]+$/.test(phone) && /^\d{9,15}$/.test(phone.replace(/\D/g, ""))) return "continue_phone";
  return "none";
}
