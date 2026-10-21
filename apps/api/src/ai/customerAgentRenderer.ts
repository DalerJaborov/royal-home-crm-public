import type { CustomerPropertyFactKind, CustomerPropertyFacts, CustomerMutationReceipt,
  CustomerAgentDecision, CustomerAgentQuestion, CustomerAgentSurface, CustomerAgentVerifiedContext } from "@royal-home/shared";
import { customerPropertyCharacteristicLines, customerAgentPublicationObservationSchema } from "@royal-home/shared";
import { PUBLIC_AGENCY_CONTACT } from "../lib/publicAgencyContact.js";
import { customerPublicThanks, customerRequestedAgencyContact, isCustomerPublicAppreciation, customerPublicReaction, customerPublicReactionText } from "./customerAgentConversationPolicy.js";
import { customerAgentIntake, customerSellerIntakeQuestion } from "./customerAgentIntake.js";
import { customerRecruitmentRequested, customerRecruitmentFactsRequested, isCustomerVacanciesObservation, recruitmentPositionForTurn } from "./customerAgentRecruitmentProtocol.js";
import { customerRecruitmentReplyDetails, containsRecruitmentExperienceInvitation } from "./customerRecruitmentReply.js";
import { clientOwnWords } from "./untrustedContent.js";
import { customerAgentAttachmentInputSchema, customerAgentAttachmentQuestion, type CustomerAgentAttachmentInput } from "./customerAgentAttachmentInput.js";
import { customerAgentMediaPerceptionSchema, customerAgentVisualSummary, type CustomerAgentMediaPerception } from "./customerAgentMediaPerception.js";
import { isPinnedCompanyPolicy, isPublicPropertySearch, isCustomerCompanyInformation, type CustomerAgentCompanyPolicyObservation,
  type CustomerAgentSearchObservation } from "./customerAgentPublicProtocol.js";

export type CustomerReceiptOutcome = CustomerMutationReceipt["outcome"];
export type CustomerAgentObservation =
  | { kind: "facts"; facts: CustomerPropertyFacts; kinds: CustomerPropertyFactKind[] }
  | { kind: "property_unresolved"; status: "missing" | "ambiguous" }
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
function intakeProgress(input: { verifiedContext?: CustomerAgentVerifiedContext; inputText?: string }) {
  const prior = input.verifiedContext?.intake;
  const recent = customerAgentIntake(prior ? [] : input.verifiedContext?.turns ?? [], input.inputText, prior?.role);
  if (!prior || recent.role !== "unknown" && recent.role !== prior.role) return recent;
  return { role: prior.role, sellerKnown: [...new Set([...prior.sellerKnown, ...recent.sellerKnown])],
    buyerKnown: [...new Set([...prior.buyerKnown, ...recent.buyerKnown])] };
}
export function customerAgentRenderedQuestion(input: { decision: CustomerAgentDecision; evidence: readonly CustomerAgentEvidence[];
  surface: CustomerAgentSurface; knownPhoneSource: "none" | "current_input" | "scoped_contact"; requestedFacts?: readonly CustomerPropertyFactKind[];
  verifiedContext?: CustomerAgentVerifiedContext; inputText?: string }): CustomerAgentRenderedQuestion {
  const d = input.decision;
  if (d.kind === "skip" || d.kind === "escalate" || d.kind === "moderation_proposal") return "none";
  if (d.kind === "propose") return "confirmation";
  // An evidenced refusal of an unavailable service is already a complete
  // answer. Do not reopen an unrelated job/property intake after it.
  if (!customerRecruitmentRequested(input.inputText ?? "") && input.evidence.some(e =>
    e.value.kind === "company_policy" && e.value.topic === "rental" && !e.value.knowledge.rent && d.refs.includes(e.ref))) return "none";
  if (input.surface === "public_comment" && !input.requestedFacts?.length && customerPublicReaction(input.inputText ?? "")) return "none";
  if (d.question === "topic" && input.evidence.some(e => e.value.kind === "company_information" && d.refs.includes(e.ref))) return "none";
  if (input.evidence.some(e => e.value.kind === "open_vacancies" && (d.refs.includes(e.ref) || customerRecruitmentRequested(input.inputText ?? "") || input.verifiedContext?.publicState.topic === "job"))) {
    const openings = input.evidence.flatMap(e => e.value.kind === "open_vacancies" ? e.value.positions : []);
    if (!openings.length) return "none";
    if (["property", "budget", "location", "rooms", "role", "topic", "seller_details", "preferences", "job_position"].includes(d.question)) return recruitmentPositionForTurn(openings, { inputText: input.inputText,
      knownKey: input.verifiedContext?.publicState.jobPositionKey, turns: input.verifiedContext?.turns }) ? "job_experience" : "job_position";
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
};
function publicRecruitmentQuestion(question: CustomerAgentQuestion, language: "ru" | "tg", experienceIncluded: boolean): string {
  if (question === "job_experience") return experienceIncluded
    ? language === "tg" ? "Дархости корро дар паёми шахсӣ муҳокима карда метавонем." : "Обсудить отклик можно в личных сообщениях."
    : language === "tg" ? "Дар паёми шахсӣ нависед: метавонед резюме фиристед ё дар бораи худ ва таҷрибаатон нақл кунед."
      : "Напишите нам в личные сообщения: можно прислать резюме или рассказать о себе и своём опыте.";
  const privateChannel = language === "tg" ? "Дар паёми шахсӣ нависед." : "Напишите нам в личные сообщения.";
  return `${privateChannel} ${questions[question][language]}`;
}
/** Server-owned template, not a model text or presentation proof. */
export function customerAgentCallbackQuestionText(language: "ru" | "tg"): string { return questions.callback_consent[language]; }
export function customerAgentNameQuestionText(language: "ru" | "tg"): string { return questions.name[language]; }
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
  for (const kind of new Set(value.kinds)) {
    if (kind === "price") {
      const amount = f.price?.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
      const money = amount ? `${amount} ${f.currency === "USD" ? "USD" : tg ? "сомонӣ" : "сомони"}` : null;
      result.push(money ? tg ? `Нархи объект №${f.shortId}: ${money}.` : `Цена объекта №${f.shortId}: ${money}.`
        : tg ? "Нархи дақиқро ҳоло тасдиқ карда наметавонам." : "Точную цену пока не могу подтвердить.");
    }
    if (kind === "address") result.push(f.publicAddress
      ? `${tg ? "Ҷойгиршавӣ" : "Расположение"}: ${f.publicAddress}.`
      : tg ? "Ҷойгиршавии дақиқро ҳоло тасдиқ карда наметавонам." : "Точное расположение пока не могу подтвердить.");
    if (kind === "builder") result.push(tg ? "Маълумоти тасдиқшуда дар бораи сохтмончӣ нест." : "Нет подтверждённых данных о застройщике.");
    if (kind === "characteristics") result.push(...customerPropertyCharacteristicLines(f.characteristics, language, question));
  }
  if (f.availability === "RESERVED") result.push(tg ? "Объект ҳоло дар брон аст." : "Объект сейчас в брони.");
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
export function customerCompanyInformationRequested(text: string): boolean {
  // Automatic reads need an explicit agency question. A commercial property,
  // appointment deadline or quoted publication is not our office/schedule.
  // Ambiguous questions remain available to the model's normal read tools.
  const own = clientOwnWords(text).trim();
  const agencyLocation = /ваш(?:его|ем|им)?\s+офис|офис[ае]?\s+(?:ваш|агентств|royal\s*home)|адрес\s+агентства|где\s+вы\s+находитесь|как\s+к\s+вам\s+(?:добраться|пройти|проехать|доехать|попасть)|(?:дафтари|идораи)\s+шумо|суроғаи\s+(?:шумо|агент)/iu;
  const agencyHours = /когда\s+(?:вы\s+)?работаете|до\s+скольки\s+(?:вы\s+)?работаете|во\s+сколько\s+(?:вы\s+)?открываетесь|ваши\s+часы\s+работы|у\s+вас\s+(?:часы|время)\s+работы|соат[иҳое]*\s+кор(?:иатон|и\s+шумо)/iu;
  const standaloneHours = /^(?:(?:какие\s+)?часы\s+работы|соат[иҳое]*\s+кори?(?:\s+чанд)?)[?.!\s]*$/iu;
  return agencyLocation.test(own) || agencyHours.test(own) || standaloneHours.test(own);
}
function companyInformationLines(value: import("@royal-home/shared").CustomerAgentCompanyInformationObservation, language: "ru" | "tg", text: string): string[] {
  const tg = language === "tg", info = value.information;
  const onlyHours = /час|соат|когда|скольки/iu.test(text) && !/где|адрес|офис|дафтар/iu.test(text);
  const office = tg ? info.officeTg ?? info.office : info.office;
  const address = office.startsWith(info.city) ? office : `${info.city}, ${office}`;
  const lines = onlyHours ? [] : [tg ? `Идораи ${info.name}: ${address}.` : `Офис ${info.name}: ${address}.`];
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
  const catalogEditions = new Set<string>();
  const evidence = referenced.filter(item => {
    if (item?.value.kind !== "open_vacancies") return true;
    const key = JSON.stringify(item.value);
    if (catalogEditions.has(key)) return false;
    catalogEditions.add(key); return true;
  });
  if (d.kind === "propose" && evidence.find(e => e?.ref === d.ref)?.value.kind !== "proposal") return null;
  if (d.kind !== "propose" && evidence.some(e => e?.value.kind === "proposal")) return null;
  const lines: string[] = [];
  let experienceInvitationIncluded = false;
  const applicationSaved = evidence.some(e => e?.value.kind === "receipt" && e.value.outcome === "job_application_saved");
  const requestedKinds = (kinds: readonly CustomerPropertyFactKind[]) => input.requestedFacts.length
    ? kinds.filter(kind => input.requestedFacts.includes(kind)) : [...kinds];
  const perception = input.mediaPerception ? customerAgentMediaPerceptionSchema.safeParse(input.mediaPerception) : undefined;
  if (perception && (!perception.success || input.surface !== "dm")) return null;
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
  } else if (social[d.social][lang]) lines.push(social[d.social][lang]);
  for (const item of evidence) {
    if (!item) return null;
    if (item.value.kind === "facts") lines.push(...factSegments({ ...item.value, kinds: requestedKinds(item.value.kinds) }, lang, input.inputText));
    if (item.value.kind === "publication_properties") {
      const parsed = customerAgentPublicationObservationSchema.safeParse(item.value);
      if (!parsed.success || input.surface !== "public_comment") return null;
      if (parsed.data.cards.length > 1) lines.push(lang === "tg" ? "Объектҳо аз ҳамин нашрия:" : "Объекты из этой публикации:");
      for (const facts of parsed.data.cards) {
        lines.push(...factSegments({ kind: "facts", facts, kinds: requestedKinds(parsed.data.kinds) }, lang, input.inputText));
        if (parsed.data.linksAllowed !== false && parsed.data.cards.length > 1 && facts.publicLink) lines.push(facts.publicLink);
      }
    }
    if (item.value.kind === "receipt") lines.push(outcomes[item.value.outcome][lang]);
    if (item.value.kind === "proposal") lines.push(item.value.summary[lang]);
    if (item.value.kind === "company_policy") {
      if (!isPinnedCompanyPolicy(item.value, input.knowledgeSourceHash)) return null;
      lines.push(policySegment(item.value, lang));
    }
    if (item.value.kind === "company_information") {
      if (!isCustomerCompanyInformation(item.value)) return null;
      lines.push(...companyInformationLines(item.value, lang, input.inputText ?? ""));
    }
    if (item.value.kind === "open_vacancies") {
      if (!isCustomerVacanciesObservation(item.value)) return null;
      // An actual saved application receipt answers a candidate's submission.
      // Reading the catalog to validate the role is not a request to repeat it.
      // Explicit questions about conditions still retain their verified answer.
      const ownQuestion = input.inputText ?? "";
      const explicitQuestion = /[?？]|(?:^|[\s.!])(?:сколько|какой|какая|какие|как|где|когда|чанд|кай|куҷо)(?:[\s?!]|$)/iu.test(ownQuestion);
      if (applicationSaved && !customerRecruitmentFactsRequested(ownQuestion) && !explicitQuestion) continue;
      if (!item.value.positions.length) lines.push(lang === "tg" ? "Ҳоло дар CRM ҷойи кори кушода тасдиқ нашудааст." : "Сейчас в CRM нет подтверждённых открытых вакансий.");
      else {
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
  const attachmentOnly = input.surface === "dm" && input.verifiedContext?.publicState.topic !== "job" && input.inputText !== undefined && !input.inputText.trim() && !!input.attachmentInput && !perception;
  if (attachmentOnly) {
    const attachment = customerAgentAttachmentInputSchema.safeParse(input.attachmentInput);
    if (!attachment.success || d.kind !== "clarify" || d.social !== "none" || d.question !== "clarify_previous" ||
        evidence.some(e => e?.value.kind !== "facts")) return null;
    lines.push(customerAgentAttachmentQuestion(attachment.data, lang, evidence.some(e => e?.value.kind === "facts")));
    const text = lines.filter(Boolean).join("\n");
    return text && text.length <= input.maxOutputChars ? text : null;
  }
  const question = customerAgentRenderedQuestion({ ...input, evidence: evidence.filter((e): e is CustomerAgentEvidence => !!e) });
  const intake = intakeProgress(input);
  // Suppress only the redundant/private question, preserve useful verified
  // facts or a local receipt. No whole-answer erasure or invented success.
  // Explicit facts are useful before any questionnaire. One question can be
  // chosen after the facts, but an unresolved property cannot ask for a phone.
  if (question !== "none" && question !== "confirmation" && !(question === "job_experience" && experienceInvitationIncluded && input.surface !== "public_comment")) lines.push(question === "property" &&
      evidence.some(e => e?.value.kind === "publication_properties" && e.value.cards.length > 1)
    ? lang === "tg" ? "Кадоме аз ин объектҳо ба шумо писанд омад?" : "Какой из этих объектов вас заинтересовал?"
    : input.surface === "public_comment" && question.startsWith("job_")
      ? publicRecruitmentQuestion(question, lang, experienceInvitationIncluded)
    : question === "seller_details" && input.surface === "dm" && intake.role === "seller"
      ? customerSellerIntakeQuestion(intake.sellerKnown, lang)
    : question === "clarify_previous" && input.surface === "dm"
      ? repairPreviousQuestion(input.verifiedContext, lang) ?? questions[question][lang] : questions[question][lang]);
  if (question === "confirmation") lines.push(lang === "tg" ? "Тасдиқ мекунед?" : "Подтверждаете?");
  if (!evidence.length && question === "none" && d.social === "none" && !visualSummary) return null;
  // A suppressed personal-data request by itself is not a useful completed
  // reply, even if the model attached "Понял" to it.
  if ((publicContactQuestion || (d.kind !== "propose" && d.question === "phone" && input.knownPhoneSource !== "none")) &&
      !evidence.length && question === "none") return null;
  const text = lines.filter(Boolean).join("\n");
  // Never truncate a monetary value, receipt or critical proposal summary.
  return text && text.length <= input.maxOutputChars ? text : null;
}
