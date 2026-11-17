import type { TxClient } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
import { candidatePhones, recruitmentFollowUpLine } from "../ai/customerAgentLiveWording.js";

/**
 * СИГНАЛ О КАНДИДАТЕ — ВМЕСТЕ С ОТВЕТОМ, В ОДНОЙ ТРАНЗАКЦИИ (ревью #206, В3, 16.11.2026).
 *
 * Бот отвечает соискателю «Спасибо, передал ваш номер Нозе, она сама вам позвонит» или, после «звонила — никто не
 * берёт», «Передал Нозе». Это правда только если те, кто разбирает вакансии, правда получили сигнал. Поэтому:
 *  - получатели — круг вакансий (право `vacancies.view`, та же дверь, что `lib/clientToCandidate.ts::notifyCandidateOwners`),
 *    а не закреплённый агент чата;
 *  - номер кандидата — в тексте сигнала (Ноза звонит по телефону, в чат не пишет);
 *  - сигнал ставится в очередь руководству (`enqueueDirectorAlert`) в ТОЙ ЖЕ транзакции, что и ответ клиенту: нет
 *    сигнала — нет и ответа с обещанием (транзакция откатывается, ход уходит в held и к человеку через сторож молчания);
 *  - тег свой на каждый номер и на каждое сообщение о недозвоне: новый номер не глушится прежним.
 */
const PHONE_TAKEN = new Set([recruitmentFollowUpLine("phone_given", "ru"), recruitmentFollowUpLine("phone_given", "tg")]);
const UNREACHABLE = new Set([recruitmentFollowUpLine("complaint", "ru"), recruitmentFollowUpLine("complaint", "tg")]);

export type RecruitmentAlertKind = "phone_given" | "complaint";
/** Which promise the sealed reply makes (exact fixed lines only, never model words). */
export function recruitmentAlertKind(replyText: string): RecruitmentAlertKind | null {
  const lines = replyText.split("\n").map(line => line.trim());
  if (lines.some(line => PHONE_TAKEN.has(line))) return "phone_given";
  if (lines.some(line => UNREACHABLE.has(line))) return "complaint";
  return null;
}

/** Queue the vacancy owners' signal in the caller's transaction; throws if it cannot be queued (the reply must not go then). */
export async function enqueueRecruitmentCandidateAlertTx(tx: TxClient, input: {
  replyText: string; customerText: string; conversationId: string; channel: string; eventKey: string;
  /** The transport peer: for WhatsApp it is the candidate's own number. */
  peer?: string; name?: string | null;
}): Promise<RecruitmentAlertKind | null> {
  const kind = recruitmentAlertKind(input.replyText);
  if (!kind) return null;
  const phones = candidatePhones(input.customerText);
  if (kind === "phone_given" && !phones.length) throw new Error("Recruitment alert without a candidate phone");
  const tail = phones.map(phone => phone.replace(/\D/gu, "").slice(-9)).join("-");
  // Who to call and where the chat is (re-review #206 Н2): the number from the message, else the WhatsApp number, and the
  // name if the card has one; the link opens this very chat.
  const peerPhone = input.channel === "WHATSAPP" && /^\d{7,15}$/u.test(input.peer ?? "") ? `+${input.peer}` : null;
  const reach = [input.name?.trim() || null, phones.length ? phones.join(", ") : peerPhone].filter(Boolean).join(", ");
  const who = reach ? `${reach} (${input.channel})` : `чат ${input.channel}, номера в переписке нет`;
  const url = `/messages?open=${input.conversationId}`;
  const queued = await enqueueDirectorAlert(kind === "phone_given" ? {
    title: "💼 Кандидат оставил номер",
    body: `Перезвоните кандидату: ${who}. Бот ответил, что Ноза сама позвонит.`,
    url, kind: "oversight", tag: `candidate-phone-${input.conversationId}-${tail}`, recipientPermission: "vacancies.view",
  } : {
    title: "💼 Кандидат не может дозвониться",
    body: `Кандидат не может дозвониться до Нозы: ${who}. Бот ответил, что Ноза сама позвонит.`,
    url, kind: "oversight", tag: `candidate-unreachable-${input.conversationId}-${input.eventKey.slice(0, 16)}`,
    recipientPermission: "vacancies.view",
  }, tx);
  if (!queued) throw new Error("Recruitment alert was not queued");
  return kind;
}
