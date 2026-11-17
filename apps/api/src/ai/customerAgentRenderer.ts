import { createHash } from "node:crypto";
import type { CustomerPropertyFactKind, CustomerPropertyFacts, CustomerMutationReceipt,
  CustomerAgentDecision, CustomerAgentQuestion, CustomerAgentSurface, CustomerAgentVerifiedContext, CustomerAgentApprovedFileState } from "@royal-home/shared";
import { customerPropertyCharacteristicLines, customerPropertyAvailabilityLine, customerAgentPublicationObservationSchema } from "@royal-home/shared";
import { PUBLIC_AGENCY_CONTACT } from "../lib/publicAgencyContact.js";
import { customerPublicThanks, customerRequestedAgencyContact, customerRecruitmentLanguagePermissionQuestion,
  customerRecruitmentLanguagePermissionRequested, customerFollowRequest, customerStandaloneFurnitureQuestion,
  customerFurnitureQuestionRequested, customerMessengerChannelQuestion, isCustomerPublicAppreciation,
  customerPublicReaction, customerPublicReactionText } from "./customerAgentConversationPolicy.js";
import { customerAgentIntake, customerSellerIntakeQuestion, customerSellerIntakeQuestionLines } from "./customerAgentIntake.js";
import { buyerNeedsKnown, buyerNextQuestion, overlayBuyerNeeds, type BuyerNeedKey } from "./customerBuyerNeeds.js";
import { customerRecruitmentRequested, customerRecruitmentFactsRequested, isCustomerVacanciesObservation, recruitmentPositionForTurn,
  recruitmentMissingForTurn, recruitmentRequiredQuestion, recruitmentFactQuestionLines } from "./customerAgentRecruitmentProtocol.js";
import { customerDmAbuseKind, customerDmAbuseReply, customerDmAbuseLines, customerDmForeignShareNoise } from "./customerAgentAbuse.js";
import { recruitmentPhoneLine, retiredRecruitmentPhoneLines } from "@royal-home/shared";
import { clientOwnWords } from "./untrustedContent.js";
import { validateCustomerAgentSayForDecision } from "./customerAgentSay.js";
import { validateCustomerAgentAnswer, type CustomerAgentAnswerVerdict, type CustomerAgentAnswerTemplate } from "./customerAgentAnswer.js";
import { CUSTOMER_AGENT_ASK_KINDS, withoutAgreementOpenings, humanPhraseGroups, type CustomerAgentAskKind, type HumanPhraseGroup } from "./customerAgentHumanText.js";
import { BW, EW, TAIL } from "./wordBoundary.js";
import { customerCheaperVisibleCards, isCheaperThanSearch } from "./customerAgentCheaperCards.js";
import { customerAsksPricePerSqm, pricePerSqmLine } from "../lib/customerPropertyPerSqm.js";
import type { CustomerPropertyUnresolvedReason } from "../lib/customerPropertyUnresolvedReason.js";
import { customerCallbackConsentDecision } from "../lib/customerCallbackConsent.js";
import { customerAgentAttachmentInputSchema, customerAgentAttachmentQuestion, customerAgentAttachmentLines, customerAgentShareNotice,
  BUSINESS_QUESTION, type CustomerAgentAttachmentInput } from "./customerAgentAttachmentInput.js";
import { customerAgentMediaPerceptionSchema, customerAgentVisualSummary, type CustomerAgentMediaPerception } from "./customerAgentMediaPerception.js";
import { isPinnedCompanyPolicy, isPublicPropertySearch, isCustomerCompanyInformation, type CustomerAgentCompanyPolicyObservation,
  type CustomerAgentSearchObservation } from "./customerAgentPublicProtocol.js";
import { customerStaffFollowUpLine, customerStaffFollowUpFixedLines, customerThanksOnly, customerThanksReply, customerTradeInQuestion,
  customerPartnershipOffer, customerPartnershipReply, customerCommissionAmountLine, customerSearchHandOffLine, customerPhoneAskLines,
  PHONE_ASK_TEXT, CUSTOMER_SELLER_WORDS, type FollowUpMemory } from "./customerAgentStaffFollowUp.js";
import { detectOutsideCoverage } from "./coverageGuard.js";
import { customerReplyLink } from "../lib/customerReplyLink.js";
import { serviceAreaBuyerOffer, serviceAreaIn } from "../lib/serviceArea.js";
import { stripBannedWords } from "./bannedWordsGuard.js";
import { customerRecruitmentFollowUp, recruitmentFollowUpLine, recruitmentFollowUpFixedLines, RETIRED_TEMPLATE_LINES, AD_OPEN_QUESTION,
  customerAdOpening, customerGreetingLine, customerAlreadyGreeted, customerLegalAsked, customerRentalAsked, customerInputHasLink,
  customerSubstantiveInput, GREETING_REPLY_LINES, RECEIPT_AGAIN } from "./customerAgentLiveWording.js";

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
/** Digest of one sent line for the repeat memory (CustomerAgentVerifiedContext.sentLineDigests).
 * Whitespace-insensitive and case-insensitive; the text itself never leaves the loader. */
export function customerAgentLineDigest(line: string): string {
  return createHash("sha256").update(line.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase()).digest("hex").slice(0, 32);
}
/** The bot already sent this exact line in this conversation: the bounded memory turns or the wider digest memory. */
function lineSentBefore(context: CustomerAgentVerifiedContext | undefined, line: string): boolean {
  if (!context || context.surface !== "dm") return false;
  const digest = customerAgentLineDigest(line);
  return !!context.sentLineDigests?.includes(digest) ||
    context.turns.some(turn => turn.role === "assistant" && splitLines(turn.text).some(sent => customerAgentLineDigest(sent) === digest));
}
/** Noza's number (current or retired wording) was already sent in this conversation: it is not sent again (audit 16.11.2026). */
function recruitmentPhoneSaidBefore(context: CustomerAgentVerifiedContext | undefined): boolean {
  return [recruitmentPhoneLine("ru"), recruitmentPhoneLine("tg"), ...retiredRecruitmentPhoneLines()].some(line => lineSentBefore(context, line));
}
/** The ad button or a bare greeting, nothing of the customer's own and no object in hand: the opening question is asked. */
const OPENING_QUESTIONS: readonly string[] = ["property", "topic", "role", "clarify_previous", "budget", "location", "rooms", "seller_details", "preferences", "none"];
function adOpeningTurn(input: { surface: CustomerAgentSurface; decision: CustomerAgentDecision; evidence: readonly CustomerAgentEvidence[];
  inputText?: string; verifiedContext?: CustomerAgentVerifiedContext; attachmentInput?: unknown; mediaPerception?: unknown }): boolean {
  return input.surface === "dm" && input.decision.kind !== "propose" && !customerInputHasLink(input.inputText) &&
    !input.evidence.some(e => e.value.kind === "facts" || e.value.kind === "publication_properties" || e.value.kind === "receipt" ||
      e.value.kind === "open_vacancies" && "refs" in input.decision && input.decision.refs.includes(e.ref)) &&
    customerAdOpening(input);
}
const VACANCY_LIST_HEADERS = ["Сейчас открыты вакансии:", "Открыта вакансия:", "Ҷойҳои кори кушода:", "Ҷойи кори кушода:"];
/** The vacancy list (its header and at least one of the current titles) was already sent in this conversation. */
function vacancyListSentBefore(context: CustomerAgentVerifiedContext | undefined, positions: readonly { titleRu: string; titleTg: string }[]): boolean {
  return VACANCY_LIST_HEADERS.some(header => lineSentBefore(context, header)) &&
    positions.some(position => lineSentBefore(context, position.titleRu) || lineSentBefore(context, position.titleTg));
}
export type CustomerAgentRenderedQuestion = CustomerAgentQuestion | "confirmation";
/** What the candidate's CURRENT message carried beyond its caption: the readable text of a
 * document/photo (OCR is untrusted candidate material, used only to see which facts are
 * already given) and whether a document/photo/own account of themselves was received at all. */
interface RecruitmentMaterial { mediaText?: string; materialReceived?: boolean; applicationSaved?: boolean }
const JOB_ONLY_QUESTIONS: readonly string[] = ["job_position", "job_required", "job_experience", "job_portfolio", "job_tools", "job_format", "job_start"];
// With nothing to apply to, neither a job nor a property questionnaire is asked; a name, a contact or the topic still is.
const NO_OPENING_SUPPRESSED: readonly string[] = [...JOB_ONLY_QUESTIONS, "property", "budget", "budget_currency", "location", "rooms", "role", "seller_details", "preferences"];
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
      // Phone-only presentation (owner 10–11.11.2026): the role plus the specialist's number.
      if ([recruitmentPhoneLine("ru"), recruitmentPhoneLine("tg"), ...retiredRecruitmentPhoneLines()].some(line => turn.text.includes(line))) return true;
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
const lastAssistantText = (context: CustomerAgentVerifiedContext | undefined) => {
  const last = context?.turns.at(-1);
  return last?.role === "assistant" ? last.text : undefined;
};
function intakeProgress(input: { verifiedContext?: CustomerAgentVerifiedContext; inputText?: string }) {
  const prior = input.verifiedContext?.intake;
  const recent = customerAgentIntake(prior ? [] : input.verifiedContext?.turns ?? [], input.inputText, prior?.role, lastAssistantText(input.verifiedContext));
  if (!prior || recent.role !== "unknown" && recent.role !== prior.role) return recent;
  // The summary kept by the server (the whole inquiry) and this turn's own words: the later correction wins, nothing named is lost.
  const buyerNeeds = overlayBuyerNeeds(prior.buyerNeeds, recent.buyerNeeds);
  return { role: prior.role, sellerKnown: [...new Set([...prior.sellerKnown, ...recent.sellerKnown])],
    buyerKnown: [...new Set([...prior.buyerKnown, ...recent.buyerKnown, ...buyerNeedsKnown(buyerNeeds)])], ...(buyerNeeds ? { buyerNeeds } : {}) };
}
/** What the object the customer is asking about already tells: its rooms and its district make those two wishes known (a buyer who
 * asks about «ID 123» is not asked «Сколько комнат вам нужно?»). Only a live, referenced card; a sold one says nothing. */
function cardAnchoredKnown(evidence: readonly CustomerAgentEvidence[], refs: readonly string[]): BuyerNeedKey[] {
  const facts = evidence.filter(e => refs.includes(e.ref)).flatMap(e =>
    e.value.kind === "facts" ? [e.value.facts] : e.value.kind === "publication_properties" ? e.value.cards : [])
    .filter(card => card.availability !== "SOLD");
  if (facts.length !== 1) return [];
  const [card] = facts;
  return [...(card.publicAddress ? ["location" as const] : []), ...(card.characteristics?.rooms ? ["rooms" as const] : [])];
}
export function customerAgentRenderedQuestion(input: { decision: CustomerAgentDecision; evidence: readonly CustomerAgentEvidence[];
  surface: CustomerAgentSurface; knownPhoneSource: "none" | "current_input" | "scoped_contact"; requestedFacts?: readonly CustomerPropertyFactKind[];
  verifiedContext?: CustomerAgentVerifiedContext; inputText?: string; approvedFileState?: CustomerAgentApprovedFileState;
  attachmentInput?: unknown; mediaPerception?: unknown } & RecruitmentMaterial): CustomerAgentRenderedQuestion {
  const d = input.decision;
  if (d.kind === "skip" || d.kind === "escalate" || d.kind === "moderation_proposal") return "none";
  if (d.kind === "propose") return "confirmation";
  // The ad button with nothing of the customer's own (audit 16.11.2026): the live opening question is about the topic.
  if (adOpeningTurn(input) && OPENING_QUESTIONS.includes(d.question)) return "topic";
  // The same cases renderCustomerAgentDecision answers without a questionnaire question (15.11.2026): the stored open
  // question must match what the customer actually read.
  if (input.surface === "dm") {
    const text = input.inputText ?? "";
    const acted = input.evidence.some(e => e.value.kind === "receipt" || e.value.kind === "proposal");
    if (!acted && (customerThanksOnly(text) || customerPartnershipOffer(text))) return "none";
    if (customerTradeInQuestion(text)) return "none";
    const referenced = input.evidence.filter(e => d.refs.includes(e.ref));
    if (referenced.some(e => e.value.kind === "company_policy" && e.value.topic === "service_scope" && !e.value.knowledge.otherCities) &&
        customerObjectOutsideArea(input)) return "none";
    if (referenced.some(e => e.value.kind === "property_search" && searchNeedsAgent(e.value))) return "none";
  }
  if (input.surface === "dm" && d.kind === "reply" && d.attachment === "buyer_guide" && input.approvedFileState === "needs_follow") return "none";
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
    if (openings.length && ["property", "budget", "budget_currency", "location", "rooms", "role", "topic", "seller_details", "preferences", ...JOB_ONLY_QUESTIONS, "name", "phone"].includes(d.question)) {
      // Phone-only recruitment (owner 10–11.11.2026): the bot names the role and gives the
      // specialist's number; it asks no questionnaire questions and discusses no conditions.
      return "none";
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
    // One «what is still unknown» for a buyer: what the customer said (the whole inquiry + this message) plus what the asked-about object says.
    if (intake.role === "buyer" && (d.question === "rooms" || d.question === "budget" || d.question === "location")) {
      // The object card counts only for someone who has already said they are buying (a price question alone does not make the customer's wishes known).
      const known = intake.role === "buyer" ? [...new Set([...intake.buyerKnown, ...cardAnchoredKnown(input.evidence, d.refs)])] : [];
      // «до 60 тысяч»: the amount is known, the currency is not. Ask THAT once, not the budget again (not twice in a row either).
      const budget = intake.role === "buyer" && "buyerNeeds" in intake ? intake.buyerNeeds?.budget : undefined;
      const askedLines = (lastAssistantText(input.verifiedContext) ?? "").split("\n").map(line => line.trim());
      if (d.question === "budget" && budget && !budget.currency && !askedLines.includes(questions.budget_currency.ru) && !askedLines.includes(questions.budget_currency.tg)) return "budget_currency";
      if (known.includes(d.question)) return buyerNextQuestion(known);
    }
  }
  return d.question;
}

/** A customer from our ad that names no single object: one short human question instead of "which object?". */
const AD_INTEREST_QUESTION = { ru: "Подскажите, пожалуйста, что вас интересует?", tg: "Чӣ хизмат кунам?" } as const;
const questions: Record<CustomerAgentQuestion, { ru: string; tg: string }> = {
  none: { ru: "", tg: "" },
  property: { ru: "Какой объект вы имеете в виду? Пришлите номер объекта или ссылку.", tg: "Шумо кадом объектро дар назар доред? Рақами объект ё пайвандашро фиристед." },
  budget: { ru: "Какой бюджет вы рассматриваете?", tg: "Чӣ қадар маблағ дар назар доред?" },
  budget_currency: { ru: "Эта сумма в долларах или в сомони?", tg: "Ин маблағ доллар аст ё сомонӣ?" },
  location: { ru: "Какой район вам подходит?", tg: "Кадом тарафи шаҳрро мехоҳед?" },
  rooms: { ru: "Сколько комнат вам нужно?", tg: "Чанд ҳуҷра?" },
  name: { ru: "Как к вам обращаться?", tg: "Номи шумо чист?" },
  phone: { ru: "Какой номер телефона вы хотите оставить для связи?", tg: "Рақами телефонатонро нависед, то агенти мо занг занад." },
  callback_consent: { ru: "Вы хотите, чтобы сотрудник вам позвонил?", tg: "Мехоҳед корманд ба шумо занг занад?" },
  topic: { ru: "Вы хотите узнать о недвижимости или о работе?", tg: "Шумо дар бораи амвол маълумот мехоҳед ё дар бораи кор?" },
  role: { ru: "Вы хотите купить или продать недвижимость?", tg: "Шумо хона мехаред ё мефурӯшед?" },
  clarify_previous: { ru: "Что пояснить подробнее?", tg: "Чиро пурратар фаҳмонам?" },
  seller_details: { ru: "Расскажите о недвижимости, которую хотите продать.", tg: "Дар бораи хонае, ки фурӯхтан мехоҳед, нависед." },
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
  unsupported: null,
  untrusted_origin: null,
  not_found: { ru: "По этой ссылке или номеру объект не нашёлся.", tg: "Аз рӯи ин пайванд ё рақам объект ёфт нашуд." },
  // The customer came from our ad that is not tied to one object: no "the object was not determined"
  // line (13.11.2026, read as a robot); the question below asks what they are interested in, once.
  ad_unmapped: null,
  lookup_unavailable: null,
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
/** Every fixed question sentence (plain template and "я уточнял" repair) with its purpose. Read-only view for the attack judge. */
export function customerAgentQuestionCatalog(language: "ru" | "tg"): Array<{ question: CustomerAgentQuestion; text: string }> {
  return [...Object.entries(questions).flatMap(([question, text]) => text[language] ? [{ question: question as CustomerAgentQuestion, text: text[language] }] : []),
    ...Object.entries(repairs).map(([question, text]) => ({ question: question as CustomerAgentQuestion, text: text[language] }))];
}
// Formatting of already minimized server-loaded context only. This selects no
// actor, contact, action, proposal or consent; callers still fence the original IN.
const repairPurposes = ["budget", "location", "rooms", "property", "topic", "role"] as const;
const repairs: Record<typeof repairPurposes[number], { ru: string; tg: string }> = {
  budget: { ru: "Я уточнял сумму для покупки. Какой у вас бюджет?", tg: "Ман буҷети барои харид пешбиникардаи шуморо мепурсидам. Чӣ қадар маблағ дар назар доред?" },
  location: { ru: "Я уточнял район для поиска. Какой район вам подходит?", tg: "Ман ноҳияро барои ҷустуҷӯ мепурсидам. Кадом ноҳия ба шумо мувофиқ аст?" },
  rooms: { ru: "Я уточнял количество комнат. Сколько комнат вам нужно?", tg: "Ман шумораи ҳуҷраҳоро мепурсидам. Чанд ҳуҷра лозим аст?" },
  property: { ru: "Подскажите номер объекта или пришлите ссылку, и я всё расскажу.", tg: "Рақами объект ё пайвандашро фиристед." },
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
  none: { ru: "", tg: "" }, greet: { ru: "Здравствуйте!", tg: "Ассалому алайкум!" },
  thank: { ru: "Спасибо!", tg: "Ташаккур!" }, acknowledge: { ru: "Понял.", tg: "Фаҳмидам." },
  apologize: { ru: "Извините.", tg: "Бубахшед." },
};
const outcomes: Record<CustomerReceiptOutcome, { ru: string; tg: string }> = {
  // Human words, not log lines (audit 16.11.2026: «Маълумот ба дархости кор илова шуд.» five times in one chat).
  job_application_saved: { ru: "Спасибо, записал.", tg: "Ташаккур, қайд кардам." },
  contact_saved: { ru: "Спасибо, записал.", tg: "Ташаккур, қайд кардам." },
  callback_requested: { ru: "Спасибо, заявку на звонок принял.", tg: "Ташаккур, дархости шумо қабул шуд." },
  new_lead_created: { ru: "Спасибо, ваша заявка принята.", tg: "Ташаккур, дархости шумо қабул шуд." },
  handover_requested: { ru: "Спасибо, передал ваше сообщение сотруднику.", tg: "Ташаккур, дархости шумо қабул шуд." },
  showing_booked: { ru: "Запись на показ создана.", tg: "Дархост барои тамошо сабт шуд." },
  showing_rescheduled: { ru: "Время записи на показ изменено.", tg: "Вақти сабти тамошо иваз шуд." },
  showing_cancelled: { ru: "Запись на показ отменена.", tg: "Сабти тамошо бекор шуд." },
  owner_question_recorded: { ru: "Вопрос собственнику сохранён.", tg: "Савол ба соҳибмулк сабт шуд." },
};
/** The approved «I passed your message to a colleague» line of the core (receipt wording), for channels that hand a turn to
 *  a person without a write tool of their own (lib/customerChannelCore.ts). The same words as the Meta handover receipt. */
export function customerAgentHandoverLine(language: "ru" | "tg"): string {
  return outcomes.handover_requested[language];
}
function factSegments(value: Extract<CustomerAgentObservation, { kind: "facts" }>, language: "ru" | "tg", question = "", numbered = true): string[] {
  const f = value.facts, tg = language === "tg", result: string[] = [];
  if (f.availability === "SOLD") return [customerPropertyAvailabilityLine(f, language)];
  for (const kind of new Set(value.kinds)) {
    if (kind === "price") {
      const amount = f.price?.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
      const money = amount ? `${amount} ${f.currency === "USD" ? tg ? "доллар" : "USD" : tg ? "сомонӣ" : "сомони"}` : null;
      // Tajik as the phrasebook says it (live-agent-phrases: «Нархаш {цена} сомонӣ.», «Нархаш {цена} доллар аст.»).
      // Two prices in one reply must say whose (review #206 С3): «Объекти №191: нархаш … доллар аст.», bare under a list header.
      const tgPrice = `${money}${f.currency === "USD" ? " аст" : ""}.`;
      result.push(money ? tg ? numbered ? `Объекти №${f.shortId}: нархаш ${tgPrice}` : `Нархаш ${tgPrice}` : `Цена объекта №${f.shortId}: ${money}.`
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
    : tg ? "Мутаассифона, мо бо иҷора кор намекунем." : "Сейчас арендой не занимаемся: не сдаём и не подбираем в аренду.";
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
  // Comments: the area only, never "other cities" unprompted (audit 16.11.2026, Б3: a seller's ad got "Другие города не обслуживаем").
  const area = serviceAreaIn(k.city, language);
  return tg ? `Барои хариду фурӯши хона ${area} кӯмак мекунем.` : `Помогаем с покупкой и продажей недвижимости ${area}.`;
}
/** The customer asks about the work area itself ("в каком городе", "дар шаҳрҳои дигар"). */
const CITY_QUESTION = /в\s+как(?:ом|их)\s+город|други[хе]\s+город|в\s+регион|по\s+всему\s+таджикистан|кадом\s+ша[ҳх]р|ша[ҳх]р[ҳх]?ои\s+дигар|дигар\s+ша[ҳх]р|вилоят|только\s+(?:в\s+)?душанбе|танҳо\s+(?:дар\s+)?душанбе/iu;
/**
 * The service-area answer (15.11.2026, prod: 13 times in 7 days "Дар шаҳрҳои дигар кор намекунем" was said again to a seller
 * whose flat is IN Dushanbe — "Хона дар Душанбе аст", "Ман да Душанбе"). "Other cities" is said only when the customer named
 * a place outside the city (then it is a short apology, and nothing else is asked) or asked about the area. The area line
 * itself is said once per conversation; a sentence already said is not said again.
 */
/** The customer buys (then a home town elsewhere is no reason to refuse: coverageGuard calls him "our best client"). */
const BUYER_WORDS = /харид|мехарам|харам|харидан|купить|куплю|покупа|ищу|меҷӯям|мечуям|мекобам/u;
/**
 * The OBJECT is outside the city (review #201, В2): a seller (the questionnaire or his own words) names a place outside
 * the city as where the property is ("дар/в Қайроққум"), and Dushanbe was never named by the customer in this chat.
 * "Ман аз Хуҷанд ҳастам, хона мехарам" (a buyer from elsewhere) is our client, never refused. Rudaki stays the model's
 * matter (owner 15.11.2026: "Да, Рудаки берём"; lib/serviceArea.ts): coverageGuard never reports it as outside.
 */
function customerObjectOutsideArea(input: { inputText?: string; verifiedContext?: CustomerAgentVerifiedContext }): "seller" | "buyer" | null {
  const current = clientOwnWords(input.inputText ?? "").toLowerCase().replace(/ё/gu, "е");
  const history = (input.verifiedContext?.turns ?? []).filter(turn => turn.role === "user").map(turn => clientOwnWords(turn.text)).join("\n");
  const all = `${history}\n${current}`.toLowerCase();
  const hit = detectOutsideCoverage(current);
  if (!hit || !detectOutsideCoverage(all)) return null;
  const seller = intakeProgress(input).role === "seller" || CUSTOMER_SELLER_WORDS.test(all);
  // Покупатель, который ищет ВНЕ зоны («дар Ваҳдат мехарам»), — тот же ответ и предложение зоны (владелец 16.11.2026:
  // «Загород не берём»). Покупатель ИЗ другого города («аз Хуҷанд») — наш клиент: «аз/из» перед местом ниже не отказ.
  const buyerWords = BUYER_WORDS.test(all);
  // Продавец, который и покупает («продам и куплю»), — как раньше, не отказ.
  if (seller && buyerWords) return null;
  const buyer = !seller && buyerWords;
  if (!seller && !buyer) return null;
  const at = current.indexOf(hit.place.toLowerCase());
  const before = at >= 0 ? current.slice(Math.max(0, at - 30), at) : "";
  const inPlace = /(?:^|[\s,])(?:дар|в|во)(?:\s+\S+){0,2}\s*$/u.test(before) && !/(?:^|[\s,])(?:аз|из)\s*$/u.test(before);
  // «Я живу в Худжанде, хочу купить» — место жительства, а не место покупки: не отказ.
  if (/(?:жив[уеё]|прожива|зиндаг|истиқомат|истикомат)\S*\s+\S*\s*$/iu.test(before)) return null;
  return inPlace ? (seller ? "seller" : "buyer") : null;
}
function serviceScopeLines(value: CustomerAgentCompanyPolicyObservation, language: "ru" | "tg", input: { inputText?: string;
  verifiedContext?: CustomerAgentVerifiedContext }, saidBefore: (line: string) => boolean): { lines: string[]; outside: boolean } {
  const k = value.knowledge, tg = language === "tg";
  const own = clientOwnWords(input.inputText ?? "");
  // The owner's area is Dushanbe AND the Rudaki district (audit 16.11.2026, Ф1); a buyer looking outside hears the offer (#204).
  const where = serviceAreaIn(k.city, language);
  const outsideRole = k.otherCities ? null : customerObjectOutsideArea(input);
  if (outsideRole) return { outside: true, lines: [(tg
    ? `Мутаассифона, мо танҳо ${where} кор мекунем.` : `К сожалению, мы работаем только ${where}.`) +
    (outsideRole === "buyer" ? ` ${serviceAreaBuyerOffer(language)}` : "")] };
  const asked = CITY_QUESTION.test(own);
  const area = tg ? `Барои хариду фурӯши хона ${where} кӯмак мекунем.` : `Помогаем с покупкой и продажей недвижимости ${where}.`;
  const other = k.otherCities ? "" : tg ? " Дар шаҳрҳои дигар кор намекунем." : " Другие города не обслуживаем.";
  if (asked) return { outside: false, lines: [area + other] };
  // Строка до 16.11.2026 (без района Рудаки) в старых переписках — тоже «уже сказано»: второй раз зону не повторяем.
  const legacyArea = tg ? `Барои хариду фурӯши амвол дар ${k.city} кӯмак мекунем.` : `Помогаем с покупкой и продажей недвижимости в городе ${k.city}.`;
  const said = [area, area + other, legacyArea, legacyArea + other].some(saidBefore);
  return { outside: false, lines: said ? [] : [area] };
}
// Word-bounded so "участок" is not "час" and "суроға" is an address question (not hours).
const word = (alternatives: string) => new RegExp(`${BW}(?:${alternatives})${EW}`, "iu");
const HOURS_QUESTION = word(`час(?:ы|ов|ам|ах|а)?|график${TAIL}|режим${TAIL}|соат${TAIL}|когда|скольки|кай|аз\\s+кай|то\\s+кай`);
const OFFICE_QUESTION = word(`где|адрес${TAIL}|офис${TAIL}|дафтар${TAIL}|идора${TAIL}|суроға${TAIL}|куҷо${TAIL}|кучо${TAIL}`);
// "ҳаққи хизмат" is the commission topic, not a question about the services list.
const SERVICES_QUESTION = word(`какие\\s+(?:у\\s+вас\\s+)?услуг${TAIL}|какими\\s+услугами|чем\\s+(?:вы\\s+)?занимаетесь|чем\\s+занимается\\s+(?:ваша\\s+)?(?:компания|агентство)|(?<!ҳаққи\\s)хизматҳо${TAIL}|кадом\\s+хизмат${TAIL}|шумо\\s+чӣ\\s+кор\\s+мекунед`);
export function customerCompanyServicesRequested(text: string): boolean { return SERVICES_QUESTION.test(clientOwnWords(text)); }
const SERVICES_TG: Record<string, string> = { "Продажа и помощь в покупке": "фурӯш ва кӯмак дар харидани амвол" };
/** Wider than the automatic-read gate: any office/hours/services word counts as an agency question for what may be PRINTED. */
function companyInformationAsked(text: string): boolean {
  const own = clientOwnWords(text);
  return customerCompanyInformationRequested(text) || OFFICE_QUESTION.test(own) || HOURS_QUESTION.test(own) || SERVICES_QUESTION.test(own);
}
export function customerCompanyInformationRequested(text: string): boolean {
  // Automatic reads need an explicit agency question. A commercial property,
  // appointment deadline or quoted publication is not our office/schedule.
  // Ambiguous questions remain available to the model's normal read tools.
  const own = clientOwnWords(text).trim();
  // "сожгу ваш офис" names the office but asks nothing about it.
  if (customerDmAbuseKind(own)) return false;
  const agencyLocation = /ваш(?:его|ем|им)?\s+офис|офис[ае]?\s+(?:ваш|агентств|royal\s*home)|адрес\s+агентства|где\s+вы\s+находитесь|как\s+к\s+вам\s+(?:добраться|пройти|проехать|доехать|попасть)|(?:дафтари|идораи)\s+шумо|суроғаи\s+(?:шумо|агент)/iu;
  const agencyHours = /когда\s+(?:вы\s+)?работаете|до\s+скольки\s+(?:вы\s+)?работаете|во\s+сколько\s+(?:вы\s+)?открываетесь|ваш(?:и|е|его)?\s+(?:часы|график|режим)\s+работы|у\s+вас\s+(?:часы|время|график|режим)\s+работы|(?:график|режим)\s+работы\s+(?:у\s+вас|вашего\s+(?:офиса|агентства)|офиса|агентства)|соат[иҳое]*\s+кор(?:иатон|и\s+шумо)/iu;
  const standaloneHours = /^(?:(?:какие\s+)?часы\s+работы|(?:какой\s+)?(?:график|режим)\s+работы|соат[иҳое]*\s+кори?(?:\s+чанд)?)[?.!\s]*$/iu;
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
/** Nothing to show from this search (not "cheaper"): an agent searches by hand. */
function searchNeedsAgent(value: CustomerAgentSearchObservation): boolean {
  return !customerCheaperVisibleCards(value).length && !isCheaperThanSearch(value.query);
}
function searchSegments(value: CustomerAgentSearchObservation, language: "ru" | "tg"): string[] {
  const tg = language === "tg";
  const cards = customerCheaperVisibleCards(value);
  if (!cards.length) return [isCheaperThanSearch(value.query)
    ? tg ? "Вариантҳои арзонтар ҳоло ёфт нашуданд." : "Вариантов дешевле сейчас не нашлось."
    // Everything that fits was already sent in this inquiry (the read excluded it): no "nothing found".
    // 15.11.2026 (review #201): no "сотрудник позвонит" without a phone; the hand-off (and the phone question) follows in renderDecisionCore.
    : value.query.nextPage
      ? tg ? "Вариантҳои нав аз рӯи ин дархост ҳоло нестанд." : "Новых вариантов по этому запросу сейчас нет."
    : tg ? "Дар интихоби ҷорӣ варианти мувофиқ ёфт нашуд." : "В текущей подборке подходящих вариантов не найдено."];
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
  for (const [index, card] of cards.entries()) {
    lines.push(`${index + 1}. ${tg ? "Объект" : "Объект"} №${card.facts.shortId}`);
    lines.push(...factSegments({ kind: "facts", facts: card.facts, kinds: ["price", "address"] }, language, "", false));
    if (card.listing.rooms !== null && card.listing.type === "APARTMENT") lines.push(tg ? `Ҳуҷраҳо: ${card.listing.rooms}.` : `Комнат: ${card.listing.rooms}.`);
    if (card.facts.characteristics) lines.push(...customerPropertyCharacteristicLines(card.facts.characteristics, language,
      language === "tg" ? "масоҳат ошёна таъмир" : "площадь этаж ремонт"));
    if (card.match.notes.length) lines.push(`${tg ? "Эзоҳ" : "Примечание"}: ${card.match.notes.map(note => notes[note][language]).join("; ")}.`);
    const link = customerReplyLink(card.facts.publicLink, value.linksAllowed);
    if (link) lines.push(link);
  }
  return lines;
}

export function customerBuyerGuideFollowText(language: "ru" | "tg"): string {
  return language === "tg"
    ? "Ин файл барои обуначиёни саҳифа дастрас аст. Обуна шавед ва ҳамин ҷо нависед."
    : "Этот файл доступен подписчикам страницы. Подпишитесь и напишите здесь.";
}

/** No model prose can invent an amount, date, contact or completed action.
 * Public observations/receipts are supplied by server ports; this rendering
 * itself confers no authority, physical send or proposal-presentation proof. */
function renderDecisionCore(input: {
  decision: CustomerAgentDecision; evidence: readonly CustomerAgentEvidence[]; language: "ru" | "tg";
  requestedFacts: readonly CustomerPropertyFactKind[]; knownPhoneSource: "none" | "current_input" | "scoped_contact";
  maxOutputChars: number; surface: CustomerAgentSurface; knowledgeSourceHash?: string;
  /** Server-loaded bounded context only; never a request/model permission. */
  verifiedContext?: CustomerAgentVerifiedContext;
  /** Original input supplied by the server adapter, never model prose. */
  inputText?: string;
  attachmentInput?: CustomerAgentAttachmentInput;
  mediaPerception?: CustomerAgentMediaPerception;
  approvedFileState?: CustomerAgentApprovedFileState;
}): string | null {
  const d = input.decision, lang = input.language;
  if (d.kind === "skip" || d.kind === "escalate" || d.kind === "moderation_proposal") return "";
  const mayOverrideConversation = d.kind !== "propose";
  const guideIntent = input.surface === "dm" && d.kind === "reply" && d.attachment === "buyer_guide";
  const guideFollowPrompt = guideIntent && input.approvedFileState === "needs_follow";
  const guideText: Record<CustomerAgentApprovedFileState, { ru: string; tg: string }> = {
    available: { ru: "Памятка по покупке квартиры.", tg: "Ёддошт барои харидани манзил." },
    needs_follow: { ru: customerBuyerGuideFollowText("ru"), tg: customerBuyerGuideFollowText("tg") },
    awaiting_follow: { ru: "Памятка доступна подписчикам страницы.", tg: "Ёддошт барои обуначиёни саҳифа дастрас аст." },
    unavailable: { ru: "Сейчас не могу отправить памятку.", tg: "Ҳоло ёддоштро фиристода наметавонам." },
    already_sent: { ru: "Памятка уже отправлена в этом чате.", tg: "Ёддошт аллакай дар ҳамин чат фиристода шудааст." },
    pending_delivery: { ru: "Пока не могу подтвердить, отправился ли файл.", tg: "Ҳоло тасдиқ карда наметавонам, ки файл фиристода шуд ё не." },
  };
  const guidePresentation = guideIntent && input.approvedFileState ? guideText[input.approvedFileState]?.[lang] : undefined;
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
  // The office address and hours are printed only for a customer who asked about the agency (30.10.2026: "Лайк камент паделится"
  // got the full address). A model-chosen read nobody asked for is dropped here, silently. A job candidate
  // no longer keeps it either (owner 10.11.2026): a vacancy answer is the role, two or three lines of its
  // published conditions and the phone — no office address or hours unless the candidate asks for them.
  const companyUnsolicited = !companyInformationAsked(input.inputText ?? "");
  // «График», «офис», «выходные» — вопрос о вакансии только в разговоре о работе. Вне его
  // это часы и адрес компании (живой случай 13.11.2026, Arvan: «какой у вас график работы?»).
  const jobConversation = input.verifiedContext?.publicState.topic === "job" || !!input.verifiedContext?.publicState.jobPositionKey ||
    customerRecruitmentRequested(input.inputText ?? "");
  const recruitment = jobConversation && customerRecruitmentFactsRequested(input.inputText ?? "") || !input.inputText?.trim() && !!input.verifiedContext?.publicState.jobPositionKey
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
  let outsideRefusal = false, emptySearch = false, scopeAlreadySaid = false, jobScheduleAsked = false, nozaAlreadyGiven = false, receiptSaidBefore = false;
  const nozaSaidBefore = input.surface === "dm" && recruitmentPhoneSaidBefore(input.verifiedContext);
  // Noza's number goes once per conversation (audit 16.11.2026: the same line 2-7 times in 18 chats).
  const pushRecruitmentPhone = () => { if (nozaSaidBefore) nozaAlreadyGiven = true; else if (!lines.includes(recruitmentPhoneLine(lang))) lines.push(recruitmentPhoneLine(lang)); };
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
  const adOpening = adOpeningTurn(input);
  // The ad picture is not the customer's photo («Вижу документ.» on the ad button, audit 16.11.2026); a list of what is
  // seen («двор, парковка, окна») is not shown either: a short thank-you instead.
  const recognised = perception?.success && !recruitmentMedia && !adOpening && input.verifiedContext?.publicState.topic !== "job"
    ? customerAgentVisualSummary(perception.data, lang) : null;
  const visualSummary = recognised && perception?.success && !["floor_plan", "listing_card", "document"].includes(perception.data.subject)
    ? lang === "tg" ? "Ташаккур!" : "Спасибо, фото получил." : recognised;
  if (visualSummary) lines.push(visualSummary);
  if (perception?.success && perception.data.speech === "unintelligible" && d.kind === "clarify" && d.question === "clarify_previous" &&
      !(input.inputText ?? "").trim() && !visualSummary && !evidence.length) {
    const text = BUSINESS_QUESTION[lang];
    return text.length <= input.maxOutputChars ? text : null;
  }
  if (input.surface === "public_comment" && evidence.some(e => e?.value.kind === "receipt" || e?.value.kind === "proposal")) return null;
  const reaction = input.surface === "public_comment" && !input.requestedFacts.length && customerPublicReaction(input.inputText ?? "");
  if (reaction && d.kind !== "propose") {
    const text = customerPublicReactionText(reaction, lang);
    return text.length <= input.maxOutputChars ? text : null;
  }
  // Re-validated here from the same inputs as in the core: the check is deterministic, so a delivery re-render reproduces the very same text.
  const sayVerdict = input.surface === "dm" && (d.kind === "reply" || d.kind === "clarify" || d.kind === "propose") && d.say !== undefined
    ? validateCustomerAgentSayForDecision({ say: d.say, decision: d, evidence: input.evidence, language: lang, surface: input.surface,
      inputText: input.inputText, verifiedContext: input.verifiedContext }) : null;
  const sayText = sayVerdict?.ok ? sayVerdict.text : null;
  // One greeting per conversation, in the customer's form: «Ассалому алейкум» → «Ваалайкум ассалом!» (audit 16.11.2026:
  // «Салом!» four times in one chat, «Понял.» instead of a hello to a candidate).
  const greetedBefore = input.surface === "dm" && (customerAlreadyGreeted(line => lineSentBefore(input.verifiedContext, line)) ||
    !!input.verifiedContext?.turns.some(turn => turn.role === "assistant" && GREETING_REPLY_LINES.some(greeting => turn.text.trimStart().startsWith(greeting))));
  const greeting = d.social === "greet" && !greetedBefore ? customerGreetingLine(lang, input.inputText, social.greet) : "";
  if (input.surface === "public_comment" && d.social === "thank" && isCustomerPublicAppreciation(input.inputText ?? "")) {
    lines.push(customerPublicThanks(input.inputText!, lang));
  } else if (sayText) {
    // The grounded free phrase replaces the stock acknowledgement; a greeting still opens the message and the template question still closes it.
    // The model's own words pass the owner's banned-word guard too («лутфан», «мутахассис»): the same guard as the legacy bot.
    if (greeting) lines.push(greeting);
    lines.push(stripBannedWords(sayText));
  } else if (d.social === "greet") { if (greeting) lines.push(greeting); }
  else if (social[d.social][lang]) lines.push(social[d.social][lang]);
  if (followRequest) lines.push(lang === "tg" ? "Ман худам ба сайт ё аккаунт обуна шуда наметавонам." : "Я не могу сам подписаться на сайт или аккаунт.");
  if (languagePermissionRequested) lines.push(lang === "tg" ? "Бале, албатта. Дар бораи худ ва таҷрибаатон ба тоҷикӣ нақл кунед." : "Да, конечно. Расскажите о себе и своём опыте на таджикском.");
  if (messengerChannelQuestion) lines.push(lang === "tg" ? "Метавонем ҳамин ҷо, дар ҳамин чат, идома диҳем." : "Можем продолжить здесь, в текущем чате.");
  const renderedFactLines = new Set<string>();
  if (guidePresentation) lines.push(guidePresentation);
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
        const link = parsed.data.cards.length > 1 ? customerReplyLink(facts.publicLink, parsed.data.linksAllowed) : null;
        if (link) lines.push(link);
      }
    }
    if (item.value.kind === "property_unresolved") {
      const line = unresolvedPropertyLine(item.value, lang);
      if (line) lines.push(line);
    }
    if (item.value.kind === "receipt") {
      const line = outcomes[item.value.outcome][lang];
      // «Спасибо, записал.» once, not after every answer (audit 16.11.2026: five times in one chat).
      if (!(input.surface === "dm" && ["job_application_saved", "contact_saved"].includes(item.value.outcome) && lineSentBefore(input.verifiedContext, line))) lines.push(line);
      else receiptSaidBefore = true;
    }
    if (item.value.kind === "proposal") lines.push(item.value.summary[lang]);
    if (item.value.kind === "company_policy") {
      if (!isPinnedCompanyPolicy(item.value, input.knowledgeSourceHash)) return null;
      // A barter question is not a discount question: the agent answers it (renderCustomerAgentDecision), never this line.
      if (item.value.topic === "negotiation" && input.surface === "dm" && customerTradeInQuestion(input.inputText ?? "")) continue;
      // «Не могу гарантировать юридическую чистоту» to «Хочу продать квартиру» (5 chats) and «арендой не занимаемся» to a
      // word that is not about rent: these lines answer only their own question (audit 16.11.2026).
      // Only against the customer's actual words: a render without input (the memory allow-list) keeps every line.
      if (input.surface === "dm" && input.inputText !== undefined && (item.value.topic === "legal" && !customerLegalAsked(input.inputText) ||
          item.value.topic === "rental" && !item.value.knowledge.rent && !customerRentalAsked(input.inputText))) { scopeAlreadySaid = true; continue; }
      if (item.value.topic === "service_scope" && input.surface === "dm") {
        const scope = serviceScopeLines(item.value, lang, input, line => lineSentBefore(input.verifiedContext, line));
        lines.push(...scope.lines);
        if (scope.outside) outsideRefusal = true;
        if (!scope.lines.length) scopeAlreadySaid = true;
        continue;
      }
      lines.push(policySegment(item.value, lang));
    }
    if (item.value.kind === "company_information") {
      if (!isCustomerCompanyInformation(item.value)) return null;
      if (followRequest || languagePermissionOnly || companyUnsolicited) continue;
      // A candidate's «график?» is the job's schedule, not when the office answers (audit 16.11.2026, Ф6: «10:00–22:30, каждый
      // день» to a job seeker). Phone-only recruitment: Noza tells it.
      const ownWords = clientOwnWords(input.inputText ?? "");
      if (input.surface === "dm" && jobConversation && HOURS_QUESTION.test(ownWords) && !OFFICE_QUESTION.test(ownWords)) { jobScheduleAsked = true; continue; }
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
      if ((applicationSaved || alreadyPresented) && !customerRecruitmentFactsRequested(ownQuestion) && !explicitQuestion) {
        if (item.value.collecting && item.value.positions.length) pushRecruitmentPhone();
        continue;
      }
      // The list was already sent in this conversation (13.11.2026, live: the same vacancy block 3-4 times
      // in one chat on "?", "сколько", "как"). A follow-up question about the job is answered, not the
      // list again: conditions are not discussed in the chat, so the answer is the specialist's phone.
      if (input.surface === "dm" && d.kind !== "propose" && item.value.collecting && item.value.positions.length &&
          vacancyListSentBefore(input.verifiedContext, currentPosition ? [currentPosition] : item.value.positions)) {
        pushRecruitmentPhone();
        continue;
      }
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
        if (!matched && item.value.positions.length > 12) lines.push(lang === "tg" ? `Ва боз ${item.value.positions.length - 12} вазифа.`
          : `И ещё ${item.value.positions.length - 12} позиций.`);
        // Conditions are not discussed in the chat: only the specialist's phone (owner 10–11.11.2026), once per chat.
        pushRecruitmentPhone();
      }
    }
    if (item.value.kind === "property_search") {
      if (!isPublicPropertySearch(item.value)) return null;
      lines.push(...searchSegments(item.value, lang));
      // Nothing fits (not "cheaper", not "all already sent"): a person searches by hand (15.11.2026, live: a salon
      // premises request got "nothing found. Budget?" and no lead). One honest line, then the hand-off, no qualifier question.
      if (input.surface === "dm" && searchNeedsAgent(item.value)) emptySearch = true;
    }
    if (item.value.kind === "agency_contact") {
      if (!isCanonicalAgencyContact(item.value)) return null;
      if (requestedContact) lines.push(`${lang === "tg" ? "Занг занед" : "Позвоните"}: ${item.value.contact.phone}.`);
    }
  }
  if (input.surface === "dm" && jobConversation && d.kind !== "propose") {
    const kind = customerRecruitmentFollowUp(input.inputText, ASKS_NOW.test(clientOwnWords(input.inputText ?? "")) || jobScheduleAsked);
    // The candidate gave their number after Noza's, or cannot reach her: a person takes over (the turn signals one, the one door
    // lib/customerDmAgentTurn.ts::signalStaffFollowUp), one line, nothing else (audit 16.11.2026).
    if ((kind === "complaint" || kind === "phone_given") && nozaSaidBefore) {
      const line = recruitmentFollowUpLine(kind, lang);
      return line.length <= input.maxOutputChars ? line : null;
    }
    const content = lines.filter(line => line && !isSocialLine(line));
    if ((jobScheduleAsked || nozaAlreadyGiven && kind === "ask") && !content.length) {
      lines.push(recruitmentFollowUpLine("ask", lang));
      if (!nozaSaidBefore) pushRecruitmentPhone();
    } else if (nozaAlreadyGiven && !content.length && !receiptSaidBefore) lines.push(recruitmentFollowUpLine("thanks", lang));
  }
  // The receipt was already said and nothing else is left: the same fact in other words, never an empty reply.
  if (receiptSaidBefore && !lines.some(line => line && !isSocialLine(line))) lines.push(RECEIPT_AGAIN[lang]);
  if (furnitureQuestion && !furnitureAnswerIncluded) lines.push(lang === "tg"
    ? "Маълумоти тасдиқшуда нест, ки мебел бо объект дода мешавад ё ба нарх дохил аст."
    : "В подтверждённых данных не указано, останется ли мебель и входит ли она в стоимость.");
  // "2% от 700 000 — сколько?": the server counts (never the model). The company's seller percent when its pinned
  // policy was read this turn (a buyer pays nothing, so no sum for a buyer); else the customer's own figure.
  let arithmetic: string | null = null;
  if (input.surface === "dm" && d.kind !== "propose") {
    // Review #201 (В1): only the SELLER's commission, from the pinned policy read this turn and either chosen by the model
    // now or already told in this chat; a buyer, an unknown role, a mortgage/discount/annual rate get no sum.
    const read = input.evidence.find(e => e.value.kind === "company_policy" && e.value.topic === "commission" &&
      isPinnedCompanyPolicy(e.value, input.knowledgeSourceHash));
    const commission = read?.value as CustomerAgentCompanyPolicyObservation | undefined;
    const intake = intakeProgress(input);
    const seller = intake.role === "seller" || intake.role !== "buyer" && CUSTOMER_SELLER_WORDS.test(clientOwnWords(input.inputText ?? "").toLowerCase());
    const told = !!commission && (d.refs.includes(read!.ref) || lineSentBefore(input.verifiedContext, policySegment(commission, lang)));
    arithmetic = commission && seller && told
      ? customerCommissionAmountLine(input.inputText ?? "", lang, commission.knowledge.commission.sellerPercent) : null;
    if (arithmetic && !lines.includes(arithmetic)) lines.push(arithmetic);
  }
  if (emptySearch) lines.push(customerSearchHandOffLine(lang, input.knownPhoneSource, followUpMemory(input)));
  const attachmentOnly = input.surface === "dm" && input.verifiedContext?.publicState.topic !== "job" && input.inputText !== undefined && !input.inputText.trim() && !!input.attachmentInput && !perception;
  if (attachmentOnly) {
    const attachment = customerAgentAttachmentInputSchema.safeParse(input.attachmentInput);
    if (!attachment.success || d.kind !== "clarify" || d.social !== "none" || d.question !== "clarify_previous" ||
        evidence.some(e => e?.value.kind !== "facts")) return null;
    const seller = input.verifiedContext?.publicState.topic === "seller" || intakeProgress(input).role === "seller";
    lines.push(customerAgentAttachmentQuestion(attachment.data, lang, evidence.some(e => e?.value.kind === "facts"),
      evidence.some(e => e?.value.kind === "facts") || seller));
    const text = lines.filter(Boolean).join("\n");
    return text && text.length <= input.maxOutputChars ? text : null;
  }
  // The job question is decided against the catalog the core read, whether or not its text is shown this turn
  // (an unshown catalog used to leave "Какая должность вас интересует?" asked after the customer named the role).
  const questionEvidence = [...evidence.filter((e): e is CustomerAgentEvidence => !!e),
    ...input.evidence.filter(e => e.value.kind === "open_vacancies" && e.value.positions.length > 0 && !evidence.includes(e))];
  const question = followRequest || languagePermissionOnly || furnitureOnly || guideFollowPrompt || outsideRefusal || emptySearch ? "none"
    : customerAgentRenderedQuestion({ ...input, ...material, evidence: questionEvidence });
  const intake = intakeProgress(input);
  // Suppress only the redundant/private question, preserve useful verified
  // facts or a local receipt. No whole-answer erasure or invented success.
  // Explicit facts are useful before any questionnaire. One question can be
  // chosen after the facts, but an unresolved property cannot ask for a phone.
  const requiredFact = question === "job_required" ? recruitmentNextFact({ ...input, ...material }) : undefined;
  // The résumé is asked once: not after a document/photo/own account, and not a second time.
  const aboutHandled = (question === "job_experience" || requiredFact === "about") && input.surface !== "public_comment" &&
    (experienceInvitationIncluded || recruitmentAboutHandled({ ...input, ...material }));
  // Somebody else's link keeps the business question below; our own link that did not resolve goes to a person.
  const linkUnresolved = input.surface === "dm" && question === "property" && customerInputHasLink(input.inputText) &&
    !evidence.some(e => e?.value.kind === "facts" ||
      e?.value.kind === "property_unresolved" && (e.value.reason === "untrusted_origin" || e.value.reason === "unsupported"));
  if (adOpening && (question === "topic" || question === "none") && !lines.some(line => line && !isSocialLine(line))) {
    lines.push(AD_OPEN_QUESTION[lang]);
  } else if (linkUnresolved) {
    // A link we could not open is never answered «which object?» (audit 16.11.2026, class 7): a person looks at it.
    lines.push(handOffLine(input));
  } else if (question !== "none" && question !== "confirmation" && !aboutHandled) lines.push(question === "property" &&
      evidence.some(e => e?.value.kind === "publication_properties" && e.value.cards.length > 1)
    ? lang === "tg" ? "Кадоме аз ин объектҳо ба шумо писанд омад?" : "Какой из этих объектов вас заинтересовал?"
    // A link to somebody else's site is not mentioned at all: the question is about what the customer wants.
    : question === "property" && evidence.some(e => e?.value.kind === "property_unresolved" && (e.value.reason === "untrusted_origin" || e.value.reason === "unsupported"))
      ? BUSINESS_QUESTION[lang]
    : question === "property" && input.surface === "dm" && evidence.some(e => e?.value.kind === "property_unresolved" && e.value.reason === "ad_unmapped")
      ? AD_INTEREST_QUESTION[lang]
    : question === "property" && input.surface === "dm" && evidence.some(e => e?.value.kind === "property_unresolved") && shownObjectQuestion(input.verifiedContext, lang)
      ? shownObjectQuestion(input.verifiedContext, lang)!
    : input.surface === "public_comment" && question.startsWith("job_")
      ? publicRecruitmentQuestion(requiredFact === "about" ? "job_experience" : question, lang, experienceInvitationIncluded)
    : question === "job_required" && requiredFact ? recruitmentRequiredQuestion(requiredFact, lang)
    : question === "seller_details" && input.surface === "dm" && intake.role === "seller"
      ? customerSellerIntakeQuestion(intake.sellerKnown, lang)
    : question === "clarify_previous" && input.surface === "dm"
      ? repairPreviousQuestion(input.verifiedContext, lang) ?? questions[question][lang] : questions[question][lang]);
  if (question === "confirmation") lines.push(lang === "tg" ? "Тасдиқ мекунед?" : "Подтверждаете?");
  if (!evidence.length && question === "none" && d.social === "none" && !visualSummary && !arithmetic && !followRequest && !languagePermissionRequested && !messengerChannelQuestion && !furnitureQuestion && !guidePresentation) return null;
  // The greeting was already said in this chat and nothing else is left: the next step, never an empty reply.
  if (d.social === "greet" && greetedBefore && !lines.some(Boolean)) {
    lines.push(adOpening ? AD_OPEN_QUESTION[lang] : nothingNewLine(input, new Set(splitLines(input.verifiedContext?.turns.filter(turn => turn.role === "assistant").at(-1)?.text ?? ""))));
  }
  // A suppressed personal-data request by itself is not a useful completed
  // reply, even if the model attached "Понял" to it.
  if ((publicContactQuestion || (d.kind !== "propose" && d.question === "phone" && input.knownPhoneSource !== "none")) &&
      !evidence.length && question === "none") return null;
  // The only content was the service area said before ("Хона дар Душанбе аст", 15.11.2026): the next step, never silence.
  if (scopeAlreadySaid && !lines.some(line => line && !isSocialLine(line))) {
    lines.push(nothingNewLine(input, new Set(splitLines(input.verifiedContext?.turns.filter(turn => turn.role === "assistant").at(-1)?.text ?? ""))));
  }
  const text = lines.filter(Boolean).join("\n");
  // Never truncate a monetary value, receipt or critical proposal summary.
  return text && text.length <= input.maxOutputChars ? text : null;
}

/**
 * A DM reply never repeats the previous bot turn (24.10.2026, attack stand: "Что ещё важно при выборе…"
 * or "Какая должность вас интересует?" echoed every turn, then the outbound shield swallowed the third
 * identical text and the customer got silence). Server text only, no model words:
 *  - a fixed question the previous turn already asked is not asked again; what is left of the reply stays;
 *  - nothing left: the buyer's finished questionnaire moves to the next step (an object), a seller who was not just
 *    asked gets the seller question, anything else goes to a person: "это скажет агент" (+ the phone question);
 *  - the same facts asked for again are said again after a neutral thanks («Спасибо за ваш вопрос.»; before review #211 round 6
 *    "Конечно." / "Бале.", which read as «да» to a repeated «Скидку сделаете?»).
 * Never "I wrote this above" or "I repeat" (owner 15.11.2026: 30 such replies in 19 chats in a week, rude and robotic).
 * Hostile or promotional input is answered by one neutral line before any of this (no company fact for a threat).
 *
 * The lead is the MARKER of «already said once more» (asked.has below), so it is never a phrase the model may write itself: «Ташаккур
 * барои саволатон.» was also a vetted model lead, and a model that said it made the next repeat skip the lead and go to a person
 * (review #211, round 7, п.4). A guard test keeps AGAIN_LEAD out of HUMAN_PHRASES. «Раҳмат барои …» is the phrasebook's pattern
 * («Раҳмат барои сабр»); 40a472cb with the old wording was never pushed, so no older chat carries it.
 */
export const AGAIN_LEAD = { ru: "Спасибо за ваш вопрос.", tg: "Раҳмат барои саволатон." } as const;
/** The lead before review #211 round 6: older chats still carry it (a third ask then goes to a person). */
const RETIRED_AGAIN_LEAD = { ru: "Конечно.", tg: "Бале." };
/** The customer's message asks something (a question mark or a question word, RU/TG, colloquial spelling too). */
const ASKS_NOW = /[?？]|(?:^|[\s,.!])(?:как\p{L}*|сколько|где|когда|почему|зачем|что|есть\s+ли|можно|мумкин|чанд|кай|куҷо|кучо|чӣ|чи|чаро|кадом\p{L}*|нархаш|расскаж\p{L}*|подробн\p{L}*|нақл|накл)(?=$|[\s,.!?])|(?:ҳаст|хаст)\s*$/iu;
/** What the conversation already holds for the hand-off: lines said, and whether the phone was already asked for. */
function followUpMemory(input: { verifiedContext?: CustomerAgentVerifiedContext }): FollowUpMemory {
  const said = (line: string) => lineSentBefore(input.verifiedContext, line);
  const phoneAsked = customerPhoneAskLines().some(said) || [questions.phone.ru, questions.phone.tg].some(said) ||
    !!input.verifiedContext?.turns.some(turn => turn.role === "assistant" && PHONE_ASK_TEXT.test(turn.text));
  return { said, phoneAsked };
}
/** RETIRED wording (15.11.2026). Never rendered again; kept only so the memory of older chats still recognises it. */
const RETIRED_REPEAT_LEAD = { ru: "Повторю ещё раз:", tg: "Бори дигар такрор мекунам:" };
const RETIRED_REPEAT_NOTICES: ReadonlyArray<{ ru: string; tg: string }> = [
  { ru: "Я уже писал об этом выше. Уточните, пожалуйста, что именно непонятно или что вы хотите узнать.",
    tg: "Ман инро дар боло навишта будам. Лутфан бигӯед, кадом қисми он нофаҳмо аст ё чиро донистан мехоҳед." },
  { ru: "Если мой вопрос выше был неясен, напишите своими словами, что вам нужно.",
    tg: "Агар саволи ман дар боло номафҳум буд, бо суханони худ нависед, ки шуморо чӣ лозим аст." },
  { ru: "Чтобы помочь точнее, напишите одним сообщением, что вас интересует: покупка, продажа недвижимости или работа.",
    tg: "Барои дақиқтар кӯмак расондан дар як паём нависед, ки шуморо чӣ ҷалб мекунад: харид, фурӯши амвол ё кор." },
];
/**
 * A block the bot already sent in this conversation (a property list, the vacancy list, any reply of three or
 * more content lines) is never sent again (13.11.2026, live: the same three objects and the same vacancy block
 * 3-4 times in one WhatsApp chat). Since 15.11.2026 the one short line instead is the hand-off to a person
 * (customerAgentStaffFollowUp.ts); the wording below is RETIRED and kept for the memory of older chats only.
 */
const RETIRED_BLOCK_SENT_NOTICES = {
  list: [
    { ru: "Эти варианты я уже отправил выше. Если хотите, сотрудник позвонит и подберёт другие.",
      tg: "Ин вариантҳоро дар боло фиристодам. Агар хоҳед, корманд занг мезанад ва вариантҳои дигар интихоб мекунад." },
    { ru: "Подходящие варианты есть в сообщении выше. Напишите, какой из них вам ближе, или что поменять в поиске.",
      tg: "Вариантҳои мувофиқ дар паёми боло ҳастанд. Нависед, кадомаш ба шумо писанд аст ё дар ҷустуҷӯ чиро иваз кунем." },
  ],
  other: [
    { ru: "Я уже написал об этом выше. Если что-то осталось непонятным, напишите, что именно уточнить.",
      tg: "Инро дар боло навиштам. Агар чизе номафҳум монд, нависед, чиро аниқ кунам." },
    { ru: "Всё, что есть по этому вопросу, есть в сообщении выше. Если удобнее, сотрудник позвонит и расскажет подробнее.",
      tg: "Ҳамаи маълумот дар ин бора дар паёми боло ҳаст. Агар хоҳед, корманд занг мезанад ва муфассал мегӯяд." },
  ],
} as const;
const PREFERENCES_DONE = { ru: "Понял, учту. Если хотите посмотреть конкретный вариант, пришлите номер объекта или ссылку на него.",
  tg: "Фаҳмидам, ба назар мегирам. Агар хоҳед вариантро аз наздик бинед, рақам ё пайванди объектро фиристед." };
/** Same meaning, different words: a bare greeting/thanks/acknowledgement is not sent twice in a row. */
const SOCIAL_FAMILIES: ReadonlyArray<ReadonlyArray<{ ru: string; tg: string }>> = [
  // Third of the family: a neutral thanks, never «Хорошо, принято.» (review #211, round 6: after «Беру», «Приеду», «Мегирам» it read as
  // «да»; nothing was saved, so no «принято / записал» either).
  [social.acknowledge, { ru: "Спасибо за ваше сообщение.", tg: "Ташаккур барои паёматон." }, { ru: "Ясно, спасибо.", tg: "Равшан аст, ташаккур." }],
  [social.thank, { ru: "Благодарю!", tg: "Миннатдорам!" }, { ru: "Спасибо вам!", tg: "Сипос!" }],
  [social.greet, { ru: "Добрый день!", tg: "Салом!" }, { ru: "Здравствуйте, рад вас слышать!", tg: "Салом, хуш омадед!" }],
];
const lineSet = (...lists: ReadonlyArray<readonly string[]>) => new Set(lists.flat());
let fixedQuestionLines: Set<string> | undefined;
/** Fixed question sentences (templates, "я уточнял" repairs, résumé/seller questions): the only lines the repeat check may drop. */
function questionLineSet(): Set<string> {
  return fixedQuestionLines ??= lineSet(Object.values(questions).flatMap(line => [line.ru, line.tg]).filter(Boolean),
    Object.values(repairs).flatMap(line => [line.ru, line.tg]), recruitmentFactQuestionLines(), customerSellerIntakeQuestionLines(), customerAgentAttachmentLines(),
    [AD_INTEREST_QUESTION.ru, AD_INTEREST_QUESTION.tg]);
}
const socialLineSet = () => lineSet(SOCIAL_FAMILIES.flat().flatMap(line => [line.ru, line.tg]));
/** A greeting, thanks or acknowledgement (including «Ваалайкум ассалом!»): never content on its own. */
const isSocialLine = (line: string) => socialLineSet().has(line) || GREETING_REPLY_LINES.includes(line);
/** Lines that are never content: the retired notices of older chats, the "Конечно." lead and the hand-off. */
const noticeLineSet = () => lineSet(RETIRED_REPEAT_NOTICES.flatMap(line => [line.ru, line.tg]), [RETIRED_REPEAT_LEAD.ru, RETIRED_REPEAT_LEAD.tg],
  [...RETIRED_BLOCK_SENT_NOTICES.list, ...RETIRED_BLOCK_SENT_NOTICES.other].flatMap(line => [line.ru, line.tg]),
  [AGAIN_LEAD.ru, AGAIN_LEAD.tg], customerStaffFollowUpFixedLines());
/** The retired "I wrote above / I repeat" wording: a guard test proves the renderer never produces it again. */
export function customerAgentRetiredRepeatLines(): string[] {
  return [RETIRED_REPEAT_LEAD, ...RETIRED_REPEAT_NOTICES, ...RETIRED_BLOCK_SENT_NOTICES.list, ...RETIRED_BLOCK_SENT_NOTICES.other]
    .flatMap(line => [line.ru, line.tg]);
}
/** Every fixed line the renderer can produce on its own, for the read-only conversation-memory allow-list
 * (an assistant turn made only of such lines is kept in the model's and the renderer's history). */
export function customerAgentFixedLines(): Set<string> {
  return lineSet([...questionLineSet()], [...noticeLineSet()], customerDmAbuseLines(), customerStaffFollowUpFixedLines(),
    [PREFERENCES_DONE.ru, PREFERENCES_DONE.tg], SOCIAL_FAMILIES.flat().flatMap(line => [line.ru, line.tg]),
    // 16.11.2026: the live wording and what it replaced (older chats keep their memory).
    [AD_OPEN_QUESTION.ru, AD_OPEN_QUESTION.tg], recruitmentFollowUpFixedLines(), GREETING_REPLY_LINES, RETIRED_TEMPLATE_LINES,
    retiredRecruitmentPhoneLines(), [recruitmentPhoneLine("ru"), recruitmentPhoneLine("tg")]);
}
/** The numbers of the objects the bot's last message listed ("1. Объект №69"): a fact question after a list asks which of THEM. */
function shownObjectQuestion(context: CustomerAgentVerifiedContext | undefined, lang: "ru" | "tg"): string | null {
  const last = context?.turns.at(-1);
  if (context?.surface !== "dm" || last?.role !== "assistant") return null;
  const numbers = [...new Set([...last.text.matchAll(/^\s*\d+\.\s*Объект\s*№\s*(\d{1,9})(?!\d)/gmu)].map(match => match[1]))].slice(0, 6);
  if (numbers.length < 2) return null;
  const list = numbers.map(number => `№${number}`), tail = list.pop()!;
  return lang === "tg" ? `Кадом объектро дар назар доред: ${[...list].join(", ")} ё ${tail}?` : `Какой из объектов вы имеете в виду: ${list.join(", ")} или ${tail}?`;
}
const splitLines = (text: string) => text.split("\n").map(line => line.trim()).filter(Boolean);

type RepeatInput = Parameters<typeof renderDecisionCore>[0];
/**
 * Nothing new to say and nothing asked ("фаҳмидам", "Душанбе", a photo again): the next questionnaire step if it was not
 * just asked, otherwise a short acknowledgement. Never a hand-off and never a staff signal (review #201, С1).
 */
function nothingNewLine(input: RepeatInput, previousLines: ReadonlySet<string>): string {
  const lang = input.language, intake = intakeProgress(input);
  if (intake.role === "seller") {
    const question = customerSellerIntakeQuestion(intake.sellerKnown, lang);
    if (!previousLines.has(question)) return question;
  }
  if (intake.role === "buyer") {
    const key = (["location", "rooms", "budget"] as const).find(value => !intake.buyerKnown.includes(value));
    if (key && !previousLines.has(questions[key][lang])) return questions[key][lang];
  }
  const ack = SOCIAL_FAMILIES[0].map(word => word[lang]);
  return ack.find(word => !previousLines.has(word)) ?? ack[0];
}
/** A real question the bot cannot answer from what it has: a person takes over. */
function handOffLine(input: RepeatInput): string {
  return customerStaffFollowUpLine(input.language, input.knownPhoneSource, followUpMemory(input));
}
const asksNowOf = (input: RepeatInput) => !!input.requestedFacts?.length || ASKS_NOW.test(clientOwnWords(input.inputText ?? ""));

/** The reply is a block whose every content line was already sent in this conversation: the hand-off that replaces it. */
function repeatedBlockNotice(text: string, input: RepeatInput): string | null {
  const context = input.verifiedContext, lang = input.language;
  if (context?.surface !== "dm") return null;
  const notices = noticeLineSet(), questionLines = questionLineSet(), socials = socialLineSet();
  const lines = splitLines(text);
  const content = lines.filter(line => !socials.has(line) && !notices.has(line) && !questionLines.has(line));
  const listLike = content.some(line => /^\d+\.\s/u.test(line) || VACANCY_LIST_HEADERS.includes(line));
  // A fact the customer asks for right now is the answer, said again; a list or a long block is not.
  if (!(content.length >= 3 || listLike && content.length >= 2) || input.requestedFacts?.length && !listLike) return null;
  if (!content.every(line => lineSentBefore(context, line))) return null;
  const previous = new Set(splitLines(context.turns.filter(turn => turn.role === "assistant").at(-1)?.text ?? ""));
  // The same list again: an agent picks others. Another block: a person only for a real question, else the next step.
  const lead = listLike ? customerSearchHandOffLine(lang, input.knownPhoneSource, followUpMemory(input))
    : asksNowOf(input) ? handOffLine(input) : nothingNewLine(input, previous);
  // A question this reply still asks and the previous bot turn did not is kept, unless the lead already asks something.
  const leadAsks = customerPhoneAskLines().includes(lead) || questionLines.has(lead);
  const questionsLeft = leadAsks ? [] : lines.filter(line => questionLines.has(line) && !previous.has(line));
  return [lead, ...questionsLeft].join(String.fromCharCode(10));
}

function avoidRepeatedReply(text: string, input: RepeatInput): string {
  // A job candidate: the specialist's phone is THE answer (owner 10–11.11), said again rather than swapped for «Понял.».
  if (splitLines(text).includes(recruitmentPhoneLine(input.language))) return text;
  const turns = input.verifiedContext?.turns ?? [];
  const blockNotice = repeatedBlockNotice(text, input);
  if (blockNotice) return blockNotice;
  // The opening question after the ad button may be asked once more («.», «Здравствуйте»); the outbound shield stops a third copy.
  if (splitLines(text).includes(AD_OPEN_QUESTION[input.language]) &&
      (input.verifiedContext?.turns ?? []).filter(turn => turn.role === "assistant" && turn.text.includes(AD_OPEN_QUESTION[input.language])).length < 2) return text;
  if (input.verifiedContext?.surface !== "dm" || turns.at(-1)?.role !== "assistant") return text;
  const notices = noticeLineSet(), questionLines = questionLineSet(), socials = socialLineSet(), lang = input.language;
  const assistant = turns.filter(turn => turn.role === "assistant");
  const previous = splitLines(assistant.at(-1)!.text);
  // A notice answers a repeated question; the question it replaced is still the one on the table.
  const asked = new Set(previous.every(line => notices.has(line) || socials.has(line)) && assistant.length > 1 ? [...previous, ...splitLines(assistant.at(-2)!.text)] : previous);
  const lines = splitLines(text);
  // A bare greeting/thanks/acknowledgement already sent twice: the next wording of the same meaning, if any is left.
  const family = lines.length === 1 ? SOCIAL_FAMILIES.find(words => words.some(word => word[lang] === lines[0])) : undefined;
  if (family) {
    // Twice is natural ("Понял." after two answers); the third identical text is what the shield would swallow.
    const said = assistant.map(turn => turn.text.trim());
    return said.filter(turn => turn === lines[0]).length >= 2 ? family.map(word => word[lang]).find(word => !said.includes(word)) ?? text : text;
  }
  const repeatedQuestions = lines.filter(line => questionLines.has(line) && asked.has(line));
  const asksNow = asksNowOf(input);
  const handOff = () => asksNow ? handOffLine(input) : nothingNewLine(input, new Set(previous));
  if (repeatedQuestions.length) {
    const rest = lines.filter(line => !repeatedQuestions.includes(line));
    if (rest.length) return rest.join("\n");
    if (repeatedQuestions.includes(questions.property[lang])) {
      // "цена" twice with no object: the second time asks once more in other words, then a person takes over; a link the customer
      // just sent is never answered with the same question (audit 16.11.2026, class 7).
      if (customerInputHasLink(input.inputText)) return handOffLine(input);
      return asked.has(repairs.property[lang]) ? handOff() : repairs.property[lang];
    }
    return repeatedQuestions.includes(questions.preferences[lang]) ? PREFERENCES_DONE[lang] : handOff();
  }
  // The same facts again. Greetings and thanks repeat freely.
  if (lines.every(line => asked.has(line)) && !lines.every(line => socials.has(line))) {
    // The customer asks right now ("этаж", "какой график?") and this is the answer: said again, never a notice (31.10 live).
    // Part of an earlier, longer answer goes as it is; the very same message gets "Конечно." first (the shield lets a second copy
    // through, never a third); after that a person takes over.
    if (asksNow) {
      // Already said once more after "Конечно."/"Бале.": the asked fact is still the answer; any other question goes to a person.
      if (asked.has(AGAIN_LEAD[lang]) || asked.has(RETIRED_AGAIN_LEAD[lang])) return input.requestedFacts?.length ? text : handOff();
      if (text.trim() !== assistant.at(-1)!.text.trim()) return text;
      return `${AGAIN_LEAD[lang]}\n${text}`;
    }
    return handOff();
  }
  return text;
}

/** The server's own (template) reply; `plain` = the ordinary path, no special answer and no repeat/ack guard rewrote it. */
function renderTemplateDecision(input: Parameters<typeof renderDecisionCore>[0]): { text: string | null; plain: boolean } {
  const d = input.decision;
  // A forwarded publication that is not ours, with nothing asked (nothing, a heart, like-exchange words): one short line, no fact.
  // Not in a job dialogue: a candidate's forwarded post is their material (the core now renders with the attachment too, review #206 В4).
  if (input.surface === "dm" && (d.kind === "reply" || d.kind === "clarify") && input.verifiedContext?.publicState.topic !== "job" &&
      customerAgentShareNotice(input.attachmentInput, input.language) !== null &&
      customerDmForeignShareNoise(input.inputText ?? "") && !input.evidence.some(e => e.value.kind === "receipt" || e.value.kind === "proposal")) {
    const line = customerAgentShareNotice(input.attachmentInput, input.language)!;
    return { text: line.length <= input.maxOutputChars ? line : null, plain: false };
  }
  const said = (line: string) => lineSentBefore(input.verifiedContext, line);
  if (input.surface === "dm" && (d.kind === "reply" || d.kind === "clarify") && !input.evidence.some(e => e.value.kind === "receipt" || e.value.kind === "proposal")) {
    const abuse = customerDmAbuseKind(input.inputText ?? "");
    if (abuse) {
      const reply = customerDmAbuseReply(abuse, input.language);
      return { text: reply.length <= input.maxOutputChars ? reply : null, plain: false };
    }
    // Somebody offers US a partnership: management decides, a person is told (15.11.2026, live: a design studio got "Спасибо!").
    if (customerPartnershipOffer(input.inputText ?? "")) return { text: customerPartnershipReply(input.language, input.knownPhoneSource, followUpMemory(input)).join("\n"), plain: false };
    // A bare "thank you" is answered "you are welcome", never "if my question above was unclear" (15.11.2026, live).
    if (customerThanksOnly(input.inputText ?? "")) return { text: customerThanksReply(input.language, said), plain: false };
  }
  const text = renderDecisionCore(input);
  // A barter question ("Мошин ҳам қабул мекунед?") is answered by the agent: what else is known stays, the hand-off
  // replaces any questionnaire question (one question per message), and a person is told (15.11.2026, live).
  if (input.surface === "dm" && (d.kind === "reply" || d.kind === "clarify") && customerTradeInQuestion(input.inputText ?? "")) {
    const questionLines = questionLineSet(), notices = noticeLineSet();
    const kept = text ? splitLines(avoidRepeatedReply(text, input)).filter(line => !questionLines.has(line) && !notices.has(line)) : [];
    const result = [...kept, customerStaffFollowUpLine(input.language, input.knownPhoneSource, followUpMemory(input))].join("\n");
    return { text: result.length <= input.maxOutputChars ? result : null, plain: false };
  }
  if (!text) return { text, plain: false };
  const guarded = templateOneMeaningOnce(acknowledgementOnlyGuard(avoidRepeatedReply(text, input), input));
  return { text: guarded, plain: guarded === text };
}

/**
 * One meaning once in the SERVER's text too, by the rule the model's words obey (humanPhrasesClash; review #211, round 7, п.1): the
 * repeat lead went in front of the template's own thanks, «Спасибо за ваш вопрос.\nСпасибо!\nЦена…», «Раҳмат барои саволатон.\nТашаккур!…».
 * Only a whole greeting / thanks / acknowledgement line (or the repeat lead, the neutral thanks) is ever dropped, and only when an
 * earlier such line already said that meaning; the first one stays (the repeat lead is the marker the next turn reads). A fact line
 * is never touched.
 */
function templateOneMeaningOnce(text: string): string {
  const lines = splitLines(text), seen = new Set<HumanPhraseGroup>();
  const kept = lines.filter(line => {
    if (!isSocialLine(line) && line !== AGAIN_LEAD.ru && line !== AGAIN_LEAD.tg && line !== NEUTRAL_THANKS.ru && line !== NEUTRAL_THANKS.tg) return true;
    const groups = humanPhraseGroups(line);
    if (groups.some(group => seen.has(group))) return false;
    for (const group of groups) seen.add(group);
    return true;
  });
  return kept.length === lines.length ? text : kept.join("\n");
}

type RenderInput = Parameters<typeof renderDecisionCore>[0];
const answerOf = (d: CustomerAgentDecision): unknown => d.kind === "reply" || d.kind === "clarify" || d.kind === "propose" ? d.answer : undefined;
/** The decision without the model's own words: `answer` always; `say` too when the template is the base of a composed answer. */
const withoutModelWords = (d: CustomerAgentDecision, say = false): CustomerAgentDecision => {
  if (!("answer" in d) && !(say && "say" in d)) return d;
  const { answer: _answer, say: _say, ...rest } = d as CustomerAgentDecision & { answer?: unknown; say?: string };
  return (say || _say === undefined ? rest : { ...rest, say: _say }) as CustomerAgentDecision;
};

/**
 * The template reply split for composition (customerAgentAnswer.ts): leading greeting/thanks/acknowledgement lines, the fact lines
 * (copied verbatim) and the final fixed question the model may word itself — only the plain template of one of the ask kinds.
 */
function answerTemplateOf(input: RenderInput, text: string): CustomerAgentAnswerTemplate {
  const lines = splitLines(text), social: string[] = [];
  let index = 0;
  while (index < lines.length && isSocialLine(lines[index])) social.push(lines[index++]);
  const rest = lines.slice(index), last = rest.at(-1);
  const kind = customerAgentRenderedQuestion(input);
  const askKind = (CUSTOMER_AGENT_ASK_KINDS as readonly string[]).includes(kind) ? kind as CustomerAgentAskKind : null;
  const replaceable = !!askKind && last !== undefined && last === questions[askKind][input.language];
  const facts = replaceable ? rest.slice(0, -1) : rest;
  return { social, facts, question: replaceable ? { line: last!, kind: askKind! } : null, negative: answerContextNegative(input, facts) };
}
/** A refusal or limit among the facts (review #211, round 2): «арендой не занимаемся», «уже продан», «в брони», the work area, «не могу
 * подтвердить», nothing found. Next to such a line the model's words stay neutral («Понимаю вас.»), never «Вам повезло!». */
const NEGATIVE_FACT = /(?:^|[^\p{L}])(?:не|нет|нельзя|без|продан\p{L}*|брон\p{L}*|занят\p{L}*|к сожалению|мутаассифона|нест|надор\p{L}*|на(?:ме|ш|т)\p{L}+|фурӯхта\p{L}*)(?=$|[^\p{L}])/iu;
function answerContextNegative(input: RenderInput, facts: readonly string[]): boolean {
  if (facts.some(line => NEGATIVE_FACT.test(line))) return true;
  return input.evidence.some(e => e.value.kind === "company_policy" && e.value.topic !== "commission" ||
    e.value.kind === "property_unresolved" ||
    e.value.kind === "facts" && e.value.facts.availability !== "AVAILABLE" ||
    e.value.kind === "publication_properties" && e.value.cards.some(card => card.availability !== "AVAILABLE") ||
    e.value.kind === "property_search" && searchNeedsAgent(e.value));
}

/**
 * The model's human words composed around the server's template for the SAME decision and evidence (customerAgentAnswer.ts).
 * null when the decision carries no answer. Pure: the core, this renderer and the delivery seal reach the same verdict from the same inputs.
 * Only the ordinary path is eligible: abuse, partnership, thanks, trade-in, foreign shares and any repeat/ack guard rewrite keep the template.
 * A bug in the verifier is a verdict too (`error`): the template goes out, the turn never dies (review #211, п.9).
 */
export function customerAgentAnswerVerdict(input: RenderInput): CustomerAgentAnswerVerdict | null {
  const d = input.decision, answer = answerOf(d);
  if (answer === undefined) return null;
  try {
    if (input.surface !== "dm") return { ok: false, reason: "surface_disabled" };
    const plain = { ...input, decision: withoutModelWords(d, true) };
    const template = renderTemplateDecision(plain);
    if (!template.plain || !template.text) return { ok: false, reason: "not_eligible" };
    return validateCustomerAgentAnswer({ answer, template: answerTemplateOf(plain, template.text), language: input.language, surface: input.surface,
      inputText: input.inputText, maxOutputChars: input.maxOutputChars,
      priorAssistantTurns: (input.verifiedContext?.turns ?? []).filter(turn => turn.role === "assistant").map(turn => turn.text),
      priorCustomerTurns: (input.verifiedContext?.turns ?? []).filter(turn => turn.role === "user").map(turn => turn.text),
      attachment: d.kind === "reply" && d.attachment !== undefined });
  } catch { return { ok: false, reason: "error" }; }
}

/** What goes out when the last door removed every sentence: a neutral thanks from the vetted list (nothing was agreed or saved). */
const NEUTRAL_THANKS = { ru: "Спасибо за ваше сообщение.", tg: "Ташаккур барои паёматон." } as const;
/** The last door on the whole text (template + model words): no sentence opens with a consent word (customerAgentHumanText.ts). */
function agreementChecked(text: string, input: Pick<RenderInput, "language" | "maxOutputChars">): { text: string | null; removed: string[] } {
  const checked = withoutAgreementOpenings(text);
  if (!checked.removed.length) return { text, removed: [] };
  const result = checked.text.trim() ? checked.text : NEUTRAL_THANKS[input.language];
  return { text: result.length <= input.maxOutputChars ? result : null, removed: checked.removed };
}

/**
 * The last door and what of its cuts is a SERVER bug (review #211, round 7, п.3). `agreement` = only the sentences the door cut that
 * the server's own template (the same decision without any model words) carries: a template line that says «да» is a code error for
 * the journal. The model's words never reach the journal: `say` and `answer` refuse an agreement word in their own checks (reason
 * `agree`, a counter), so a cut of a model sentence here would be a checker bug the tests catch, not a journal line per wording.
 * `template` is read only when the door cut something (rare), so the ordinary turn renders once.
 */
export function customerAgentLastDoor(text: string, template: () => string | null, input: Pick<RenderInput, "language" | "maxOutputChars">): { text: string | null; agreement: string[] } {
  const checked = agreementChecked(text, input);
  if (!checked.removed.length) return { text: checked.text, agreement: [] };
  const own = template();
  const serverCut = new Set(own ? withoutAgreementOpenings(own).removed : []);
  return { text: checked.text, agreement: checked.removed.filter(sentence => serverCut.has(sentence)) };
}

/**
 * The text the customer gets and the consent openings of the SERVER's template the last door removed from it (review #211, rounds
 * 6–7). The core logs a non-empty `agreement` to the error journal (a template line must be fixed); the text is the same either way,
 * so the renderer, the core and the delivery seal agree.
 */
export function renderCustomerAgentDecisionChecked(input: RenderInput): { text: string | null; agreement: string[] } {
  const verdict = customerAgentAnswerVerdict(input);
  const raw = verdict?.ok ? verdict.text : renderTemplateDecision({ ...input, decision: withoutModelWords(input.decision) }).text;
  if (raw === null) return { text: null, agreement: [] };
  return customerAgentLastDoor(raw, () => renderTemplateDecision({ ...input, decision: withoutModelWords(input.decision, true) }).text, input);
}
export function renderCustomerAgentDecision(input: RenderInput): string | null {
  return renderCustomerAgentDecisionChecked(input).text;
}

/**
 * A stored bot text whose sealed sideband says it asked this question: the question is its LAST line — the fixed sentence, or (since
 * review #211) the model's own wording that the seal recorded structurally. The sideband marker is the record; this only checks that
 * nothing follows the question.
 */
export function customerSealedQuestionLast(text: string, canonical: string): boolean {
  if (text.endsWith(canonical)) return true;
  const last = splitLines(text).at(-1) ?? "";
  return /[?]$/u.test(last) && (last.match(/[?]/gu)?.length ?? 0) === 1;
}

/**
 * The question the SENT text asks, recorded structurally for the delivery seal (review #211, п.4): the rendered question of the
 * decision, when the text ends with its fixed template sentence OR with the model's own wording of that same question accepted by
 * the answer verifier. A «да» to «Хотите, чтобы сотрудник вам позвонил?» is then consent like the template question.
 */
export function customerAgentSentQuestion(input: RenderInput, text: string): CustomerAgentRenderedQuestion {
  const kind = customerAgentRenderedQuestion({ ...input, decision: withoutModelWords(input.decision) });
  if (kind === "none" || kind === "confirmation") return "none";
  const canonical = questions[kind][input.language];
  if (canonical && text.endsWith(canonical)) return kind;
  const verdict = customerAgentAnswerVerdict(input);
  return verdict?.ok && agreementChecked(verdict.text, input).text === text && verdict.asked === kind ? kind : "none";
}

/**
 * «Понял./Фаҳмидам.» alone is never the answer to a message with digits, an address or a question (audit 16.11.2026: 20 such
 * replies; after #201 they would be the default). Such a message goes to a person; a candidate is pointed to Noza.
 */
function acknowledgementOnlyGuard(text: string, input: RepeatInput): string {
  if (input.surface !== "dm" || input.decision.kind === "propose") return text;
  const lines = splitLines(text), acks = new Set(SOCIAL_FAMILIES[0].flatMap(pair => [pair.ru, pair.tg]));
  if (!lines.length || !lines.every(line => acks.has(line))) return text;
  const asksNow = asksNowOf(input);
  if (!customerSubstantiveInput(input.inputText, asksNow)) return text;
  // The customer's own question comes first («до 50000. А в Сино есть варианты?», re-review #206 Н1; do-not-say №27):
  // a person answers it. Only a statement — a seller's facts, a buyer's budget — gets the next questionnaire step (С1).
  if (asksNow) {
    if (input.verifiedContext?.publicState.topic === "job") {
      return recruitmentPhoneSaidBefore(input.verifiedContext) ? recruitmentFollowUpLine("ask", input.language) : recruitmentPhoneLine(input.language);
    }
    return handOffLine(input);
  }
  const next = nothingNewLine(input, new Set(splitLines(input.verifiedContext?.turns.filter(turn => turn.role === "assistant").at(-1)?.text ?? "")));
  return acks.has(next) ? text : next;
}
