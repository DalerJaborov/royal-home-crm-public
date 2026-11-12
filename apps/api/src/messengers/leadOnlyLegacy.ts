/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» В СТАРОМ ПУТИ БОТА (messengers/conversation.ts).
 *
 * Решение и текст — та же дверь, что у ядра: ai/leadOnlyMode.ts. Здесь только
 * сбор входа из данных старого пути (переписка BotConversation, черновик заявки,
 * номер WhatsApp-отправителя). Сам приём заявки делает вызывающий — acceptLead,
 * штатная дверь заявок из переписки (импортировать её сюда нельзя: цикл импортов).
 */
import { AGENCY_FACTS } from "../ai/agencyFacts.js";
import { leadOnlyPhoneAskHistory, leadOnlyReply, leadOnlyScenario, type LeadOnlyConfig, type LeadOnlyLanguage,
  type LeadOnlyPhoneState, type LeadOnlyScenario } from "../ai/leadOnlyMode.js";
import { customerSearchContinuation, customerSearchIntent } from "../ai/customerAgentSearchIntent.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import type { ChatMessage } from "../ai/shared.js";
import type { LeadDraft } from "../ai/leadDraft.js";
import { extractVolunteeredPhone } from "../lib/shared/phoneText.js";
import { resolveWhatsAppLeadIdentity } from "../lib/whatsappPhone.js";
import { readCustomerPropertyFacts } from "../lib/customerPropertyFacts.js";
import { leadOnlyMarketSummary, leadOnlyWhen } from "../lib/leadOnlySettings.js";

export interface LegacyLeadOnlyPlan {
  reply: string;
  scenario: LeadOnlyScenario;
  /** Номер для заявки: WhatsApp-отправителя или названный клиентом. null — номера нет. */
  phone: string | null;
  whatsappPhone: string | null;
  propertyId: string | null;
  /** Черновик с намерением и пометкой для агента — для acceptLead. */
  draft: LeadDraft;
}

const NOTE: Record<LeadOnlyScenario, string> = {
  hot: "🔥 Готов смотреть, позвонить сразу",
  property: "Интересует конкретный объект, бот обещал звонок агента",
  seller: "Хочет продать, бот обещал звонок агента",
  buyer: "Ищет недвижимость, бот обещал звонок агента",
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
  language: LeadOnlyLanguage;
}): Promise<LegacyLeadOnlyPlan | null> {
  if (!input.config.enabled || !["WHATSAPP", "INSTAGRAM", "FACEBOOK"].includes(input.channel)) return null;
  const own = clientOwnWords(input.text);
  const scenario = leadOnlyScenario({ text: own, propertyKnown: !!input.propertyId, jobTopic: input.draft.intent === "job", config: input.config });
  if (!scenario) return null;
  // Заявка уже есть: «агент позвонит» не повторяем каждый ход; горячие слова — агенту сразу (это делает вызывающий).
  if (input.linked && scenario !== "hot") return null;
  const turns = input.history.map(m => ({ role: m.role === "user" ? "user" as const : "assistant" as const, text: String(m.content ?? "") }));
  let phone: string | null = null, whatsappPhone: string | null = null, phoneState: LeadOnlyPhoneState;
  const wa = input.channel === "WHATSAPP" && input.config.useWhatsappNumber ? await resolveWhatsAppLeadIdentity(input.channel, input.subscriberId) : null;
  if (wa) {
    phone = wa.leadPhone; whatsappPhone = wa.waPhone; phoneState = { kind: "whatsapp" };
  } else {
    phone = [own, ...turns.filter(t => t.role === "user").map(t => clientOwnWords(t.text)).reverse()]
      .map(text => extractVolunteeredPhone(text)).find(Boolean) ?? null;
    const asked = leadOnlyPhoneAskHistory(turns.filter(t => t.role === "assistant").map(t => t.text));
    phoneState = phone || input.linked ? { kind: "given" }
      : { kind: "ask", asksSoFar: asked.asksSoFar, maxAsks: input.config.maxPhoneAsks, officeAlreadyOffered: asked.officeAlreadyOffered };
  }
  let property = null as { shortId: number; price: string | null; currency: string; sold: boolean } | null;
  if (input.propertyId) {
    const facts = await readCustomerPropertyFacts(input.propertyId, input.channel).catch(() => null);
    if (facts) property = { shortId: facts.shortId, price: facts.price, currency: facts.currency, sold: facts.availability === "SOLD" };
  }
  const market = scenario === "buyer"
    ? await leadOnlyMarketSummary(customerSearchIntent(own, input.language) ?? customerSearchContinuation(own, turns))
    : null;
  const reply = leadOnlyReply({ scenario, language: input.language, phone: phoneState, when: leadOnlyWhen(input.config),
    property, market, sellerCommissionPercent: AGENCY_FACTS.commission.sellerPercent });
  const draft: LeadDraft = { ...input.draft, intent: scenario === "seller" ? "sell" : "buy", confident: true,
    callbackTopic: `${NOTE[scenario]}: «${own.replace(/\s+/g, " ").slice(0, 200)}»`,
    ...(input.propertyId ? { requestedPropertyId: input.propertyId } : {}) };
  return { reply, scenario, phone, whatsappPhone, propertyId: input.propertyId, draft };
}
