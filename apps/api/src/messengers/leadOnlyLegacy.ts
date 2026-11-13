/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» В СТАРОМ ПУТИ БОТА (messengers/conversation.ts).
 *
 * Решение и текст — та же дверь, что у ядра: ai/leadOnlyMode.ts. Здесь только
 * сбор входа из данных старого пути (переписка BotConversation, черновик заявки,
 * номер WhatsApp-отправителя). Сам приём заявки делает вызывающий — acceptLead,
 * штатная дверь заявок из переписки (импортировать её сюда нельзя: цикл импортов);
 * «передаю агенту» без заявки — lib/leadOnlyHandover.ts, тоже у вызывающего.
 */
import { AGENCY_FACTS } from "../ai/agencyFacts.js";
import { LEAD_ONLY_NO_CALL_NOTE, leadOnlyAppliesTo, leadOnlyCallbackNotedLine, leadOnlyCallbackTime, leadOnlyCallDeclined,
  leadOnlyNoCallNotedLine, leadOnlyNoteWithCallbackTime, leadOnlyPhoneAskHistory, leadOnlyPhoneRefused, leadOnlyRecentCallbackTime,
  leadOnlyReplyAvoidingRepeat, leadOnlyScenario, type LeadOnlyConfig, type LeadOnlyLanguage, type LeadOnlyPhoneState,
  type LeadOnlyScenario } from "../ai/leadOnlyMode.js";
import { customerSearchContinuation, customerSearchIntent } from "../ai/customerAgentSearchIntent.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import type { ChatMessage } from "../ai/shared.js";
import type { LeadDraft } from "../ai/leadDraft.js";
import { extractVolunteeredPhone } from "../lib/shared/phoneText.js";
import { resolveWhatsAppLeadIdentity } from "../lib/whatsappPhone.js";
import { readCustomerPropertyFacts } from "../lib/customerPropertyFacts.js";
import { leadOnlyMarketSummary, leadOnlyOtherInquiryReply, leadOnlyPropertyAsked, leadOnlyWhen } from "../lib/leadOnlySettings.js";
import { leadOnlyPendingOf, type LeadOnlyPending } from "../lib/leadOnlyPending.js";

export interface LegacyLeadOnlyPlan {
  reply: string;
  /** «callback» — клиент с карточкой назвал удобное время звонка: заявки нет, агенту — пометка.
   * «no_call» — клиент с карточкой просит не звонить: звонок не обещаем, агенту — пометка «писать в чат». */
  scenario: LeadOnlyScenario | "callback" | "no_call";
  /** Номер для заявки: WhatsApp-отправителя или названный клиентом. null — номера нет (или карточка уже есть). */
  phone: string | null;
  whatsappPhone: string | null;
  propertyId: string | null;
  /** Черновик с намерением и пометкой для агента — для acceptLead. */
  draft: LeadDraft;
  /** Бот обещал звонок («call») или ответ в чате («chat»): нужен для проверки после приёма. */
  promised: "call" | "chat";
  /** Ответ говорит «передаю агенту» (или объект без номера) без новой заявки: вызывающий обязан позвать человека. */
  needsHuman: boolean;
  /** Бот просит номер: о чём (сценарий и объект). Вызывающий записывает вместе с ответом (lib/leadOnlyPending.ts). */
  remember: LeadOnlyPending | null;
  /** Тема или объект сменились, а номер бот больше не просит: память о прежней просьбе стереть. */
  forget: boolean;
  /** Когда клиент просит звонить (его слова), если назвал. */
  callbackTime: string | null;
}

const NOTE: Record<LeadOnlyScenario, string> = {
  hot: "🔥 Готов смотреть, позвонить сразу",
  property: "Интересует конкретный объект, бот обещал звонок агента",
  seller: "Хочет продать, бот обещал звонок агента",
  buyer: "Ищет недвижимость, бот обещал звонок агента",
};
const NOTE_CHAT: Record<LeadOnlyScenario, string> = {
  hot: "🔥 Готов смотреть, номера нет: ответьте в переписке",
  property: "Интересует конкретный объект, номера нет: ответьте в переписке",
  seller: "Хочет продать, номера нет",
  buyer: "Ищет недвижимость, номера нет",
};

/** Без обещания звонка: суть для агента и пометка «писать в чат» (четвёртое ревью 13.11, №1). */
const LABEL: Record<LeadOnlyScenario, string> = { hot: "🔥 Готов смотреть", property: "Интересует конкретный объект", seller: "Хочет продать",
  buyer: "Ищет недвижимость" };

/** Когда звонить — из этого сообщения, иначе из последнего сообщения клиента за сутки, где он это назвал (четвёртое ревью, №5). */
function callbackTimeOf(own: string, history: readonly ChatMessage[], now: Date): string | null {
  const earlier = history.filter(m => m.role === "user").map(m => ({ text: clientOwnWords(String(m.content ?? "")), at: m.at ?? null }));
  return leadOnlyRecentCallbackTime(own, earlier, now);
}

export async function planLegacyLeadOnlyTurn(input: {
  config: LeadOnlyConfig;
  channel: string;
  subscriberId: string;
  /** Карточка уже привязана к диалогу. */
  linked: boolean;
  text: string;
  history: ChatMessage[];
  draft: LeadDraft;
  propertyId: string | null;
  /** Объект пришёл именно в этом сообщении (поделился постом, реклама, ссылка этого хода). */
  propertyInMessage: boolean;
  language: LeadOnlyLanguage;
  /** Разговор о работе (реклама вакансии и т. п.) — вакансии ведёт Ноза, режим их не трогает. */
  jobTopic?: boolean;
  /** О чём бот попросил номер прошлым ходом (lib/leadOnlyPending.ts). */
  pending?: LeadOnlyPending | null;
  /** Человек по этому диалогу уже позван недавно: «агент уже в курсе» правдиво. */
  humanNotified?: boolean;
  /** Сейчас (время звонка берётся из сообщений за сутки). */
  now?: Date;
}): Promise<LegacyLeadOnlyPlan | null> {
  if (!input.config.enabled || !leadOnlyAppliesTo(input.channel)) return null;
  const own = clientOwnWords(input.text);
  const jobTopic = input.jobTopic || input.draft.intent === "job";
  let scenario = leadOnlyScenario({ text: own, propertyKnown: !!input.propertyId, propertyInMessage: input.propertyInMessage,
    propertyAsked: !!input.propertyId && leadOnlyPropertyAsked(own), jobTopic, config: input.config });
  // Тема пришла словами ЭТОГО сообщения (а не из памяти просьбы): прежняя просьба номера больше не о том.
  const topicNow = !!scenario;
  const userWords = input.history.filter(m => m.role === "user").map(m => clientOwnWords(String(m.content ?? "")));
  const turns = input.history.map(m => ({ role: m.role === "user" ? "user" as const : "assistant" as const, text: String(m.content ?? "") }));
  const sent = turns.filter(t => t.role === "assistant").map(t => t.text);
  const callbackTime = jobTopic ? null : callbackTimeOf(own, input.history, input.now ?? new Date());
  // Клиент с карточкой назвал, когда ему звонить (третье ревью 13.11, №4): агент узнаёт, звонок не невпопад.
  if (input.linked && !jobTopic && scenario !== "hot" && leadOnlyCallbackTime(own)) {
    return { reply: leadOnlyCallbackNotedLine(input.language, sent), scenario: "callback", phone: null, whatsappPhone: null, propertyId: null,
      draft: input.draft, promised: "call", needsHuman: true, remember: null, forget: false, callbackTime };
  }
  // Отказ дать номер или от звонка (в этом сообщении или раньше, если сейчас клиент сам не просит позвонить): больше не просим,
  // звонок не обещаем, «хорошо, без проблем» и номер офиса (второе ревью 13.11; четвёртое, №1).
  const refusedNow = leadOnlyPhoneRefused(own);
  const refused = leadOnlyCallDeclined(own, userWords);
  // Клиент с карточкой просит не звонить: «агент ответит вам здесь», агенту — пометка «писать в чат» (четвёртое ревью, №1).
  if (input.linked && !jobTopic && scenario !== "hot" && refusedNow) {
    return { reply: leadOnlyNoCallNotedLine(input.language, sent), scenario: "no_call", phone: null, whatsappPhone: null, propertyId: null,
      draft: input.draft, promised: "chat", needsHuman: true, remember: null, forget: false, callbackTime: null };
  }
  let propertyId = scenario === "property" || scenario === "hot" ? input.propertyId : null;
  if (!scenario && refusedNow && !input.linked && !jobTopic) {
    // Отказ сам темы не несёт: тема — то, о чём бот просил номер, иначе прежние слова клиента.
    scenario = input.pending?.scenario ?? leadOnlyScenario({ text: userWords.join("\n"), propertyKnown: !!input.propertyId, jobTopic, config: input.config });
    propertyId = input.pending ? input.pending.propertyId : scenario === "property" || scenario === "hot" ? input.propertyId : null;
  }
  if (!scenario) return null;
  // Заявка уже есть: «агент позвонит» не повторяем каждый ход; горячие слова — агенту сразу (это делает вызывающий).
  if (input.linked && scenario !== "hot") return null;
  let phone: string | null = null, whatsappPhone: string | null = null, phoneState: LeadOnlyPhoneState;
  const wa = input.channel === "WHATSAPP" && input.config.useWhatsappNumber ? await resolveWhatsAppLeadIdentity(input.channel, input.subscriberId) : null;
  // Номер есть (WhatsApp, карточка), но клиент просил не звонить: звонок не обещаем и номер не просим (четвёртое ревью, №1).
  const noCallState = (): LeadOnlyPhoneState => {
    const asked = leadOnlyPhoneAskHistory(sent);
    return { kind: "ask", asksSoFar: asked.asksSoFar, maxAsks: input.config.maxPhoneAsks, officeAlreadyOffered: asked.officeAlreadyOffered, refused: true };
  };
  if (wa) {
    phone = input.linked ? null : wa.leadPhone; whatsappPhone = wa.waPhone; phoneState = refused ? noCallState() : { kind: "whatsapp" };
  } else if (input.linked) {
    // Номер в карточке, а в этом ходе его не давали: «номер получил» было бы неправдой (ревью 13.11, №6).
    phoneState = refused ? noCallState() : { kind: "card" };
  } else {
    phone = [own, ...turns.filter(t => t.role === "user").map(t => clientOwnWords(t.text)).reverse()]
      .map(text => extractVolunteeredPhone(text)).find(Boolean) ?? null;
    const asked = leadOnlyPhoneAskHistory(sent);
    phoneState = phone ? { kind: "given" }
      : { kind: "ask", asksSoFar: asked.asksSoFar, maxAsks: input.config.maxPhoneAsks, officeAlreadyOffered: asked.officeAlreadyOffered, refused };
  }
  // Объект — только для разговора о нём: старый объект в фокусе не уводит покупателя «в Сино» к своему агенту.
  // Понравившийся объект без номера: агент объекта узнаёт сразу и может ответить в переписке (второе ревью, №2).
  const newLead = !!phone && !input.linked;
  const needsHuman = (scenario === "hot" || scenario === "property") && !newLead;
  let property = null as { shortId: number; price: string | null; currency: string; sold: boolean } | null;
  if (propertyId) {
    const facts = await readCustomerPropertyFacts(propertyId, input.channel).catch(() => null);
    if (facts) property = { shortId: facts.shortId, price: facts.price, currency: facts.currency, sold: facts.availability === "SOLD" };
  }
  const market = scenario === "buyer"
    ? await leadOnlyMarketSummary(customerSearchIntent(own, input.language) ?? customerSearchContinuation(own, turns))
    : null;
  let reply = leadOnlyReplyAvoidingRepeat({ scenario, language: input.language, phone: phoneState, when: leadOnlyWhen(input.config),
    property, market, sellerCommissionPercent: AGENCY_FACTS.commission.sellerPercent }, sent, needsHuman || input.humanNotified === true);
  // «Прочее обращение» (другой город, услуги…) агенту не назначается: обещать звонок нельзя (правило 17.09.2026).
  let otherInquiry = false;
  if (phone && !input.linked) {
    const words = [...turns.filter(t => t.role === "user").map(t => clientOwnWords(t.text)), own].join("\n");
    const other = await leadOnlyOtherInquiryReply(scenario === "seller" ? "sell" : "buy", words, input.language);
    if (other) { reply = other; otherInquiry = true; }
  }
  const promised = phoneState.kind === "ask" || otherInquiry ? "chat" as const : "call" as const;
  const said = own.replace(/\s+/g, " ").slice(0, 200);
  // Отказ от звонка при известном номере (WhatsApp): заявка есть, но агенту — «писать в чат», а не «номера нет».
  const note = refused && phone ? `${LABEL[scenario]}. ${LEAD_ONLY_NO_CALL_NOTE}: «${said}»` : `${(promised === "call" ? NOTE : NOTE_CHAT)[scenario]}: «${said}»`;
  const draft: LeadDraft = { ...input.draft, intent: scenario === "seller" ? "sell" : "buy", confident: true,
    callbackTopic: leadOnlyNoteWithCallbackTime(note, refused ? null : callbackTime), ...(propertyId ? { requestedPropertyId: propertyId } : {}) };
  // Номер уже есть (WhatsApp, клиент просил не звонить) — помнить нечего.
  const remember = phoneState.kind === "ask" && !phone ? leadOnlyPendingOf(scenario, propertyId) : null;
  return { reply, scenario, phone, whatsappPhone, propertyId, draft, promised,
    // Горячие слова или объект без новой заявки (номера нет или карточка уже есть) — человека зовёт вызывающий.
    needsHuman, remember, forget: !remember && topicNow && !!input.pending, callbackTime };
}

/**
 * Клиент прислал номер (старый путь, ветка номера). Тема и объект ЭТОГО сообщения сильнее памяти просьбы
 * (третье ревью 13.11, №1): через три дня после поста объекта A «хочу продать свою квартиру, 93…» — продавец,
 * а пост объекта B с номером — заявка по B. Память просьбы (lib/leadOnlyPending.ts) — тема только голого номера,
 * иначе прежние слова клиента. Черновик с намерением нужен приёму, иначе заявка уйдёт «прочим обращением».
 */
export function legacyLeadOnlyDraftForPhone(input: { config: LeadOnlyConfig; history: ChatMessage[]; text: string; draft: LeadDraft;
  /** Объект ЭТОГО сообщения: пост, реклама, ссылка этого хода. */
  freshPropertyId: string | null;
  /** Объект, оставшийся с прошлых ходов (названный в черновике). */
  carriedPropertyId: string | null;
  jobTopic?: boolean; pending?: LeadOnlyPending | null; now?: Date }): LeadDraft {
  const jobTopic = input.jobTopic || input.draft.intent === "job";
  if (jobTopic) return input.draft;
  const own = clientOwnWords(input.text);
  const earlier = input.history.filter(m => m.role === "user").map(m => clientOwnWords(String(m.content ?? "")));
  const callbackTime = callbackTimeOf(own, input.history, input.now ?? new Date());
  // `fresh` — тема этого сообщения: она важнее старой темы из черновика модели (четвёртое ревью 13.11, №5).
  const withTime = (draft: LeadDraft, note: string, fresh = false): LeadDraft =>
    ({ ...draft, callbackTopic: leadOnlyNoteWithCallbackTime(fresh ? note : input.draft.callbackTopic ?? note, callbackTime) });
  // 1. Тема этого сообщения. Объект разговора: пришедший сейчас, иначе тот, о котором просили номер, иначе из черновика.
  const knownPropertyId = input.freshPropertyId ?? input.pending?.propertyId ?? input.carriedPropertyId;
  const current = leadOnlyScenario({ text: own, propertyKnown: !!knownPropertyId, propertyInMessage: !!input.freshPropertyId,
    propertyAsked: !!knownPropertyId && leadOnlyPropertyAsked(own), jobTopic, config: input.config });
  if (current) {
    const propertyId = current === "property" || current === "hot" ? knownPropertyId : null;
    // Продавец говорит о СВОЁМ объекте: прежний чужой объект из черновика его заявку не уводит (правило 02.10.2026).
    return withTime({ ...input.draft, intent: current === "seller" ? "sell" : "buy", confident: true,
      ...(current === "seller" ? { requestedPropertyId: undefined } : {}),
      ...(propertyId ? { requestedPropertyId: propertyId } : {}) }, `${NOTE[current]}: «${own.replace(/\s+/g, " ").slice(0, 200)}»`, true);
  }
  // 2. Голый номер в ответ на просьбу: тема и объект — о чём бот просил номер (второе ревью 13.11, №1).
  if (input.pending) {
    const { scenario, propertyId } = input.pending;
    return withTime({ ...input.draft, intent: scenario === "seller" ? "sell" : "buy", confident: true,
      ...(propertyId ? { requestedPropertyId: propertyId } : {}) }, NOTE[scenario]);
  }
  // 3. Иначе — прежние слова клиента.
  const joined = [...earlier, own].join("\n");
  const scenario = leadOnlyScenario({ text: joined, propertyKnown: !!input.carriedPropertyId,
    propertyAsked: !!input.carriedPropertyId && leadOnlyPropertyAsked(joined), jobTopic, config: input.config });
  if (!scenario) return callbackTime ? withTime(input.draft, "Клиент оставил номер") : input.draft;
  const withProperty = (scenario === "property" || scenario === "hot") && input.carriedPropertyId && !input.draft.requestedPropertyId;
  return withTime({ ...input.draft, intent: input.draft.intent ?? (scenario === "seller" ? "sell" : "buy"), confident: true,
    ...(withProperty ? { requestedPropertyId: input.carriedPropertyId! } : {}) }, NOTE[scenario]);
}
