import { createHash } from "node:crypto";
import type { CustomerPropertyFactKind, CustomerPropertyFacts, CustomerMutationReceipt,
  CustomerAgentDecision, CustomerAgentQuestion, CustomerAgentSurface, CustomerAgentVerifiedContext } from "@royal-home/shared";
import { customerPropertyCharacteristicLines, customerPropertyAvailabilityLine, customerAgentPublicationObservationSchema } from "@royal-home/shared";
import { PUBLIC_AGENCY_CONTACT } from "../lib/publicAgencyContact.js";
import { customerPublicThanks, customerRequestedAgencyContact, customerRecruitmentLanguagePermissionQuestion,
  customerRecruitmentLanguagePermissionRequested, customerFollowRequest, customerStandaloneFurnitureQuestion,
  customerFurnitureQuestionRequested, customerMessengerChannelQuestion, isCustomerPublicAppreciation,
  customerPublicReaction, customerPublicReactionText } from "./customerAgentConversationPolicy.js";
import { customerAgentIntake, customerSellerIntakeQuestion } from "./customerAgentIntake.js";
import { customerRecruitmentRequested, customerRecruitmentFactsRequested, isCustomerVacanciesObservation, recruitmentPositionForTurn,
  recruitmentMissingForTurn, recruitmentRequiredQuestion } from "./customerAgentRecruitmentProtocol.js";
import { customerRecruitmentReplyDetails, containsRecruitmentExperienceInvitation } from "./customerRecruitmentReply.js";
import { clientOwnWords } from "./untrustedContent.js";
import { BW, EW, TAIL } from "./wordBoundary.js";
import { customerAsksPricePerSqm, pricePerSqmLine } from "../lib/customerPropertyPerSqm.js";
import type { CustomerPropertyUnresolvedReason } from "../lib/customerPropertyUnresolvedReason.js";
import { customerCallbackConsentDecision } from "../lib/customerCallbackConsent.js";
import { customerAgentAttachmentInputSchema, customerAgentAttachmentQuestion, type CustomerAgentAttachmentInput } from "./customerAgentAttachmentInput.js";
import { customerAgentMediaPerceptionSchema, customerAgentVisualSummary, type CustomerAgentMediaPerception } from "./customerAgentMediaPerception.js";
import { isPinnedCompanyPolicy, isPublicPropertySearch, isCustomerCompanyInformation, type CustomerAgentCompanyPolicyObservation,
  type CustomerAgentSearchObservation } from "./customerAgentPublicProtocol.js";

export type CustomerReceiptOutcome = CustomerMutationReceipt["outcome"];
export type CustomerAgentObservation =
  | { kind: "facts"; facts: CustomerPropertyFacts; kinds: CustomerPropertyFactKind[] }
  | { kind: "property_unresolved"; status: "missing" | "ambiguous"; reason?: CustomerPropertyUnresolvedReason }
  | { kind: "receipt"; outcome: CustomerReceiptOutcome }
  | { kind: "agency_contact"; contact: { phone: string; digits: string; channel: "telephone" } }
  | CustomerAgentCompanyPolicyObservation
  | CustomerAgentSearchObservation
  | import("@royal-home/shared").CustomerAgentCompanyInformationObservation
  | import("@royal-home/shared").CustomerAgentPublicationObservation
  | import("@royal-home/shared").CustomerAgentVacanciesObservation
  // Only an adapter-validated exact proposal may provide this bounded summary.
  // Its presence does not prove presentation or authorize a subsequent "yes".
  | { kind: "proposal"; summary: { ru: string; tg: string } };
export interface CustomerAgentEvidence { ref: string; value: CustomerAgentObservation }

/** Compare only with the actual canonical source, never a second phone literal.
 * This validates a public fact, not a principal or a customer phone identity. */
export function isCanonicalAgencyContact(value: Extract<CustomerAgentObservation, { kind: "agency_contact" }>): boolean {
  return value.contact.channel === "telephone" && value.contact.phone === PUBLIC_AGENCY_CONTACT.phone && value.contact.digits === PUBLIC_AGENCY_CONTACT.digits;
}
export type CustomerAgentRenderedQuestion = CustomerAgentQuestion | "confirmation";
/** What the candidate's CURRENT message carried beyond its caption: the readable text of a
 * document/photo (OCR is untrusted candidate material, used only to see which facts are
 * already given) and whether a document/photo/own account of themselves was received at all. */
interface RecruitmentMaterial { mediaText?: string; materialReceived?: boolean; applicationSaved?: boolean }
const JOB_ONLY_QUESTIONS: readonly string[] = ["job_position", "job_required", "job_experience", "job_portfolio", "job_tools", "job_format", "job_start"];
// With nothing to apply to, neither a job nor a property questionnaire is asked; a name, a contact or the topic still is.
const NO_OPENING_SUPPRESSED: readonly string[] = [...JOB_ONLY_QUESTIONS, "property", "budget", "location", "rooms", "role", "seller_details", "preferences"];
/** The résumé is requested ONCE. Not again when a document/photo/own account is already here,
 * or when an earlier assistant turn of this inquiry has already asked for it. */
function recruitmentAboutHandled(input: RecruitmentMaterial & { verifiedContext?: CustomerAgentVerifiedContext; inputText?: string }): boolean {
  if (input.materialReceived) return true;
  const own = (input.inputText ?? "").trim();
  if (input.applicationSaved && own.length >= 60 && !/[?？]/u.test(own)) return true;
  const asks = (["ru", "tg"] as const).flatMap(language => [recruitmentRequiredQuestion("about", language), questions.job_experience[language]]);
  return !!input.verifiedContext?.turns.some(turn => turn.role === "assistant" && asks.some(question => turn.text.includes(question)));
}
function recruitmentPositionPreviouslyPresented(input: { verifiedContext?: CustomerAgentVerifiedContext;
  position: { titleRu: string; titleTg: string; detailsRu?: string; detailsTg?: string } }): boolean {
  const ruDetails = (input.position.detailsRu ?? "").split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  const tgDetails = (input.position.detailsTg ?? "").split(/\r?\n/u).map(value => value.trim()).filter(Boolean);
  return !!input.verifiedContext?.turns.some(turn => {
    if (turn.role !== "assistant") return false;
    const languageWasPresented = (title: string, currentDetails: string[], unavailableLine: string) => {
      if (!turn.text.includes(title)) return false;
      if (!currentDetails.length) return turn.text.includes(unavailableLine);
      // The normal initial vacancy answer contains its first two authored
      // paragraphs; an explicit full-details answer contains all of them.
      // Title-only questions and stale conditions therefore do not count.
      const presented = currentDetails.length <= 2 ? [currentDetails] : [currentDetails.slice(0, 2), currentDetails];
      return presented.some(required => required.every(paragraph => turn.text.includes(paragraph)));
    };
    // Evaluate each title/details pair independently: some roles share a
    // title across languages, so a RU title match must not mask TG evidence.
    return languageWasPresented(input.position.titleRu, ruDetails, "Подробные условия этой должности пока не опубликованы.") ||
      languageWasPresented(input.position.titleTg, tgDetails, "Шартҳои муфассали ин вазифа ҳоло нашр нашудаанд.");
  });
}
function recruitmentNextFact(input: RecruitmentMaterial & { evidence: readonly CustomerAgentEvidence[]; verifiedContext?: CustomerAgentVerifiedContext;
  inputText?: string; knownPhoneSource: "none" | "current_input" | "scoped_contact" }) {
  const openings = input.evidence.flatMap(e => e.value.kind === "open_vacancies" ? e.value.positions : []);
  const position = recruitmentPositionForTurn(openings, { inputText: input.inputText, mediaText: input.mediaText,
    knownKey: input.verifiedContext?.publicState.jobPositionKey, turns: input.verifiedContext?.turns });
  if (!position) return undefined;
  const aboutHandled = recruitmentAboutHandled(input);
  return recruitmentMissingForTurn(position, { inputText: [input.inputText, input.mediaText].filter(Boolean).join("\n"),
    turns: input.verifiedContext?.turns, knownFacts: input.verifiedContext?.recruitmentKnown,
    answerTo: input.verifiedContext?.recruitmentAnswerTo,
    knownPhone: input.knownPhoneSource !== "none" }).find(key => key !== "about" || !aboutHandled);
}
function intakeProgress(input: { verifiedContext?: CustomerAgentVerifiedContext; inputText?: string }) {
  const prior = input.verifiedContext?.intake;
  const recent = customerAgentIntake(prior ? [] : input.verifiedContext?.turns ?? [], input.inputText, prior?.role);
  if (!prior || recent.role !== "unknown" && recent.role !== prior.role) return recent;
  return { role: prior.role, sellerKnown: [...new Set([...prior.sellerKnown, ...recent.sellerKnown])],
    buyerKnown: [...new Set([...prior.buyerKnown, ...recent.buyerKnown])] };
}
export function customerAgentRenderedQuestion(input: { decision: CustomerAgentDecision; evidence: readonly CustomerAgentEvidence[];
  surface: CustomerAgentSurface; knownPhoneSource: "none" | "current_input" | "scoped_contact"; requestedFacts?: readonly CustomerPropertyFactKind[];
  verifiedContext?: CustomerAgentVerifiedContext; inputText?: string } & RecruitmentMaterial): CustomerAgentRenderedQuestion {
  const d = input.decision;
  if (d.kind === "skip" || d.kind === "escalate" || d.kind === "moderation_proposal") return "none";
  if (d.kind === "propose") return "confirmation";
  const referencedCards = input.evidence.filter(e => d.refs.includes(e.ref)).flatMap(e =>
    e.value.kind === "facts" ? [e.value.facts] : e.value.kind === "publication_properties" ? e.value.cards : []);
  if (referencedCards.length && referencedCards.every(f => f.availability === "SOLD") &&
      customerCallbackConsentDecision(clientOwnWords(input.inputText ?? "")) !== "requested") return "none";
  // An evidenced refusal of an unavailable service is already a complete
  // answer. Do not reopen an unrelated job/property intake after it.
  if (!customerRecruitmentRequested(input.inputText ?? "") && input.evidence.some(e =>
    e.value.kind === "company_policy" && e.value.topic === "rental" && !e.value.knowledge.rent && d.refs.includes(e.ref))) return "none";
  if (input.surface === "public_comment" && !input.requestedFacts?.length && customerPublicReaction(input.inputText ?? "")) return "none";
  if (d.question === "topic" && input.evidence.some(e => e.value.kind === "company_information" && d.refs.includes(e.ref))) return "none";
  if (input.evidence.some(e => e.value.kind === "open_vacancies" && (d.refs.includes(e.ref) || customerRecruitmentRequested(input.inputText ?? "") || input.verifiedContext?.publicState.topic === "job"))) {
    const openings = input.evidence.flatMap(e => e.value.kind === "open_vacancies" ? e.value.positions : []);
    // An empty/closed catalog leaves no job question to ask, but the customer's other next
    // step (a name, a contact, what they are looking for) is not suppressed with it.
    if (!openings.length && NO_OPENING_SUPPRESSED.includes(d.question)) return "none";
    if (openings.length && ["property", "budget", "location", "rooms", "role", "topic", "seller_details", "preferences", "job_position", "job_required", "job_experience", "name", "phone"].includes(d.question)) {
      if (!recruitmentPositionForTurn(openings, { inputText: input.inputText,
        knownKey: input.verifiedContext?.publicState.jobPositionKey, turns: input.verifiedContext?.turns })) return "job_position";
      return recruitmentNextFact(input) ? "job_required" : "none";
    }
  }
  // Resolution failures are facts about the current property, not a reason to
  // collect a phone/name before answering or clarifying the property.
  if (input.evidence.some(e => e.value.kind === "property_unresolved" &&
      (d.refs.includes(e.ref) || !!input.requestedFacts?.length))) return "property";
  if (d.question === "property" && input.evidence.some(e => e.value.kind === "publication_properties" &&
      e.value.cards.length === 1 && (d.refs.includes(e.ref) || !!input.requestedFacts?.length))) return "none";
  if ((d.question === "phone" && input.knownPhoneSource !== "none") ||
      (input.surface === "public_comment" && ["phone", "name", "callback_consent"].includes(d.question))) return "none";
  if (input.surface === "dm") {
    const intake = intakeProgress(input);
    if (intake.role === "seller" && ["role", "rooms", "location", "budget", "seller_details"].includes(d.question)) return "seller_details";
    if (intake.role === "buyer" && intake.buyerKnown.includes(d.question as "rooms" | "budget" | "location")) {
      return (["location", "rooms", "budget"] as const).find(key => !intake.buyerKnown.includes(key)) ?? "preferences";
    }
  }
  return d.question;
}

const questions: Record<CustomerAgentQuestion, { ru: string; tg: string }> = {
  none: { ru: "", tg: "" },
  property: { ru: "Какой объект вы имеете в виду? Пришлите номер объекта или ссылку.", tg: "Шумо кадом объектро дар назар доред? Рақами объект ё пайвандашро фиристед." },
  budget: { ru: "Какой бюджет вы рассматриваете?", tg: "Шумо чӣ қадар буҷет дар назар доред?" },
  location: { ru: "Какой район вам подходит?", tg: "Кадом ноҳия ба шумо мувофиқ аст?" },
  rooms: { ru: "Сколько комнат вам нужно?", tg: "Ба шумо чанд ҳуҷра лозим аст?" },
  name: { ru: "Как к вам обращаться?", tg: "Ба шумо чӣ тавр муроҷиат кунам?" },
  phone: { ru: "Какой номер телефона вы хотите оставить для связи?", tg: "Барои тамос кадом рақами телефонро мегузоред?" },
  callback_consent: { ru: "Вы хотите, чтобы сотрудник вам позвонил?", tg: "Мехоҳед корманд ба шумо занг занад?" },
  topic: { ru: "Вы хотите узнать о недвижимости или о работе?", tg: "Шумо дар бораи амвол маълумот мехоҳед ё дар бораи кор?" },
  role: { ru: "Вы хотите купить или продать недвижимость?", tg: "Шумо амвол харидан мехоҳед ё фурӯхтан?" },
  clarify_previous: { ru: "Что пояснить подробнее?", tg: "Чиро муфассалтар шарҳ диҳам?" },
  seller_details: { ru: "Расскажите о недвижимости, которую хотите продать.", tg: "Дар бораи амволе, ки фурӯхтан мехоҳед, нависед." },
  preferences: { ru: "Что ещё важно при выборе: например, этаж или состояние ремонта?", tg: "Ҳангоми интихоб боз чӣ муҳим аст: масалан, ошёна ё ҳолати таъмир?" },
  job_position: { ru: "Какая должность вас интересует?", tg: "Кадом вазифа ба шумо ҷолиб аст?" },
  job_experience: { ru: "Пришлите резюме или просто расскажите о себе и своём опыте.", tg: "Резюме фиристед ё дар бораи худ ва таҷрибаатон нақл кунед." },
  job_portfolio: { ru: "Если хотите, можете прислать примеры работ или ссылку на портфолио. Это необязательно.", tg: "Агар хоҳед, намунаи корҳо ё пайванди портфолиоро фиристед. Ин ҳатмӣ нест." },
  job_tools: { ru: "Какими программами пользуетесь и какие задачи выполняете самостоятельно?", tg: "Аз кадом барномаҳо истифода мебаред ва кадом вазифаҳоро мустақилона иҷро мекунед?" },
  job_format: { ru: "Вам подходит указанный формат работы?", tg: "Шартҳои нашршудаи кор ба шумо мувофиқанд?" },
  job_start: { ru: "Когда готовы приступить к работе?", tg: "Кай ба кор шурӯъ карда метавонед?" },
  job_required: { ru: "", tg: "" },
};
function publicRecruitmentQuestion(question: CustomerAgentQuestion, language: "ru" | "tg", experienceIncluded: boolean): string {
  if (question === "job_required") return language === "tg" ? "Барои муҳокимаи дархости кор ба паёми шахсӣ нависед." : "Напишите нам в личные сообщения, чтобы обсудить отклик.";
  if (question === "job_experience") return experienceIncluded
    ? language === "tg" ? "Дархости корро дар паёми шахсӣ муҳокима карда метавонем." : "Обсудить отклик можно в личных сообщениях."
    : language === "tg" ? "Дар паёми шахсӣ нависед: метавонед резюме фиристед ё дар бораи худ ва таҷрибаатон нақл кунед."
      : "Напишите нам в личные сообщения: можно прислать резюме или рассказать о себе и своём опыте.";
  const privateChannel = language === "tg" ? "Дар паёми шахсӣ нависед." : "Напишите нам в личные сообщения.";
  return `${privateChannel} ${questions[question][language]}`;
}
/** What exactly went wrong with the reference, as its own line before the standard property
 * question (which stays a separate line, so a bare-number answer is still understood). */
const unresolvedReasons: Record<CustomerPropertyUnresolvedReason, { ru: string; tg: string } | null> = {
  no_reference: null,
  unsupported: { ru: "Эту ссылку открыть не получилось: такой формат ссылок я не читаю.", tg: "Ин пайвандро кушода натавонистам: чунин намуди пайвандҳоро намехонам." },
  untrusted_origin: { ru: "Эта ссылка ведёт не на наши публикации, по ней объект определить не могу.", tg: "Ин пайванд ба нашрияҳои мо намебарад, аз рӯи он объектро муайян карда наметавонам." },
  not_found: { ru: "По этой ссылке или номеру объект не нашёлся.", tg: "Аз рӯи ин пайванд ё рақам объект ёфт нашуд." },
  lookup_unavailable: { ru: "Сейчас не получилось проверить объект, это временный сбой. Попробуйте ещё раз чуть позже.", tg: "Ҳоло объектро санҷида натавонистам, ин хатои муваққатӣ аст. Баъдтар бори дигар кӯшиш кунед." },
};
function unresolvedPropertyLine(value: Extract<CustomerAgentObservation, { kind: "property_unresolved" }>, language: "ru" | "tg"): string | null {
  if (value.status === "ambiguous") return language === "tg" ? "Ба ин нишона якчанд объект мувофиқ аст, як объектро интихоб карда наметавонам." : "Под это описание подходит несколько объектов, выбрать один не могу.";
  return value.reason ? unresolvedReasons[value.reason]?.[language] ?? null : null;
}
/** The question of an interrupted property clarification: the plain template or its "я уточнял" repair. */
export function customerAgentPropertyQuestionTexts(language: "ru" | "tg"): string[] { return [questions.property[language], repairs.property[language]]; }
/** Server-owned template, not a model text or presentation proof. */
export function customerAgentCallbackQuestionText(language: "ru" | "tg"): string { return questions.callback_consent[language]; }
export function customerAgentNameQuestionText(language: "ru" | "tg"): string { return questions.name[language]; }
export function customerAgentPropertyQuestionText(language: "ru" | "tg"): string { return questions.property[language]; }
// Formatting of already minimized server-loaded context only. This selects no
// actor, contact, action, proposal or consent; callers still fence the original IN.
const repairPurposes = ["budget", "location", "rooms", "property", "topic", "role"] as const;
const repairs: Record<typeof repairPurposes[number], { ru: string; tg: string }> = {
  budget: { ru: "Я уточнял сумму для покупки. Какой у вас бюджет?", tg: "Ман буҷети барои харид пешбиникардаи шуморо мепурсидам. Чӣ қадар маблағ дар назар доред?" },
  location: { ru: "Я уточнял район для поиска. Какой район вам подходит?", tg: "Ман ноҳияро барои ҷустуҷӯ мепурсидам. Кадом ноҳия ба шумо мувофиқ аст?" },
  rooms: { ru: "Я уточнял количество комнат. Сколько комнат вам нужно?", tg: "Ман шумораи ҳуҷраҳоро мепурсидам. Чанд ҳуҷра лозим аст?" },
  property: { ru: "Я уточнял, о каком объекте речь. Пришлёте номер объекта или ссылку?", tg: "Ман муайян кардан мехостам, ки сухан дар бораи кадом объект меравад. Рақами объект ё пайвандашро мефиристед?" },
  topic: { ru: "Я уточнял тему обращения: вы хотите узнать о недвижимости или о работе?", tg: "Ман мавзӯи муроҷиатро мепурсидам: дар бораи амвол маълумот мехоҳед ё дар бораи кор?" },
  role: { ru: "Я уточнял вашу задачу: хотите купить или продать недвижимость?", tg: "Ман мақсади шуморо мепурсидам: амвол харидан мехоҳед ё фурӯхтан?" },
};
function repairPreviousQuestion(context: CustomerAgentVerifiedContext | undefined, language: "ru" | "tg"): string | null {
  // Do not reach past a later answered/user turn or reinterpret arbitrary prose.
  const previous = context?.turns.at(-1);
  if (context?.surface !== "dm" || previous?.role !== "assistant") return null;
  const lines = previous.text.split("\n").map(line => line.trim());
  const purposes = repairPurposes.filter(purpose => lines.some(line => line === questions[purpose].ru || line === questions[purpose].tg));
  return purposes.length === 1 ? repairs[purposes[0]][language] : null;
}
const social = {
  none: { ru: "", tg: "" }, greet: { ru: "Здравствуйте!", tg: "Салом!" },
  thank: { ru: "Спасибо!", tg: "Ташаккур!" }, acknowledge: { ru: "Понял.", tg: "Фаҳмидам." },
  apologize: { ru: "Извините за неудобство.", tg: "Барои нороҳатӣ узр мехоҳам." },
};
const outcomes: Record<CustomerReceiptOutcome, { ru: string; tg: string }> = {
  job_application_saved: { ru: "Сведения добавлены к отклику на вакансию.", tg: "Маълумот ба дархости кор илова шуд." },
  contact_saved: { ru: "Контактные данные сохранены.", tg: "Маълумоти тамос сабт шуд." },
  callback_requested: { ru: "Запрос на звонок создан.", tg: "Дархост барои занг сабт шуд." },
  new_lead_created: { ru: "Обращение зарегистрировано.", tg: "Муроҷиат сабт шуд." },
  handover_requested: { ru: "Обращение к сотруднику создано.", tg: "Муроҷиат ба корманд сабт шуд." },
  showing_booked: { ru: "Запись на показ создана.", tg: "Дархост барои тамошо сабт шуд." },
  showing_rescheduled: { ru: "Время записи на показ изменено.", tg: "Вақти сабти тамошо иваз шуд." },
  showing_cancelled: { ru: "Запись на показ отменена.", tg: "Сабти тамошо бекор шуд." },
  owner_question_recorded: { ru: "Вопрос собственнику сохранён.", tg: "Савол ба соҳибмулк сабт шуд." },
};
function factSegments(value: Extract<CustomerAgentObservation, { kind: "facts" }>, language: "ru" | "tg", question = ""): string[] {
  const f = value.facts, tg = language === "tg", result: string[] = [];
  if (f.availability === "SOLD") return [customerPropertyAvailabilityLine(f, language)];
  for (const kind of new Set(value.kinds)) {
    if (kind === "price") {
      const amount = f.price?.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
      const money = amount ? `${amount} ${f.currency === "USD" ? "USD" : tg ? "сомонӣ" : "сомони"}` : null;
      result.push(money ? tg ? `Нархи объект №${f.shortId}: ${money}.` : `Цена объекта №${f.shortId}: ${money}.`
        : tg ? "Нархи дақиқро ҳоло тасдиқ карда наметавонам." : "Точную цену пока не могу подтвердить.");
      // Server arithmetic over the confirmed price and area only (never a model figure).
      if (customerAsksPricePerSqm(question)) result.push(pricePerSqmLine(f, language));
    }
    if (kind === "address") result.push(f.publicAddress
      ? `${tg ? "Ҷойгиршавӣ" : "Расположение"}: ${f.publicAddress}.`
      : tg ? "Ҷойгиршавии дақиқро ҳоло тасдиқ карда наметавонам." : "Точное расположение пока не могу подтвердить.");
    if (kind === "builder") result.push(tg ? "Маълумоти тасдиқшуда дар бораи сохтмончӣ нест." : "Нет подтверждённых данных о застройщике.");
    if (kind === "characteristics") result.push(...customerPropertyCharacteristicLines(f.characteristics, language, question));
    if (kind === "availability") result.push(customerPropertyAvailabilityLine(f, language));
  }
  if (f.availability === "RESERVED" && !value.kinds.includes("availability")) result.push(tg ? "Объект ҳоло дар брон аст." : "Объект сейчас в брони.");
  return result;
}

function policySegment(value: CustomerAgentCompanyPolicyObservation, language: "ru" | "tg"): string {
  const k = value.knowledge, tg = language === "tg";
  if (value.topic === "commission") return tg
    ? `Ҳаққи хизмат барои фурӯшанда ${k.commission.sellerPercent}%, барои харидор ${k.commission.buyerPercent}% аст.`
    : `Комиссия для продавца — ${k.commission.sellerPercent}%, для покупателя — ${k.commission.buyerPercent}%.`;
  if (value.topic === "rental") return k.rent
    ? tg ? "Хизматрасонии иҷора дастрас аст; шартҳоро бояд дақиқ кунем." : "Услуги аренды доступны; условия нужно уточнить."
    : tg ? "Ҳоло бо иҷора кор намекунем: на ба иҷора медиҳем ва на меҷӯем." : "Сейчас арендой не занимаемся: не сдаём и не подбираем в аренду.";
  if (value.topic === "payment") return [
    k.installments ? tg ? "Шартҳои пардохти қисм-қисмро бояд дақиқ кунем." : "Условия рассрочки нужно уточнить."
      : tg ? "Пардохти қисм-қисм надорем." : "Рассрочки нет.",
    k.mortgage ? tg ? "Шартҳои ипотекаро бояд дақиқ кунем." : "Условия ипотеки нужно уточнить."
      : tg ? "Ипотека надорем." : "Ипотеки нет.",
  ].join(" ");
  // No discount percentage or promise that the owner was contacted/agreed.
  if (value.topic === "negotiation") return tg
    ? "Масъалаи савдоро агент бо соҳибмулк муҳокима мекунад. Андозаи тахфифро ҳоло тасдиқ карда наметавонам."
    : "Вопрос торга агент обсуждает с собственником. Размер скидки пока не могу подтвердить.";
  if (value.topic === "legal") return k.guarantees
    ? tg ? "Шартҳои кафолати ҳуқуқиро бояд дақиқ кунем." : "Условия юридических гарантий нужно уточнить."
    : tg ? "Покии ҳуқуқии объектро кафолат дода наметавонам." : "Не могу гарантировать юридическую чистоту объекта.";
  return tg ? `Барои хариду фурӯши амвол дар ${k.city} кӯмак мекунем.${k.otherCities ? "" : " Дар шаҳрҳои дигар кор намекунем."}`
    : `Помогаем с покупкой и продажей недвижимости в городе ${k.city}.${k.otherCities ? "" : " Другие города не обслуживаем."}`;
}
// Word-bounded so "участок" is not "час" and "суроға" is an address question (not hours).
const word = (alternatives: string) => new RegExp(`${BW}(?:${alternatives})${EW}`, "iu");
const HOURS_QUESTION = word(`час(?:ы|ов|ам|ах|а)?|соат${TAIL}|когда|скольки|кай|аз\\s+кай|то\\s+кай`);
const OFFICE_QUESTION = word(`где|адрес${TAIL}|офис${TAIL}|дафтар${TAIL}|идора${TAIL}|суроға${TAIL}|куҷо${TAIL}|кучо${TAIL}`);
// "ҳаққи хизмат" is the commission topic, not a question about the services list.
const SERVICES_QUESTION = word(`какие\\s+(?:у\\s+вас\\s+)?услуг${TAIL}|какими\\s+услугами|чем\\s+(?:вы\\s+)?занимаетесь|чем\\s+занимается\\s+(?:ваша\\s+)?(?:компания|агентство)|(?<!ҳаққи\\s)хизматҳо${TAIL}|кадом\\s+хизмат${TAIL}|шумо\\s+чӣ\\s+кор\\s+мекунед`);
export function customerCompanyServicesRequested(text: string): boolean { return SERVICES_QUESTION.test(clientOwnWords(text)); }
const SERVICES_TG: Record<string, string> = { "Продажа и помощь в покупке": "фурӯш ва кӯмак дар харидани амвол" };
export function customerCompanyInformationRequested(text: string): boolean {
  // Automatic reads need an explicit agency question. A commercial property,
  // appointment deadline or quoted publication is not our office/schedule.
  // Ambiguous questions remain available to the model's normal read tools.
  const own = clientOwnWords(text).trim();
  const agencyLocation = /ваш(?:его|ем|им)?\s+офис|офис[ае]?\s+(?:ваш|агентств|royal\s*home)|адрес\s+агентства|где\s+вы\s+находитесь|как\s+к\s+вам\s+(?:добраться|пройти|проехать|доехать|попасть)|(?:дафтари|идораи)\s+шумо|суроғаи\s+(?:шумо|агент)/iu;
  const agencyHours = /когда\s+(?:вы\s+)?работаете|до\s+скольки\s+(?:вы\s+)?работаете|во\s+сколько\s+(?:вы\s+)?открываетесь|ваши\s+часы\s+работы|у\s+вас\s+(?:часы|время)\s+работы|соат[иҳое]*\s+кор(?:иатон|и\s+шумо)/iu;
  const standaloneHours = /^(?:(?:какие\s+)?часы\s+работы|соат[иҳое]*\s+кори?(?:\s+чанд)?)[?.!\s]*$/iu;
  return agencyLocation.test(own) || agencyHours.test(own) || standaloneHours.test(own) || SERVICES_QUESTION.test(own);
}
function companyInformationLines(value: import("@royal-home/shared").CustomerAgentCompanyInformationObservation, language: "ru" | "tg", text: string): string[] {
  const tg = language === "tg", info = value.information;
  const own = clientOwnWords(text);
  const wantsServices = SERVICES_QUESTION.test(own), wantsHours = HOURS_QUESTION.test(own), wantsOffice = OFFICE_QUESTION.test(own);
  // No recognised sub-question (a model-selected read) keeps the original answer: office and hours.
  const servicesOnly = wantsServices && !wantsHours && !wantsOffice;
  const onlyHours = wantsHours && !wantsOffice && !wantsServices;
  const office = tg ? info.officeTg ?? info.office : info.office;
  const address = office.startsWith(info.city) ? office : `${info.city}, ${office}`;
  const lines: string[] = [];
  if (wantsServices) {
    const services = tg ? SERVICES_TG[info.services] ?? info.services.toLocaleLowerCase() : info.services.charAt(0).toLocaleLowerCase() + info.services.slice(1);
    lines.push(tg ? `Хизматҳои ${info.name}: ${services}.` : `Услуги ${info.name}: ${services}.`);
  }
  if (!onlyHours && !servicesOnly) lines.push(tg ? `Идораи ${info.name}: ${address}.` : `Офис ${info.name}: ${address}.`);
  if (servicesOnly) return lines;
  if (info.hours) {
    const days = { ru: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"],
      tg: ["якшанбе", "душанбе", "сешанбе", "чоршанбе", "панҷшанбе", "ҷумъа", "шанбе"] };
    const off = info.hours.daysOff.map(day => days[language][day]).join(", ");
    lines.push(tg ? `Кормандон аз ${info.hours.start} то ${info.hours.end} бо вақти Душанбе дар тамосанд. ${off ? `Рӯзҳои истироҳат: ${off}.` : "Ҳар рӯз кор мекунем."}`
      : `Сотрудники на связи с ${info.hours.start} до ${info.hours.end} по Душанбе. ${off ? `Выходные: ${off}.` : "Работаем каждый день."}`);
  } else lines.push(tg ? "Соатҳои дақиқи корро ҳоло тасдиқ карда наметавонам." : "Точные часы работы пока не могу подтвердить.");
  return lines;
}
function searchSegments(value: CustomerAgentSearchObservation, language: "ru" | "tg"): string[] {
  const tg = language === "tg";
  if (!value.cards.length) return [tg ? "Дар интихоби ҷорӣ варианти мувофиқ ёфт нашуд." : "В текущей подборке подходящих вариантов не найдено."];
  const lines = [tg ? "Ин вариантҳоро дида баромадан мумкин аст:" : "Можно рассмотреть эти варианты:"];
  if (value.districtWasNormalized && value.resolvedDistrictName) lines.push(tg
    ? `Интихоб аз ноҳияи ${value.resolvedDistrictName} аст. Наздикии дақиқ ба нишонии гуфтаатон ҳоло тасдиқ нашудааст.`
    : `Подборка по району ${value.resolvedDistrictName}. Точная близость к названному ориентиру пока не подтверждена.`);
  const notes = {
    rooms_more: { ru: "комнат больше, чем запрошено", tg: "ҳуҷраҳо аз дархост зиёдтаранд" },
    rooms_less: { ru: "комнат меньше, чем запрошено", tg: "ҳуҷраҳо аз дархост камтаранд" },
    over_budget: { ru: "выше названного бюджета", tg: "аз буҷети гуфташуда болотар" },
    below_budget: { ru: "ниже названного минимума", tg: "аз ҳадди поёнии гуфташуда камтар" },
    rooms_unknown: { ru: "число комнат не подтверждено", tg: "шумораи ҳуҷраҳо тасдиқ нашудааст" },
    price_unknown: { ru: "соответствие бюджету не подтверждено", tg: "мувофиқат ба буҷет тасдиқ нашудааст" },
  };
  for (const [index, card] of value.cards.entries()) {
    lines.push(`${index + 1}. ${tg ? "Объект" : "Объект"} №${card.facts.shortId}`);
    lines.push(...factSegments({ kind: "facts", facts: card.facts, kinds: ["price", "address"] }, language));
    if (card.listing.rooms !== null && card.listing.type === "APARTMENT") lines.push(tg ? `Ҳуҷраҳо: ${card.listing.rooms}.` : `Комнат: ${card.listing.rooms}.`);
    if (card.facts.characteristics) lines.push(...customerPropertyCharacteristicLines(card.facts.characteristics, language,
      language === "tg" ? "масоҳат ошёна таъмир" : "площадь этаж ремонт"));
    if (card.match.notes.length) lines.push(`${tg ? "Эзоҳ" : "Примечание"}: ${card.match.notes.map(note => notes[note][language]).join("; ")}.`);
    if (value.linksAllowed !== false && card.facts.publicLink) lines.push(card.facts.publicLink);
  }
  return lines;
}

/** No model prose can invent an amount, date, contact or completed action.
 * Public observations/receipts are supplied by server ports; this rendering
 * itself confers no authority, physical send or proposal-presentation proof. */
export function renderCustomerAgentDecision(input: {
  decision: CustomerAgentDecision; evidence: readonly CustomerAgentEvidence[]; language: "ru" | "tg";
  requestedFacts: readonly CustomerPropertyFactKind[]; knownPhoneSource: "none" | "current_input" | "scoped_contact";
  maxOutputChars: number; surface: CustomerAgentSurface; knowledgeSourceHash?: string;
  /** Server-loaded bounded context only; never a request/model permission. */
  verifiedContext?: CustomerAgentVerifiedContext;
  /** Original input supplied by the server adapter, never model prose. */
  inputText?: string;
  attachmentInput?: CustomerAgentAttachmentInput;
  mediaPerception?: CustomerAgentMediaPerception;
}): string | null {
  const d = input.decision, lang = input.language;
  if (d.kind === "skip" || d.kind === "escalate" || d.kind === "moderation_proposal") return "";
  const mayOverrideConversation = d.kind !== "propose";
  const followRequest = mayOverrideConversation && input.surface === "dm" && customerFollowRequest(input.inputText ?? "");
  const languagePermissionRequested = mayOverrideConversation && input.surface === "dm" && input.verifiedContext?.publicState.topic === "job" &&
    customerRecruitmentLanguagePermissionRequested(input.inputText ?? "");
  const languagePermissionOnly = mayOverrideConversation && input.surface === "dm" && input.verifiedContext?.publicState.topic === "job" &&
    customerRecruitmentLanguagePermissionQuestion(input.inputText ?? "");
  const furnitureQuestion = mayOverrideConversation && (input.surface === "dm" || input.surface === "public_comment") &&
    customerFurnitureQuestionRequested(input.inputText ?? "");
  const furnitureOnly = furnitureQuestion && customerStandaloneFurnitureQuestion(input.inputText ?? "");
  const messengerChannelQuestion = mayOverrideConversation && input.surface === "dm" && customerMessengerChannelQuestion(input.inputText ?? "");
  const continuingRecruitment = mayOverrideConversation && input.surface === "dm" && input.verifiedContext?.publicState.topic === "job" &&
    input.verifiedContext.turns.some(turn => turn.role === "assistant");
  const selected = d.kind === "propose" ? [d.ref] : d.refs;
  const mandatory = input.requestedFacts.length ? input.evidence.filter(e => e.value.kind === "facts" || e.value.kind === "property_unresolved" || e.value.kind === "publication_properties") : [];
  const publicContactQuestion = input.surface === "public_comment" && d.kind !== "propose" && ["phone", "name", "callback_consent"].includes(d.question);
  const requestedContact = customerRequestedAgencyContact(input.inputText ?? "");
  const contact = publicContactQuestion && requestedContact ? input.evidence.filter(e => e.value.kind === "agency_contact") : [];
  const company = customerCompanyInformationRequested(input.inputText ?? "") ? input.evidence.filter(e => e.value.kind === "company_information") : [];
  const recruitment = customerRecruitmentFactsRequested(input.inputText ?? "") || !input.inputText?.trim() && !!input.verifiedContext?.publicState.jobPositionKey
    ? input.evidence.filter(e => e.value.kind === "open_vacancies") : [];
  const refs = [...new Set([...mandatory.map(e => e.ref), ...selected, ...contact.map(e => e.ref), ...company.map(e => e.ref), ...recruitment.map(e => e.ref)])];
  const referenced = refs.map(ref => input.evidence.find(e => e.ref === ref));
  if (referenced.some(value => !value)) return null;
  // Retained pre-fix plans may contain multiple refs to the same catalog. Check
  // integrity of each one before collapsing identical public-data observations.
  if (referenced.some(e => e?.value.kind === "open_vacancies" && !isCustomerVacanciesObservation(e.value))) return null;
  // One meaning block is rendered once, whatever the number of refs to it: the core reads the
  // company information itself and the model may read it again, so identical content (by hash)
  // collapses for EVERY kind. A proposal is never collapsed: its ref is the decision target.
  const seenContent = new Set<string>();
  const evidence = referenced.filter(item => {
    if (!item || item.value.kind === "proposal") return true;
    const key = createHash("sha256").update(JSON.stringify(item.value)).digest("hex");
    if (seenContent.has(key)) return false;
    seenContent.add(key); return true;
  });
  if (d.kind === "propose" && evidence.find(e => e?.ref === d.ref)?.value.kind !== "proposal") return null;
  if (d.kind !== "propose" && evidence.some(e => e?.value.kind === "proposal")) return null;
  const lines: string[] = [];
  let experienceInvitationIncluded = false;
  let furnitureAnswerIncluded = false;
  const applicationSaved = evidence.some(e => e?.value.kind === "receipt" && e.value.outcome === "job_application_saved");
  const requestedKinds = (kinds: readonly CustomerPropertyFactKind[]) => input.requestedFacts.length
    ? kinds.filter(kind => input.requestedFacts.includes(kind)) : [...kinds];
  const perception = input.mediaPerception ? customerAgentMediaPerceptionSchema.safeParse(input.mediaPerception) : undefined;
  if (perception && (!perception.success || input.surface !== "dm")) return null;
  // Readable text of a document/photo is candidate material: it only shows which facts are given.
  const material: RecruitmentMaterial = { applicationSaved,
    mediaText: perception?.success ? [perception.data.transcript, perception.data.readableText].filter(Boolean).join("\n") : undefined,
    materialReceived: perception?.success ? perception.data.subject === "document" || perception.data.readableText.trim().length >= 20 : !!input.attachmentInput };
  const recruitmentMedia = perception?.success && customerRecruitmentRequested(
    [input.inputText, perception.data.transcript, perception.data.readableText].filter(Boolean).join("\n"));
  // A chair behind a recruiter is not the subject of the customer's question.
  // Keep the perceived content for interpretation, not an unsolicited inventory.
  const visualSummary = perception?.success && !recruitmentMedia && input.verifiedContext?.publicState.topic !== "job"
    ? customerAgentVisualSummary(perception.data, lang) : null;
  if (visualSummary) lines.push(visualSummary);
  if (perception?.success && perception.data.incomplete) lines.push(lang === "tg" ? "Як қисми файлҳои фиристодаатон кушода нашуд." : "Часть присланных файлов не удалось открыть.");
  if (perception?.success && perception.data.speech === "unintelligible" && d.kind === "clarify" && d.question === "clarify_previous" &&
      !(input.inputText ?? "").trim() && !visualSummary && !evidence.length) {
    const text = lang === "tg" ? "Сухан дар сабт нофаҳмо аст. Метавонед паёми овозиро бори дигар фиристед?"
      : "Речь на записи не удалось разобрать. Можете прислать голосовое ещё раз?";
    return text.length <= input.maxOutputChars ? text : null;
  }
  if (input.surface === "public_comment" && evidence.some(e => e?.value.kind === "receipt" || e?.value.kind === "proposal")) return null;
  const reaction = input.surface === "public_comment" && !input.requestedFacts.length && customerPublicReaction(input.inputText ?? "");
  if (reaction && d.kind !== "propose") {
    const text = customerPublicReactionText(reaction, lang);
    return text.length <= input.maxOutputChars ? text : null;
  }
  if (input.surface === "public_comment" && d.social === "thank" && isCustomerPublicAppreciation(input.inputText ?? "")) {
    lines.push(customerPublicThanks(input.inputText!, lang));
  } else if (continuingRecruitment && d.social === "greet") lines.push(social.acknowledge[lang]);
  else if (social[d.social][lang]) lines.push(social[d.social][lang]);
  if (followRequest) lines.push(lang === "tg" ? "Ман худам ба сайт ё аккаунт обуна шуда наметавонам." : "Я не могу сам подписаться на сайт или аккаунт.");
  if (languagePermissionRequested) lines.push(lang === "tg" ? "Бале, албатта. Дар бораи худ ва таҷрибаатон ба тоҷикӣ нақл кунед." : "Да, конечно. Расскажите о себе и своём опыте на таджикском.");
  if (messengerChannelQuestion) lines.push(lang === "tg" ? "Метавонем ҳамин ҷо, дар ҳамин чат, идома диҳем." : "Можем продолжить здесь, в текущем чате.");
  const renderedFactLines = new Set<string>();
  const appendFacts = (value: Extract<CustomerAgentObservation, { kind: "facts" }>) => {
    const f = value.facts;
    const furnitureUnknown = lang === "tg"
      ? "Маълумоти тасдиқшуда нест, ки мебел бо объект дода мешавад ё ба нарх дохил аст."
      : "В подтверждённых данных не указано, останется ли мебель и входит ли она в стоимость.";
    const linesForFacts = furnitureOnly
      ? [...(f.availability === "SOLD" || f.availability === "RESERVED"
        ? factSegments({ ...value, kinds: ["availability"] }, lang, input.inputText) : []),
        ...(!furnitureAnswerIncluded ? [furnitureUnknown] : [])]
      : [...factSegments({ ...value, kinds: requestedKinds(value.kinds) }, lang, input.inputText),
        ...(furnitureQuestion && !furnitureAnswerIncluded ? [furnitureUnknown] : [])];
    if (furnitureQuestion) furnitureAnswerIncluded = true;
    for (const line of linesForFacts) {
      const implicitReserve = lang === "tg" ? "Объект ҳоло дар брон аст." : "Объект сейчас в брони.";
      const availability = f.availability === "RESERVED" &&
        (line === implicitReserve || line === customerPropertyAvailabilityLine(f, lang));
      const key = JSON.stringify([f.propertyId, f.signature, availability ? "availability" : "line", availability ? f.availability : line]);
      if (renderedFactLines.has(key)) continue;
      renderedFactLines.add(key); lines.push(line);
    }
  };
  for (const item of evidence) {
    if (!item) return null;
    if (item.value.kind === "facts") appendFacts(item.value);
    if (item.value.kind === "publication_properties") {
      const parsed = customerAgentPublicationObservationSchema.safeParse(item.value);
      if (!parsed.success || input.surface !== "public_comment") return null;
      if (parsed.data.cards.length > 1 && parsed.data.cards.every(card => card.availability === "SOLD")) {
        lines.push(lang === "tg" ? "Ҳамаи объектҳои ин интихоб фурӯхта шудаанд. Варианти монандро интихоб кунам?"
          : "Все объекты из этой подборки проданы. Подобрать похожие?");
        continue;
      }
      if (parsed.data.cards.length > 1) lines.push(lang === "tg" ? "Объектҳо аз ҳамин нашрия:" : "Объекты из этой публикации:");
      for (const facts of parsed.data.cards) {
        appendFacts({ kind: "facts", facts, kinds: parsed.data.kinds });
        if (parsed.data.linksAllowed !== false && parsed.data.cards.length > 1 && facts.publicLink) lines.push(facts.publicLink);
      }
    }
    if (item.value.kind === "property_unresolved") {
      const line = unresolvedPropertyLine(item.value, lang);
      if (line) lines.push(line);
    }
    if (item.value.kind === "receipt") lines.push(outcomes[item.value.outcome][lang]);
    if (item.value.kind === "proposal") lines.push(item.value.summary[lang]);
    if (item.value.kind === "company_policy") {
      if (!isPinnedCompanyPolicy(item.value, input.knowledgeSourceHash)) return null;
      lines.push(policySegment(item.value, lang));
    }
    if (item.value.kind === "company_information") {
      if (!isCustomerCompanyInformation(item.value)) return null;
      if (followRequest || languagePermissionOnly) continue;
      lines.push(...companyInformationLines(item.value, lang, input.inputText ?? ""));
    }
    if (item.value.kind === "open_vacancies") {
      if (!isCustomerVacanciesObservation(item.value)) return null;
      if (languagePermissionOnly) continue;
      // An actual saved application receipt answers a candidate's submission.
      // Reading the catalog to validate the role is not a request to repeat it.
      // Explicit questions about conditions still retain their verified answer.
      const ownQuestion = input.inputText ?? "";
      const explicitQuestion = /[?？]|(?:^|[\s.!])(?:сколько|какой|какая|какие|как|где|когда|чанд|кай|куҷо)(?:[\s?!]|$)/iu.test(ownQuestion);
      const currentPosition = item.value.collecting && item.value.positions.length
        ? recruitmentPositionForTurn(item.value.positions, { inputText: ownQuestion,
          mediaText: perception?.success ? [perception.data.transcript, perception.data.readableText].join("\n") : "",
          knownKey: input.verifiedContext?.publicState.jobPositionKey, turns: input.verifiedContext?.turns })
        : null;
      const alreadyPresented = input.surface === "dm" && d.kind !== "propose" && !!currentPosition &&
        recruitmentPositionPreviouslyPresented({ verifiedContext: input.verifiedContext, position: currentPosition });
      if ((applicationSaved || alreadyPresented) && !customerRecruitmentFactsRequested(ownQuestion) && !explicitQuestion) continue;
      if (!item.value.collecting) {
        // The switch is off: a different fact from an empty catalog, and it says so.
        lines.push(lang === "tg" ? "Қабули дархостҳои кор тавассути ин чат ҳоло ба роҳ монда нашудааст." : "Приём откликов через этот чат сейчас не ведётся.");
      } else if (!item.value.positions.length) {
        // A vacancy/topic from the ad that the catalog no longer holds is named as such.
        lines.push(input.verifiedContext?.publicState.jobPositionKey
          ? lang === "tg" ? "Барои ин ҷойи кор ҳоло қабули кушода тасдиқ нашудааст." : "По этой вакансии набор сейчас не подтверждён."
          : lang === "tg" ? "Ҳоло ҷойи кори кушода нест." : "Сейчас открытых вакансий нет.");
      } else {
        if (input.verifiedContext?.publicState.jobPositionKey && !item.value.positions.some(row => row.key === input.verifiedContext?.publicState.jobPositionKey)) {
          lines.push(lang === "tg" ? "Барои вазифа аз он эълон ҳоло қабули кушода тасдиқ нашудааст." : "По должности из этого объявления открытый набор сейчас не подтверждён.");
        }
        // Only publish the selected role's current staff-authored conditions;
        // another role's salary or old ad text is never substituted.
        const matched = recruitmentPositionForTurn(item.value.positions, { inputText: input.inputText,
          mediaText: perception?.success ? [perception.data.transcript, perception.data.readableText].join("\n") : "",
          knownKey: input.verifiedContext?.publicState.jobPositionKey, turns: input.verifiedContext?.turns });
        lines.push(lang === "tg" ? matched ? "Ҷойи кори кушода:" : "Ҷойҳои кори кушода:" : matched ? "Открыта вакансия:" : "Сейчас открыты вакансии:");
        for (const position of matched ? [matched] : item.value.positions.slice(0, 12)) lines.push(lang === "tg" ? position.titleTg : position.titleRu);
        if (!matched && item.value.positions.length > 12) lines.push(lang === "tg" ? `Ва боз ${item.value.positions.length - 12} вазифа. Соҳаи дилхоҳатонро нависед.`
          : `И ещё ${item.value.positions.length - 12} позиций. Напишите, какая работа вас интересует.`);
        if (matched) {
          const details = lang === "tg" ? matched.detailsTg : matched.detailsRu;
          if (details) {
            const paragraphs = customerRecruitmentReplyDetails(details, input.inputText ?? "");
            lines.push(paragraphs.join("\n\n"));
            experienceInvitationIncluded ||= containsRecruitmentExperienceInvitation(paragraphs);
          }
          else lines.push(lang === "tg" ? "Шартҳои муфассали ин вазифа ҳоло нашр нашудаанд." : "Подробные условия этой должности пока не опубликованы.");
        }
      }
    }
    if (item.value.kind === "property_search") {
      if (!isPublicPropertySearch(item.value)) return null;
      lines.push(...searchSegments(item.value, lang));
    }
    if (item.value.kind === "agency_contact") {
      if (!isCanonicalAgencyContact(item.value)) return null;
      if (requestedContact) lines.push(`${lang === "tg" ? "Занг занед" : "Позвоните"}: ${item.value.contact.phone}.`);
    }
  }
  if (furnitureQuestion && !furnitureAnswerIncluded) lines.push(lang === "tg"
    ? "Маълумоти тасдиқшуда нест, ки мебел бо объект дода мешавад ё ба нарх дохил аст."
    : "В подтверждённых данных не указано, останется ли мебель и входит ли она в стоимость.");
  const attachmentOnly = input.surface === "dm" && input.verifiedContext?.publicState.topic !== "job" && input.inputText !== undefined && !input.inputText.trim() && !!input.attachmentInput && !perception;
  if (attachmentOnly) {
    const attachment = customerAgentAttachmentInputSchema.safeParse(input.attachmentInput);
    if (!attachment.success || d.kind !== "clarify" || d.social !== "none" || d.question !== "clarify_previous" ||
        evidence.some(e => e?.value.kind !== "facts")) return null;
    lines.push(customerAgentAttachmentQuestion(attachment.data, lang, evidence.some(e => e?.value.kind === "facts")));
    const text = lines.filter(Boolean).join("\n");
    return text && text.length <= input.maxOutputChars ? text : null;
  }
  const question = followRequest || languagePermissionOnly || furnitureOnly ? "none"
    : customerAgentRenderedQuestion({ ...input, ...material, evidence: evidence.filter((e): e is CustomerAgentEvidence => !!e) });
  const intake = intakeProgress(input);
  // Suppress only the redundant/private question, preserve useful verified
  // facts or a local receipt. No whole-answer erasure or invented success.
  // Explicit facts are useful before any questionnaire. One question can be
  // chosen after the facts, but an unresolved property cannot ask for a phone.
  const requiredFact = question === "job_required" ? recruitmentNextFact({ ...input, ...material }) : undefined;
  // The résumé is asked once: not after a document/photo/own account, and not a second time.
  const aboutHandled = (question === "job_experience" || requiredFact === "about") && input.surface !== "public_comment" &&
    (experienceInvitationIncluded || recruitmentAboutHandled({ ...input, ...material }));
  if (question !== "none" && question !== "confirmation" && !aboutHandled) lines.push(question === "property" &&
      evidence.some(e => e?.value.kind === "publication_properties" && e.value.cards.length > 1)
    ? lang === "tg" ? "Кадоме аз ин объектҳо ба шумо писанд омад?" : "Какой из этих объектов вас заинтересовал?"
    : input.surface === "public_comment" && question.startsWith("job_")
      ? publicRecruitmentQuestion(requiredFact === "about" ? "job_experience" : question, lang, experienceInvitationIncluded)
    : question === "job_required" && requiredFact ? recruitmentRequiredQuestion(requiredFact, lang)
    : question === "seller_details" && input.surface === "dm" && intake.role === "seller"
      ? customerSellerIntakeQuestion(intake.sellerKnown, lang)
    : question === "clarify_previous" && input.surface === "dm"
      ? repairPreviousQuestion(input.verifiedContext, lang) ?? questions[question][lang] : questions[question][lang]);
  if (question === "confirmation") lines.push(lang === "tg" ? "Тасдиқ мекунед?" : "Подтверждаете?");
  if (!evidence.length && question === "none" && d.social === "none" && !visualSummary && !followRequest && !languagePermissionRequested && !messengerChannelQuestion && !furnitureQuestion) return null;
  // A suppressed personal-data request by itself is not a useful completed
  // reply, even if the model attached "Понял" to it.
  if ((publicContactQuestion || (d.kind !== "propose" && d.question === "phone" && input.knownPhoneSource !== "none")) &&
      !evidence.length && question === "none") return null;
  const text = lines.filter(Boolean).join("\n");
  // Never truncate a monetary value, receipt or critical proposal summary.
  return text && text.length <= input.maxOutputChars ? text : null;
}
