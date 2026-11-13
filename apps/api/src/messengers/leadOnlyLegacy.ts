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
import { leadOnlyAppliesTo, leadOnlyPhoneAskHistory, leadOnlyPhoneRefused, leadOnlyReplyAvoidingRepeat, leadOnlyScenario, type LeadOnlyConfig,
  type LeadOnlyLanguage, type LeadOnlyPhoneState, type LeadOnlyScenario } from "../ai/leadOnlyMode.js";
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
  scenario: LeadOnlyScenario;
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
  /** Бот просит номер: о чём (сценарий и объект). Вызывающий записывает (lib/leadOnlyPending.ts). */
  remember: LeadOnlyPending | null;
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
}): Promise<LegacyLeadOnlyPlan | null> {
  if (!input.config.enabled || !leadOnlyAppliesTo(input.channel)) return null;
  const own = clientOwnWords(input.text);
  const jobTopic = input.jobTopic || input.draft.intent === "job";
  let scenario = leadOnlyScenario({ text: own, propertyKnown: !!input.propertyId, propertyInMessage: input.propertyInMessage,
    propertyAsked: !!input.propertyId && leadOnlyPropertyAsked(own), jobTopic, config: input.config });
  const userWords = input.history.filter(m => m.role === "user").map(m => clientOwnWords(String(m.content ?? "")));
  // Отказ дать номер (в этом сообщении или раньше): больше не просим, «хорошо, без проблем» и номер офиса (второе ревью 13.11).
  const refusedNow = leadOnlyPhoneRefused(own);
  const refused = refusedNow || userWords.some(text => leadOnlyPhoneRefused(text));
  let propertyId = scenario === "property" || scenario === "hot" ? input.propertyId : null;
  if (!scenario && refusedNow && !input.linked && !jobTopic) {
    // Отказ сам темы не несёт: тема — то, о чём бот просил номер, иначе прежние слова клиента.
    scenario = input.pending?.scenario ?? leadOnlyScenario({ text: userWords.join("\n"), propertyKnown: !!input.propertyId, jobTopic, config: input.config });
    propertyId = input.pending ? input.pending.propertyId : scenario === "property" || scenario === "hot" ? input.propertyId : null;
  }
  if (!scenario) return null;
  // Заявка уже есть: «агент позвонит» не повторяем каждый ход; горячие слова — агенту сразу (это делает вызывающий).
  if (input.linked && scenario !== "hot") return null;
  const turns = input.history.map(m => ({ role: m.role === "user" ? "user" as const : "assistant" as const, text: String(m.content ?? "") }));
  const sent = turns.filter(t => t.role === "assistant").map(t => t.text);
  let phone: string | null = null, whatsappPhone: string | null = null, phoneState: LeadOnlyPhoneState;
  const wa = input.channel === "WHATSAPP" && input.config.useWhatsappNumber ? await resolveWhatsAppLeadIdentity(input.channel, input.subscriberId) : null;
  if (wa) {
    phone = input.linked ? null : wa.leadPhone; whatsappPhone = wa.waPhone; phoneState = { kind: "whatsapp" };
  } else if (input.linked) {
    // Номер в карточке, а в этом ходе его не давали: «номер получил» было бы неправдой (ревью 13.11, №6).
    phoneState = { kind: "card" };
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
  const draft: LeadDraft = { ...input.draft, intent: scenario === "seller" ? "sell" : "buy", confident: true,
    callbackTopic: `${(promised === "call" ? NOTE : NOTE_CHAT)[scenario]}: «${own.replace(/\s+/g, " ").slice(0, 200)}»`,
    ...(propertyId ? { requestedPropertyId: propertyId } : {}) };
  return { reply, scenario, phone, whatsappPhone, propertyId, draft, promised,
    // Горячие слова или объект без новой заявки (номера нет или карточка уже есть) — человека зовёт вызывающий.
    needsHuman,
    remember: phoneState.kind === "ask" ? leadOnlyPendingOf(scenario, propertyId) : null };
}

/**
 * Клиент прислал номер в ответ на просьбу: у самого сообщения сценария нет, тема — в прежних
 * словах. Черновик с намерением нужен приёму, иначе заявка уйдёт «прочим обращением» без агента.
 */
export function legacyLeadOnlyDraftForPhone(input: { config: LeadOnlyConfig; history: ChatMessage[]; text: string; draft: LeadDraft;
  propertyId: string | null; jobTopic?: boolean; pending?: LeadOnlyPending | null }): LeadDraft {
  const jobTopic = input.jobTopic || input.draft.intent === "job";
  // О чём бот просил номер (второе ревью 13.11, №1): пост объекта прошлого хода, а этот ход — один номер.
  if (input.pending && !jobTopic) {
    const { scenario, propertyId } = input.pending;
    return { ...input.draft, intent: scenario === "seller" ? "sell" : "buy", confident: true,
      callbackTopic: input.draft.callbackTopic ?? NOTE[scenario], ...(propertyId ? { requestedPropertyId: propertyId } : {}) };
  }
  const words = [...input.history.filter(m => m.role === "user").map(m => clientOwnWords(String(m.content ?? ""))), clientOwnWords(input.text)];
  const joined = words.join("\n");
  const scenario = leadOnlyScenario({ text: joined, propertyKnown: !!input.propertyId,
    propertyAsked: !!input.propertyId && leadOnlyPropertyAsked(joined), jobTopic, config: input.config });
  if (!scenario) return input.draft;
  const withProperty = (scenario === "property" || scenario === "hot") && input.propertyId && !input.draft.requestedPropertyId;
  return { ...input.draft, intent: input.draft.intent ?? (scenario === "seller" ? "sell" : "buy"), confident: true,
    callbackTopic: input.draft.callbackTopic ?? NOTE[scenario],
    ...(withProperty ? { requestedPropertyId: input.propertyId! } : {}) };
}
