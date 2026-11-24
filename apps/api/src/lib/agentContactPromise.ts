import type { ConversationMessage } from "@royal-home/shared";
import { stripUntrusted } from "../ai/untrustedContent.js";
import { customerRoleSignals } from "../ai/customerAgentRole.js";
import { promisesAgentContact } from "../ai/callbackPromiseGuard.js";
import { customerCallbackConsentDecision } from "./customerCallbackConsent.js";
import { customerRecruitmentRequested } from "../ai/customerAgentRecruitmentProtocol.js";
import { mentionsJobSeeking } from "../ai/jobSeekerCall.js";

/** Сколько последних реплик клиента разбираем в каждом диалоге: номер/обещание всегда рядом
 *  с концом разговора, а читать всю историю ради этого — лишняя работа. */
const LOOK_BACK_MESSAGES = 30;

/**
 * Сколько ждём после обещания, прежде чем считать заявку потерянной. Приём ядра
 * (задание customer-lead-only-intake) заводит карточку за секунды; десять минут с
 * запасом на повтор задания, чтобы сторож не гонялся с ним.
 */
export const PROMISE_GRACE_MS = 10 * 60_000;

/** Бот перечислял вакансии (ответ на «работа»): без слов о сделке такой разговор — про работу. */
const VACANCY_OFFER = /(?<![\p{L}])(?:ваканси\p{L}*|ҷой(?:и|ҳои)\s+кор\p{L}*|о\s+работе)(?![\p{L}])/iu;

/**
 * Разговор о работе: клиент сам говорит о работе (общие словари найма), или бот перечислял
 * вакансии, а о покупке/продаже клиент не сказал ни слова. Карточку клиента на соискателя не
 * заводят (владелец 17.09.2026), так что обещание агента здесь — не потерянная заявка.
 */
function jobConversation(messages: readonly ConversationMessage[]): boolean {
  const own = messages.filter((m) => m.role === "user" && typeof m.content === "string").map((m) => m.content as string);
  // Спросил про вакансии, а потом про квартиру — покупатель: слова о сделке сильнее любого признака работы.
  const dealTalk = own.some((t) => {
    const signals = customerRoleSignals(t);
    return signals.sell || signals.buyStrong || signals.buyWeak;
  });
  if (dealTalk) return false;
  if (own.some((t) => customerRecruitmentRequested(t) || mentionsJobSeeking(t))) return true;
  return messages.some((m) => m.role === "assistant" && typeof m.content === "string" && VACANCY_OFFER.test(m.content));
}

function sentencesOf(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => line.split(/(?<=[.!?])[ \t]+/u)).map((s) => s.trim()).filter(Boolean);
}

/**
 * ОБЕЩАЛ — КАРТОЧКИ НЕТ (19.11.2026, владелец: «нужно чтобы такое никогда больше не повторилось»).
 *
 * Четыре клиента 17–18.11 услышали «агент позвонит» / «Передал вашу просьбу», а карточки
 * не было ни у одного: все в WhatsApp, где номер известен без слов клиента, поэтому
 * поиск номера в тексте их не видел. Сторож смотрит на ФАКТ, а не на ветку кода:
 * последнее обещание бота новее прошлой попытки сторожа, старше PROMISE_GRACE_MS, и
 * клиент после него не отказался от звонка. Возвращает реплику клиента перед обещанием —
 * по ней приём решает аренду и запасные номера, как по реплике с номером.
 */
export function lastAgentContactPromise(
  messages: readonly ConversationMessage[],
  after: Date | null,
  now: Date
): { at: Date; clientText: string; refusalUnclear: boolean } | null {
  const recent = messages.slice(-LOOK_BACK_MESSAGES * 2);
  if (jobConversation(recent)) return null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.role !== "assistant" || typeof m.content !== "string" || typeof m.at !== "string") continue;
    const at = new Date(m.at);
    if (Number.isNaN(at.getTime()) || (after && at <= after)) return null;
    if (!sentencesOf(m.content).some(promisesAgentContact)) continue;
    if (now.getTime() - at.getTime() < PROMISE_GRACE_MS) return null;
    const later = recent.slice(i + 1).filter((x) => x.role === "user" && typeof x.content === "string");
    const decisions = later.map((x) => customerCallbackConsentDecision(x.content as string));
    if (decisions.includes("cancelled")) return null;
    const before = recent.slice(0, i).reverse().find((x) => x.role === "user" && typeof x.content === "string" && x.content);
    // «Не звоните, я передумал», «Занг назанед илтимос, ман дар кор» — отказ не целым сообщением (needs_review):
    // тихо звонить нельзя, решает человек.
    return {
      at,
      clientText: before ? stripUntrusted(before.content as string, ["document", "video", "voice"]) : "",
      refusalUnclear: decisions.includes("needs_review"),
    };
  }
  return null;
}
