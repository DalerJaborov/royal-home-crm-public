/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» В ЯДРЕ БОТА (CORE, lib/customerDmAgentTurn.ts).
 *
 * Решение и текст — общая дверь ai/leadOnlyMode.ts (та же, что у старого пути).
 * Здесь — то, что нужно именно ядру:
 *  1. собрать вход решения из его данных (объект в фокусе, прежние реплики, номер
 *     WhatsApp-отправителя или номер из слов клиента);
 *  2. завести заявку ПОСЛЕ того, как ответ хода спланирован. Привязка карточки к
 *     диалогу меняет bindingRevision, и сделанная внутри хода она отменила бы его
 *     собственный ответ (тот же довод, что у customerNewLeadBridge.ts). Поэтому
 *     ход ставит фоновое задание `customer-lead-only-intake`, а задание ждёт, пока
 *     ход не отпустит ответ, и оформляет заявку тем же приёмом, что и старый путь
 *     и сторож потерянных номеров: acceptLead в тихом режиме (без ответа клиенту,
 *     без записи в переписку) — с объектом, чтобы заявка ушла его агенту.
 */
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { AGENCY_FACTS } from "../ai/agencyFacts.js";
import { leadOnlyPhoneAskHistory, leadOnlyPhoneLine, leadOnlyReply, leadOnlyScenario, type LeadOnlyConfig, type LeadOnlyLanguage,
  type LeadOnlyPhoneState, type LeadOnlyScenario } from "../ai/leadOnlyMode.js";
import { customerSearchContinuation, customerSearchIntent } from "../ai/customerAgentSearchIntent.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { extractVolunteeredPhone } from "./shared/phoneText.js";
import { resolveWhatsAppLeadIdentity } from "./whatsappPhone.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { leadOnlyMarketSummary, leadOnlyWhen } from "./leadOnlySettings.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { logSystemError } from "./systemError.js";

export const CUSTOMER_LEAD_ONLY_INTAKE_JOB = "customer-lead-only-intake";

export const customerLeadOnlyIntakeSchema = z.object({
  version: z.literal(1),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/),
  conversationId: z.string().uuid(),
  scenario: z.enum(["hot", "property", "seller", "buyer", "escalate"]),
  phone: z.string().min(5).max(32),
  whatsappPhone: z.string().min(5).max(32).nullable(),
  propertyId: z.string().uuid().nullable(),
  /** Слова клиента этого хода: суть заявки для агента. */
  clientText: z.string().max(1500),
}).strict();
export type CustomerLeadOnlyIntake = z.infer<typeof customerLeadOnlyIntakeSchema>;

export interface CustomerLeadOnlyTurnInput {
  config: LeadOnlyConfig;
  channel: string;
  peer: string;
  conversationId: string;
  eventKey: string;
  language: LeadOnlyLanguage;
  /** Текущие слова клиента (с отложенными), без вложенного чужого текста. */
  inputText: string;
  /** Объект, определённый сервером в этом ходе (ссылка, пост, реклама, картинка). */
  focusPropertyId: string | null;
  turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  jobTopic: boolean;
  /** Модель решила «передать сотруднику» — в этом режиме это тоже ответ, а не молчание. */
  forced?: "escalate";
}

export interface CustomerLeadOnlyTurnPlan { text: string; scenario: LeadOnlyScenario | "escalate"; intake: CustomerLeadOnlyIntake | null }

/** null — ход не про заявку: его отвечает обычное ядро (без подборок, фото и ссылок). */
export async function planCustomerLeadOnlyTurn(input: CustomerLeadOnlyTurnInput): Promise<CustomerLeadOnlyTurnPlan | null> {
  if (!input.config.enabled || !["WHATSAPP", "INSTAGRAM", "FACEBOOK"].includes(input.channel)) return null;
  const own = clientOwnWords(input.inputText);
  const conversation = await prisma.botConversation.findUnique({ where: { id: input.conversationId }, select: { clientId: true } });
  const linked = !!conversation?.clientId;
  let scenario: LeadOnlyScenario | "escalate" | null = input.forced ?? leadOnlyScenario({ text: own, propertyKnown: !!input.focusPropertyId,
    jobTopic: input.jobTopic, config: input.config });
  // Ответ на просьбу номера («918 22 33 44») сам по себе сценария не несёт: заявка по теме прежних слов клиента.
  const volunteered = !scenario && !linked && !input.jobTopic ? extractVolunteeredPhone(own) : null;
  if (volunteered) {
    const asked = leadOnlyPhoneAskHistory(input.turns.filter(t => t.role === "assistant").map(t => t.text)).asksSoFar > 0;
    const earlier = leadOnlyScenario({ text: input.turns.filter(t => t.role === "user").map(t => clientOwnWords(t.text)).join("\n"),
      propertyKnown: !!input.focusPropertyId, jobTopic: input.jobTopic, config: input.config });
    if (earlier || asked) {
      const intakeScenario = earlier ?? "escalate";
      return { text: leadOnlyPhoneLine({ kind: "given" }, leadOnlyWhen(input.config), input.language) ?? "", scenario: intakeScenario,
        intake: customerLeadOnlyIntakeSchema.parse({ version: 1, eventKey: input.eventKey, conversationId: input.conversationId,
          scenario: intakeScenario, phone: volunteered, whatsappPhone: null, propertyId: input.focusPropertyId, clientText: own.slice(0, 1500) }) };
    }
  }
  if (!scenario) return null;
  // Заявка уже есть: повторять «агент позвонит» каждый ход не нужно. Горячие слова — исключение:
  // агент обязан узнать сразу, что клиент готов ехать.
  if (linked && scenario !== "hot" && scenario !== "escalate") return null;

  let phone: string | null = null, whatsappPhone: string | null = null, phoneState: LeadOnlyPhoneState;
  const wa = input.channel === "WHATSAPP" && input.config.useWhatsappNumber ? await resolveWhatsAppLeadIdentity(input.channel, input.peer) : null;
  if (wa) {
    phone = wa.leadPhone; whatsappPhone = wa.waPhone; phoneState = { kind: "whatsapp" };
  } else {
    const ownTexts = [own, ...input.turns.filter(t => t.role === "user").map(t => clientOwnWords(t.text)).reverse()];
    phone = ownTexts.map(text => extractVolunteeredPhone(text)).find(Boolean) ?? null;
    // WhatsApp с выключенным рубильником «номер WhatsApp» сюда тоже попадает: номер просим, как в Instagram.
    const history = leadOnlyPhoneAskHistory(input.turns.filter(t => t.role === "assistant").map(t => t.text));
    phoneState = phone || linked ? { kind: "given" } : { kind: "ask", asksSoFar: history.asksSoFar, maxAsks: input.config.maxPhoneAsks,
      officeAlreadyOffered: history.officeAlreadyOffered };
  }

  let property = null as { shortId: number; price: string | null; currency: string; sold: boolean } | null;
  if (input.focusPropertyId) {
    const facts = await readCustomerPropertyFacts(input.focusPropertyId, input.channel).catch(() => null);
    if (facts) property = { shortId: facts.shortId, price: facts.price, currency: facts.currency, sold: facts.availability === "SOLD" };
  }
  const market = scenario === "buyer"
    ? await leadOnlyMarketSummary(customerSearchIntent(own, input.language) ?? customerSearchContinuation(own, input.turns))
    : null;
  const text = leadOnlyReply({ scenario, language: input.language, phone: phoneState, when: leadOnlyWhen(input.config),
    property, market, sellerCommissionPercent: AGENCY_FACTS.commission.sellerPercent });
  const intake = phone ? customerLeadOnlyIntakeSchema.parse({ version: 1, eventKey: input.eventKey, conversationId: input.conversationId,
    scenario, phone, whatsappPhone, propertyId: input.focusPropertyId, clientText: own.slice(0, 1500) }) : null;
  return { text, scenario, intake };
}

/** Ставится в той же транзакции, что и ответ хода: ответ без заявки или заявка без ответа не остаются. */
export async function enqueueCustomerLeadOnlyIntakeTx(tx: TxClient, intake: CustomerLeadOnlyIntake): Promise<void> {
  await tx.backgroundJob.create({ data: { type: CUSTOMER_LEAD_ONLY_INTAKE_JOB, payload: intake, maxAttempts: 24,
    dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${intake.eventKey}` } });
}

export type CustomerLeadOnlyIntakeResult = { status: "accepted" | "notified" | "skipped"; reason?: string } |
  { status: "wait"; reason: "turn_not_settled" };

/** Ход ещё держит ответ (план, отправка) — заявку не трогаем, задание повторится. */
async function turnSettled(eventKey: string): Promise<boolean> {
  const ticket = await prisma.customerPropertyIngressTicket.findUnique({ where: { eventKey },
    select: { processingState: true, leaseOwner: true, leaseUntil: true } });
  if (!ticket) return true; // билет исчез — ждать нечего; заявка важнее
  if (!["PLANNED", "HELD", "FAILED"].includes(ticket.processingState ?? "") || ticket.leaseOwner || ticket.leaseUntil) return false;
  const busy = await prisma.customerOutboxPart.count({ where: { ticketEventKey: eventKey, OR: [
    { status: { in: ["READY", "IN_FLIGHT"] } }, { status: "ACCEPTED", projectionRecordedAt: null },
  ] } });
  return busy === 0;
}

const SCENARIO_NOTE: Record<CustomerLeadOnlyIntake["scenario"], string> = {
  hot: "🔥 Готов смотреть, позвонить сразу",
  property: "Интересует конкретный объект, бот обещал звонок агента",
  seller: "Хочет продать, бот обещал звонок агента",
  buyer: "Ищет недвижимость, бот обещал звонок агента",
  escalate: "Вопрос к агенту, бот обещал звонок",
};

/** Фоновая часть: заявка из ядра в режиме «только заявки». Повтор задания безопасен: приём захватывает диалог атомарно. */
export async function runCustomerLeadOnlyIntake(raw: unknown): Promise<CustomerLeadOnlyIntakeResult> {
  const intake = customerLeadOnlyIntakeSchema.parse(raw);
  if (!await turnSettled(intake.eventKey)) return { status: "wait", reason: "turn_not_settled" };
  const conversation = await prisma.botConversation.findUnique({ where: { id: intake.conversationId },
    select: { id: true, channel: true, name: true, clientId: true, leadDraft: true, messages: true } });
  if (!conversation) return { status: "skipped", reason: "conversation_missing" };
  const note = `${SCENARIO_NOTE[intake.scenario]}: «${intake.clientText.replace(/\s+/g, " ").slice(0, 200)}»`;
  if (conversation.clientId) {
    // Карточка уже есть (клиент писал раньше или заявку завели между ходом и заданием): агенту — сразу.
    const { notifyRepeatInquiry } = await import("../services/leads/intake.js");
    await notifyRepeatInquiry(conversation.clientId, note);
    return { status: "notified" };
  }
  // lib → messengers → lib: цикл импортов, поэтому приём берём динамически (как lib/phoneLeadWatchdog.ts).
  const { acceptLead } = await import("../messengers/conversation.js");
  const prior = (conversation.leadDraft ?? { stage: "chatting" }) as Record<string, unknown>;
  const draft = { ...prior, stage: prior.stage === "awaiting_phone" ? "awaiting_phone" : "chatting",
    intent: intake.scenario === "seller" ? "sell" : "buy", confident: true, callbackTopic: note,
    ...(intake.propertyId ? { requestedPropertyId: intake.propertyId } : {}) };
  const result = await acceptLead(conversation.id, conversation.channel as never, conversation.name ?? undefined, intake.phone,
    draft as never, (conversation.messages ?? []) as never, {
      // Объект известен — его агенту сразу, в любое время (сценарий 2). Иначе ночью — утренней волной.
      deferAssignment: intake.propertyId ? false : !(await isWithinWorkingHours()),
      ...(intake.whatsappPhone ? { whatsappPhone: intake.whatsappPhone } : {}),
      clientText: intake.clientText, silent: true, fromHistory: true,
    });
  const linked = await prisma.botConversation.findUnique({ where: { id: conversation.id }, select: { clientId: true } });
  if (!linked?.clientId) {
    if (result.accepted) {
      void logSystemError("ai", `[alarm] Режим «только заявки»: заявка из ядра (диалог ${conversation.id}) принята без карточки. Откройте переписку.`,
        { dedupKey: `lead-only-no-card:${conversation.id}` });
    }
    return { status: "skipped", reason: result.accepted ? "accepted_without_card" : "declined" };
  }
  return { status: "accepted" };
}
