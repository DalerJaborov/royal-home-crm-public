import { createHash } from "node:crypto";
import { customerAgentVacanciesObservationSchema, recruitmentPositionSchema, assessRecruitmentResume,
  type RecruitmentFactKey, type CustomerAgentVacanciesObservation, type RecruitmentPosition } from "@royal-home/shared";
import { customerTextRole, foldCustomerText } from "./customerAgentRole.js";
import { extractRecruitmentResumeFacts, extractRecruitmentAnswerFacts } from "../lib/recruitmentResume.js";
import { customerOwnUnquotedText } from "./customerAgentConversationPolicy.js";

/** Pure public-data validation; never imports DB, candidate records or grants. */
export function recruitmentCatalogHash(value: Omit<CustomerAgentVacanciesObservation, "kind" | "sourceHash">): string {
  return createHash("sha256").update(JSON.stringify({ collecting: value.collecting,
    positions: value.positions.map(row => recruitmentPositionSchema.parse(row)) })).digest("hex");
}
export function isCustomerVacanciesObservation(value: unknown): value is CustomerAgentVacanciesObservation {
  const result = customerAgentVacanciesObservationSchema.safeParse(value);
  return result.success && result.data.sourceHash === recruitmentCatalogHash({ collecting: result.data.collecting, positions: result.data.positions }) &&
    result.data.positions.every(row => row.isOpen) && (result.data.collecting || !result.data.positions.length);
}
export function customerRecruitmentRequested(text: string): boolean {
  return /ваканси|ищу\s+работу|хочу\s+работать|хочу\s+(?:стать|устроиться)\s+агент|резюме|ҷойи\s+кор|чои\s+кор|дар\s+бораи\s+кор|(?:о|по)\s+работе|(?:насч[её]т|по\s+поводу)\s+работы|кор\s+(?:меҷӯ|мечу|мекоб|мехо[ҳх]|даркор|лозим)|ба\s+кор\s+(?:гири|қабул|кабул)|(?:есть|имеется)\s+(?:у\s+вас\s+)?(?:сейчас\s+)?(?:какая[\s-]*нибудь\s+)?(?:работ[аы]|работу)(?![\p{L}])|кор\s+доред(?![\p{L}])|SMM|СММ|видеограф/iu.test(text);
}
export function customerRecruitmentFactsRequested(text: string): boolean {
  const own = customerOwnUnquotedText(text);
  const nonSalaryFact = /ваканси|услови|график|удал[её]н|удал[её]нк|дистанцион|из\s+дома|офис|суббот|выходн|(?:дни|часы)\s+работ|(?:есть|ищу)\s+работ|ҷойи\s+кор|чои\s+кор|шартҳои\s+кор|дар\s+бораи\s+кор|фосилав|аз\s+хона|рӯзҳои\s+кор|соати\s+кор|шанбе|подроб|муфассал/iu;
  if (nonSalaryFact.test(own)) return true;
  const salary = /зарплат|оклад|оплат|платит|платят|заработ|доход|комисси|маош|даромад|музд/iu;
  const salaryOnly = /^(?:а\s+)?(?:зарплат\p{L}*|оклад\p{L}*|оплат\p{L}*|маош\p{L}*|даромад\p{L}*|музд\p{L}*)$/iu;
  const asks = /[?？]|(?<!\p{L})(?:какая|какой|какие|сколько|размер|узнать|интересует|расскажите|напишите|про|насчет|даромад)(?!\p{L})/iu;
  const rejects = /(?<!\p{L})(?:не\s+(?:спрашиваю|интересует|интересно|нужно|надо|хочу|важно)|без\s+(?:вопроса|зарплаты|зарплат|оплаты|маош))(?!\p{L})/iu;
  return own.split(/(?<=[?？!.,;\n])\s+|\s+(?:и|а|но|ҳам|ва)\s+/iu)
    .some(clause => {
      const normalized = clause.normalize("NFKC").toLowerCase().replace(/ё/gu, "е").replace(/[?？]+/gu, " ").replace(/\s+/gu, " ").trim();
      return salary.test(clause) && (asks.test(clause) || salaryOnly.test(normalized)) && !rejects.test(clause);
    });
}
/** Only topic projection. This creates no application, consent or HR verdict. */
export function customerRecruitmentTopic(text: string, previous: "buyer" | "seller" | "job" | "rent" | "unknown", matchedPublication = false) {
  // The customer's current request wins over an old recruitment/ad focus, and an explicit job
  // request wins over buy/sell words in the same text ("продаю 3 года, ищу работу" is a job inquiry).
  // "Ищу квартиру в аренду" is rental, not buying or applying for a job; a landlord is a seller.
  return customerTextRole(text, customerRecruitmentRequested(text)) ?? (matchedPublication ? "job" as const : previous);
}
/** Words that name no particular vacancy: they must never pick one by themselves. */
const GENERIC_POSITION_WORDS = new Set(["работа", "работу", "работе", "работы", "работать", "вакансия", "вакансии", "вакансию",
  "должность", "специалист", "сотрудник", "мутахассис", "мутахассиси", "корманд"]);
const letterTokens = (text: string) => foldCustomerText(text).split(" ").filter(Boolean);
/** Whole-word match with an inflection allowance: "видеографом" is "видеограф", "агентство" is not "агент". */
function mentionsPositionWord(tokens: readonly string[], word: string): boolean {
  const stem = word.length >= 6 ? word.slice(0, -2) : word;
  return tokens.some(token => token.startsWith(stem) && token.length <= word.length + 3);
}
export function selectedRecruitmentPosition(positions: readonly RecruitmentPosition[], text: string, knownKey?: string): RecruitmentPosition | null {
  const tokens = letterTokens(text);
  // Repeated observations of the same catalog row are not two different jobs.
  // A conflicting edition of that key remains ambiguous, never last-write-wins.
  const unique = positions.filter((position, index) => positions.findIndex(other =>
    JSON.stringify(other) === JSON.stringify(position)) === index);
  const matched = unique.filter(position => letterTokens([position.titleRu, position.titleTg, ...position.keywords].join(" "))
    .filter(word => (word.length >= 4 || /^[a-z]{3}$/u.test(word)) && !GENERIC_POSITION_WORDS.has(word)).some(word => mentionsPositionWord(tokens, word)));
  if (matched.length === 1) return matched[0];
  if (matched.length > 1) return null;
  const known = knownKey ? unique.filter(position => position.key === knownKey) : [];
  return known.length === 1 ? known[0] : null;
}

/** Interpret the CURRENT question first, then the retained public job context.
 * Only already minimized user turns from this same inquiry may disambiguate a
 * captionless follow-up. These words never establish availability or consent. */
export function recruitmentPositionForTurn(positions: readonly RecruitmentPosition[], input: { inputText?: string; mediaText?: string;
  knownKey?: string; turns?: readonly { role: "user" | "assistant"; text: string }[] }): RecruitmentPosition | null {
  const current = [input.inputText, input.mediaText].filter(Boolean).join("\n");
  const selected = selectedRecruitmentPosition(positions, current, input.knownKey);
  if (selected || input.knownKey) return selected;
  // Do not settle an explicit multi-role question using an older single role.
  if (positions.filter(row => selectedRecruitmentPosition([row], current)?.key === row.key).length > 1) return null;
  for (const turn of [...input.turns ?? []].reverse()) {
    if (turn.role !== "user") continue;
    const prior = selectedRecruitmentPosition(positions, turn.text);
    if (prior) return prior;
  }
  return null;
}

/** Only same-inquiry, already verified customer words. No IDs, HR verdict or
 * fabricated source keys are produced by this presentation projection. */
export function recruitmentMissingForTurn(position: RecruitmentPosition, input: { inputText?: string;
  knownPhone?: boolean; knownFacts?: readonly RecruitmentFactKey[]; answerTo?: RecruitmentFactKey;
  turns?: readonly { role: "user" | "assistant"; text: string }[] }): RecruitmentFactKey[] {
  const values: Partial<Record<RecruitmentFactKey, string | number | boolean>> = {};
  for (const text of [...(input.turns ?? []).filter(turn => turn.role === "user").map(turn => turn.text), input.inputText ?? ""]) {
    for (const [key, fact] of Object.entries(extractRecruitmentResumeFacts(text))) values[key as RecruitmentFactKey] = fact.value;
  }
  for (const [key, fact] of Object.entries(extractRecruitmentAnswerFacts(input.inputText ?? "", input.answerTo))) values[key as RecruitmentFactKey] = fact.value;
  const missing = assessRecruitmentResume({ rules: position.screeningRules, values,
    ...(input.knownPhone ? { phone: "known-current-contact" } : {}) }).missing.filter(key => !input.knownFacts?.includes(key));
  // A résumé can answer several questions at once. Invite it before individual
  // personal fields, and never demand prior experience as a hiring threshold.
  return missing.includes("about") ? ["about", ...missing.filter(key => key !== "about")] : missing;
}

const factQuestions: Record<RecruitmentFactKey, { ru: string; tg: string }> = {
  about: { ru: "Пришлите резюме или просто расскажите о себе и своём опыте.", tg: "Резюме фиристед ё дар бораи худ ва таҷрибаатон нақл кунед." },
  name: { ru: "Как к вам обращаться?", tg: "Ба шумо чӣ тавр муроҷиат кунам?" },
  phone: { ru: "Какой номер телефона хотите оставить для связи?", tg: "Барои тамос кадом рақами телефонро мегузоред?" },
  city: { ru: "В каком городе вы сейчас живёте?", tg: "Ҳоло дар кадом шаҳр зиндагӣ мекунед?" },
  age: { ru: "Сколько вам полных лет?", tg: "Шумо чандсола ҳастед?" },
  studyingNow: { ru: "Вы сейчас учитесь в школе, колледже или вузе? Курсы не считаются.", tg: "Ҳоло дар мактаб, коллеҷ ё донишгоҳ мехонед? Курсҳо ба ҳисоб намераванд." },
  employedNow: { ru: "Вы сейчас работаете в другом месте?", tg: "Ҳоло дар ҷои дигар кор мекунед?" },
  education: { ru: "Какое у вас образование?", tg: "Таҳсилоти шумо чӣ гуна аст?" },
  experience: { ru: "Расскажите о вашем опыте. Если его пока нет, так и напишите — это не означает отказ.", tg: "Дар бораи таҷрибаатон нависед. Агар таҷриба надошта бошед, ҳамин тавр нависед — ин маънои рад шуданро надорад." },
  languages: { ru: "На каких языках вы говорите?", tg: "Бо кадом забонҳо гап мезанед?" },
  startWhen: { ru: "Когда готовы приступить к работе?", tg: "Кай ба кор шурӯъ карда метавонед?" },
  skills: { ru: "Какие задачи вы умеете выполнять самостоятельно?", tg: "Кадом вазифаҳоро мустақилона иҷро карда метавонед?" },
  tools: { ru: "Какими программами и инструментами пользуетесь?", tg: "Аз кадом барномаҳо ва воситаҳо истифода мебаред?" },
};
export function recruitmentRequiredQuestion(key: RecruitmentFactKey, language: "ru" | "tg"): string { return factQuestions[key][language]; }
