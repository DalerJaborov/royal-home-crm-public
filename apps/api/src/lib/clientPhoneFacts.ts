import { extractAllPhones } from "./shared/phoneText.js";

/** Conservative own-contact statements only; ambiguity is left for a person. */
export function explicitOwnPhoneFact(text: string, kind: "CALL" | "CONVERSATION", ownPhoneReply = false): { phone: string; correction: boolean } | null {
  const lines = kind === "CALL" ? text.split(/\r?\n/).flatMap(line => { const m = /^\s*Клиент\s*:\s*(.+)$/iu.exec(line); return m ? [m[1]] : []; }) : [text];
  const facts: Array<{phone:string;correction:boolean}> = [];
  for (const line of lines) {
    if (/(?:брат|сестр|мам|пап|муж|жен[аы]|родствен|(?:друга|другу|другом)(?!\p{L})|сосед|риелтор|агент|додар|бародар|хоҳар|хохар|модар|падар|рақами ӯ|раками у|например|допустим|если|агар|шояд|мисол|не\s+ошиб|не\s+мой|не\s+звон|не\s+пиш|неактуал|не\s+использ|больше\s+не|нест|[«»"])/iu.test(line)) continue;
    const candidates=[...line.matchAll(/(?<![\p{L}\p{N}])\+?\d[\d ()-]{7,22}\d(?![\p{L}\p{N}])/gu)];
    if (candidates.length!==1) continue;
    const candidate=candidates[0];const raw=candidate[0];const digits=raw.replace(/\D/g,'');
    const phone=digits.length===9 ? '+992'+digits : raw.trim().startsWith('+') && digits.length>=10 && digits.length<=15 ? '+'+digits : digits.length===12 && digits.startsWith('992') ? '+'+digits : null;
    if(!phone) continue;
    const prefix=line.slice(0,candidate.index).trim();
    const own=/(?:мой\s+(?:(?:новый|другой|второй|дополнительный|рабочий|правильный)\s+)?(?:номер|телефон)|(?:звоните|пишите|перезвоните)\s+мне\s+(?:на|по)(?:\s+(?:номеру|телефону))?|(?:рақам|ракам|телефон)(?:и)?\s+ман(?:\s+(?:ин|ҳамин|хамин))?)\s*[:—–-]?\s*$/iu.test(prefix);
    const directOwnReply = ownPhoneReply && kind === "CONVERSATION" && /^(?:(?:да|ҳа|ха|бале)[,!. ]*)?(?:вот\s+)?(?:ещ[её]|боз)(?:\s+(?:один|номер|рақам|ракам))?\s*[:—–-]?$/iu.test(prefix);
    if(!own && !directOwnReply) continue;
    const correction=/(?:я\s+(?:ошибся|ошиблась|неправильно\s+(?:назвал|назвала|написал|написала))|мой\s+(?:прежний|предыдущий)\s+номер\s+(?:неверный|ошибочный)|ман\s+хато\s+кардам)/iu.test(prefix);
    facts.push({phone,correction});
  }
  return facts.length===1 ? facts[0] : null;
}
/** Слова, с которыми номер, присланный ОДНИМ сообщением, остаётся «просто номером». Всё прочее — уже фраза, решает человек. */
const BARE_PHONE_FILLER = new Set(["номер", "мой", "моя", "телефон", "тел", "вот", "это", "ман", "рақам", "рақамам", "рақами", "раками",
  "ракам", "ракамам", "ин", "мана", "ана", "whatsapp", "watsapp", "вотсап", "ватсап", "вацап", "ватсапп", "вотсапп", "viber", "вайбер",
  "telegram", "телеграм", "imo", "имо", "nomer", "raqam", "raqamam", "tel"]);

/**
 * НОМЕР ОДНИМ СООБЩЕНИЕМ (27.11.2026, владелец: «кто оставил номер, должен попасть в CRM сам»).
 * Клиент в СВОЕЙ переписке с нами прислал сообщение, в котором нет ничего, кроме одного номера
 * («+992 900 12 34 56», «900-12-34-56 вотсап»), — это его номер так же ясно, как «мой номер …».
 * Любые другие слова (муж, брат, собственник, «позвоните ему») — уже не «просто номер»: решает
 * человек, как и раньше. Только для переписки; в расшифровке звонка такого правила нет.
 */
/**
 * Вопрос сотрудника или бота перед сообщением спрашивал номер ДРУГОГО человека (хозяина, мужа, родственника, агента):
 * тогда «просто номер» в ответ — его номер, а не клиента, и решает человек (ревью #497, S4).
 */
const OTHER_PERSON_NUMBER_QUESTION =
  /(?<![\p{L}])(?:хозя\p{L}*|собственник\p{L}*|владел\p{L}*|соҳиб\p{L}*|сохиб\p{L}*|моликият\p{L}*|муж\p{L}{0,3}|жен[аыуе]|брат\p{L}{0,3}|сестр\p{L}*|мам[аыу]|пап[аыу]|родствен\p{L}*|друг(?:а|у|ом)?|сосед\p{L}*|риелтор\p{L}*|шавҳар\p{L}*|шавхар\p{L}*|бародар\p{L}*|додар\p{L}*|хоҳар\p{L}*|хохар\p{L}*|модар\p{L}*|падар\p{L}*|хеш\p{L}*|ҳамсоя\p{L}*|хамсоя\p{L}*|его|её|ее|их|ӯ)(?![\p{L}])/iu;
/** «Ваш номер», «рақами шумо», «худатон» — вопрос о номере самого клиента. */
const OWN_NUMBER_QUESTION = /(?<![\p{L}])(?:ваш\p{L}*|вас|вам|свой|своего|шумо|худатон|худат)(?![\p{L}])/iu;

export function bareOwnPhoneFact(text: string, precedingQuestion?: string | null): { phone: string; correction: false } | null {
  if (precedingQuestion && OTHER_PERSON_NUMBER_QUESTION.test(precedingQuestion) && !OWN_NUMBER_QUESTION.test(precedingQuestion)) return null;
  const candidates = [...text.matchAll(/(?<![\p{L}\p{N}])\+?\d[\d ()-]{7,22}\d(?![\p{L}\p{N}])/gu)];
  if (candidates.length !== 1) return null;
  const raw = candidates[0][0];
  const digits = raw.replace(/\D/g, "");
  const phone = digits.length === 9 ? "+992" + digits : raw.trim().startsWith("+") && digits.length >= 10 && digits.length <= 15 ? "+" + digits
    : digits.length === 12 && digits.startsWith("992") ? "+" + digits : null;
  if (!phone) return null;
  // Строгий разбор переписки (цена, площадь, дата номером не становятся): тот же, что у приёма заявки.
  if (extractAllPhones(text).length !== 1) return null;
  const rest = (text.slice(0, candidates[0].index) + " " + text.slice((candidates[0].index ?? 0) + raw.length)).toLowerCase();
  if (/\d/.test(rest)) return null;
  const words = rest.match(/\p{L}+/gu) ?? [];
  if (words.some((w) => !BARE_PHONE_FILLER.has(w))) return null;
  return { phone, correction: false };
}

export function fullPhoneIdentity(phone: string): string {
  const digits=phone.replace(/\D/g,'');return digits.length===9 ? '992'+digits : digits;
}

/** A short answer has ownership meaning only immediately after this recorded question. */
export function contextualOwnPhoneFact(text: string, messages: unknown, assignmentAt?: Date, sourceAt?: Date) {
  if (!Array.isArray(messages) || messages.length < 2) return null;
  const question = messages.at(-1);
  if (!question || question.role !== "assistant" || (question.by != null && (typeof question.by !== "object" || question.by.kind !== "bot")) || typeof question.content !== "string") return null;
  if (/(?:брат|сестр|мам|пап|муж|жен[аы]|родствен|друг[ау]|сосед|агент|бародар|додар|модар|падар|хоҳар)/iu.test(question.content)) return null;
  if (!/(?:у\s+вас[^?]{0,50}(?:ещ[её]|дополнительн)[^?]{0,30}(?:номер|телефон)|(?:ещ[её]|дополнительн)[^?]{0,30}(?:номер|телефон)[^?]{0,30}(?:у\s+вас|есть)|боз\s+рақами\s+дигаре?\s+доред)\s*\?/iu.test(question.content)) return null;
  const preceding = messages.slice(0, -1).reverse().find(row => row?.role === "user");
  if (!preceding || preceding.by != null || preceding.silentCapture === true || typeof preceding.at !== "string") return null;
  const at = new Date(preceding.at);
  if (!Number.isFinite(at.getTime()) || assignmentAt && at < assignmentAt || sourceAt && at > sourceAt) return null;
  return explicitOwnPhoneFact(text, "CONVERSATION", true);
}
