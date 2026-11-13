/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» В ЯДРЕ БОТА (CORE, lib/customerDmAgentTurn.ts).
 *
 * Решение и текст — общая дверь ai/leadOnlyMode.ts (та же, что у старого пути).
 * Здесь — то, что нужно именно ядру:
 *  1. собрать вход решения из его данных (объект в фокусе и пришёл ли он в этом сообщении,
 *     реплики, РЕАЛЬНО ушедшие клиенту, номер WhatsApp-отправителя или номер из слов клиента);
 *  2. завести заявку или позвать человека ПОСЛЕ того, как ответ хода спланирован. Привязка
 *     карточки к диалогу меняет bindingRevision, и сделанная внутри хода она отменила бы его
 *     собственный ответ (тот же довод, что у customerNewLeadBridge.ts). Поэтому ход ставит
 *     фоновое задание `customer-lead-only-intake` в той же транзакции, что и ответ, а задание
 *     ждёт, пока ход отпустит ответ, и оформляет заявку тем же приёмом, что и старый путь:
 *     acceptLead в тихом режиме. Если ответ так и не ушёл (Meta лежит), заявка всё равно
 *     заводится последней попыткой: заявка важнее ответа (jobs/customerLeadOnlyIntake.ts).
 *
 * Правки ревью 13.11.2026: счётчик просьб номера — по отправленному, а не по памяти модели;
 * «передаю агенту» всегда зовёт человека (lib/leadOnlyHandover.ts); вакансии сюда не попадают;
 * «прочее обращение» не получает обещания звонка; номер и слова клиента в задании только
 * зашифрованы.
 */
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { AGENCY_FACTS } from "../ai/agencyFacts.js";
import { leadOnlyAppliesTo, leadOnlyCallbackNotedLine, leadOnlyCallbackTime, leadOnlyGivenLineAvoidingRepeat, leadOnlyNoteWithCallbackTime,
  leadOnlyPhoneAskHistory, leadOnlyPhoneRefused, leadOnlyReplyAvoidingRepeat, leadOnlyScenario, type LeadOnlyConfig, type LeadOnlyLanguage,
  type LeadOnlyPhoneState, type LeadOnlyScenario } from "../ai/leadOnlyMode.js";
import { customerSearchContinuation, customerSearchIntent } from "../ai/customerAgentSearchIntent.js";
import { customerRecruitmentRequested } from "../ai/customerAgentRecruitmentProtocol.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { extractVolunteeredPhone } from "./shared/phoneText.js";
import { resolveWhatsAppLeadIdentity } from "./whatsappPhone.js";
import { readCustomerPropertyFacts } from "./customerPropertyFacts.js";
import { decodeCustomerOutboxPayload } from "./customerOutboxCodec.js";
import { leadOnlyMarketSummary, leadOnlyOtherInquiryReply, leadOnlyPropertyAsked, leadOnlyWhen } from "./leadOnlySettings.js";
import { leadOnlyHumanNotifiedRecently, notifyLeadOnlyHandover, type LeadOnlyHandoverReason } from "./leadOnlyHandover.js";
import { leadOnlyPendingOf, leadOnlyPendingOfRow, type LeadOnlyPending } from "./leadOnlyPending.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { logSystemError } from "./systemError.js";

export const CUSTOMER_LEAD_ONLY_INTAKE_JOB = "customer-lead-only-intake";

/** Номер и слова клиента — только в зашифрованном виде (ревью 13.11: PII открытым текстом в очереди заданий). */
const sealedSchema = z.object({
  phone: z.string().min(5).max(32).nullable(),
  whatsappPhone: z.string().min(5).max(32).nullable(),
  /** Слова клиента этого хода: суть заявки для агента. */
  clientText: z.string().max(1500),
  /** Что бот сказал клиенту: обещал звонок, обещал ответ в чате или ничего. */
  promised: z.enum(["call", "chat"]),
  /** Завести заявку (номер есть, карточки нет). Иначе — только позвать человека. */
  lead: z.boolean(),
  /** Когда клиент просит звонить — его слова (третье ревью 13.11, №4). Старые задания без поля читаются. */
  callbackWhen: z.string().max(200).nullable().optional(),
}).strict();
type CustomerLeadOnlySealed = z.infer<typeof sealedSchema>;

export const customerLeadOnlyIntakeSchema = z.object({
  version: z.literal(2),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/),
  conversationId: z.string().uuid(),
  // «callback» — клиент с карточкой назвал удобное время звонка (третье ревью 13.11, №4).
  scenario: z.enum(["hot", "property", "seller", "buyer", "escalate", "callback"]),
  propertyId: z.string().uuid().nullable(),
  sealed: z.string().min(1).max(8000),
}).strict();
export type CustomerLeadOnlyIntake = z.infer<typeof customerLeadOnlyIntakeSchema>;

export function sealCustomerLeadOnlyIntake(base: Omit<CustomerLeadOnlyIntake, "version" | "sealed">, sealed: CustomerLeadOnlySealed): CustomerLeadOnlyIntake {
  return customerLeadOnlyIntakeSchema.parse({ version: 2, ...base, sealed: encryptSecret(JSON.stringify(sealedSchema.parse(sealed))) });
}
function unseal(intake: CustomerLeadOnlyIntake): CustomerLeadOnlySealed | null {
  try { return sealedSchema.parse(JSON.parse(decryptSecret(intake.sealed))); } catch { return null; }
}

export interface CustomerLeadOnlyTurnInput {
  config: LeadOnlyConfig;
  channel: string;
  peer: string;
  conversationId: string;
  eventKey: string;
  language: LeadOnlyLanguage;
  /** Текущие слова клиента (с отложенными), без вложенного чужого текста. */
  inputText: string;
  /** Объект в фокусе ядра (ссылка, пост, реклама, картинка этого или прошлых ходов). */
  focusPropertyId: string | null;
  /** Фокус определён именно этим сообщением (focus.eventKey === событие хода). */
  focusFromThisMessage: boolean;
  turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  /** Тексты, реально ушедшие клиенту в этом разговоре (readCustomerLeadOnlySentTexts). */
  sentTexts: readonly string[];
  jobTopic: boolean;
  /** Модель решила «передать сотруднику» или фильтр вырезал подборку — в этом режиме это ответ и человек, а не молчание. */
  forced?: "escalate";
}

export interface CustomerLeadOnlyTurnPlan {
  text: string; scenario: LeadOnlyScenario | "escalate" | "callback"; intake: CustomerLeadOnlyIntake | null;
  /** Бот просит номер: о чём (сценарий и объект). Ход записывает это в той же транзакции, что и ответ (lib/leadOnlyPending.ts). */
  remember: LeadOnlyPending | null;
  /** Тема или объект сменились, а номер бот больше не просит: память о прежней просьбе стереть (третье ревью 13.11, №2). */
  forget: boolean;
}

const SENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
/**
 * Что бот РЕАЛЬНО отправил в этом разговоре до текущего входа (ответы ходов и подтверждения передачи).
 * Память модели (verified context) держит только строки из белого списка, а короткий ответ этого режима
 * — одна строка из нескольких фраз, и туда не попадал: счётчик просьб номера был всегда 0 (ревью 13.11).
 * Только для решений сервера; модели не показывается.
 */
export async function readCustomerLeadOnlySentTexts(input: { conversationId: string; endpointScopeId: string; before: Date }): Promise<string[]> {
  const parts = await prisma.customerOutboxPart.findMany({ where: {
    conversationId: input.conversationId, endpointScopeId: input.endpointScopeId, mode: "LIVE",
    sourceKind: { in: ["BOT_TURN", "HANDOVER_ACK"] },
    status: { in: ["READY", "IN_FLIGHT", "ACCEPTED", "AVAILABLE_WIDGET"] },
    supersededAt: null, cancelRequestedAt: null,
    createdAt: { lte: input.before, gte: new Date(input.before.getTime() - SENT_WINDOW_MS) },
  }, orderBy: [{ createdAt: "desc" }, { ordinal: "desc" }], take: 40 });
  const texts: string[] = [];
  for (const part of parts) {
    try {
      const payload = decodeCustomerOutboxPayload(part);
      if (payload.kind === "text" && payload.text.trim()) texts.push(payload.text);
    } catch { /* Нечитаемая часть памяти не даёт. */ }
  }
  return texts.reverse();
}

/** null — ход не про заявку: его отвечает обычное ядро (без подборок, фото и ссылок). */
export async function planCustomerLeadOnlyTurn(input: CustomerLeadOnlyTurnInput): Promise<CustomerLeadOnlyTurnPlan | null> {
  if (!input.config.enabled || !leadOnlyAppliesTo(input.channel)) return null;
  const own = clientOwnWords(input.inputText);
  // Вакансии ведёт рекрутер (Ноза) прежним путём: ни «передаю агенту», ни карточки покупателя (ревью 13.11, №4).
  if (input.jobTopic || customerRecruitmentRequested(own)) return null;
  const conversation = await prisma.botConversation.findUnique({ where: { id: input.conversationId }, select: { clientId: true, leadOnlyPending: true } });
  const linked = !!conversation?.clientId;
  // О чём бот попросил номер прошлым ходом (второе ревью 13.11, №1): номер одним сообщением темы не несёт.
  // У диалога с карточкой памяти нет: просить номер было не у кого (третье ревью 13.11, №2).
  const pending = leadOnlyPendingOfRow(conversation);
  const userTexts = input.turns.filter(t => t.role === "user").map(t => clientOwnWords(t.text));
  // Что бот уже сказал: отправленное и память ядра вместе (память может держать то, чего нет в окне отправленного).
  const sent = [...input.sentTexts, ...input.turns.filter(t => t.role === "assistant").map(t => t.text)];
  // Когда звонить — из этого сообщения, иначе из последнего, где клиент это назвал (третье ревью 13.11, №4).
  const callbackWhen = [own, ...userTexts.slice().reverse()].map(text => leadOnlyCallbackTime(text)).find(Boolean) ?? null;
  const history = leadOnlyPhoneAskHistory(input.sentTexts.length ? input.sentTexts : sent);
  const volunteered = extractVolunteeredPhone(own);
  // Объект разговора: фокус ядра, иначе тот, о котором бот уже просил номер (второе ревью 13.11).
  const knownPropertyId = input.focusPropertyId ?? pending?.propertyId ?? null;
  const propertyInput = { propertyKnown: !!knownPropertyId, propertyInMessage: input.focusFromThisMessage,
    propertyAsked: !!knownPropertyId && leadOnlyPropertyAsked(own), config: input.config };
  let scenario: LeadOnlyScenario | "escalate" | null = input.forced ?? leadOnlyScenario({ text: own, ...propertyInput });
  // Тема пришла словами ЭТОГО сообщения: память о прежней просьбе номера больше не о том (если номер больше не просим).
  const topicNow = !!scenario && !input.forced;
  // Клиент с карточкой назвал, когда ему звонить: короткое «передам агенту» и пометка агенту, а не ответ модели невпопад.
  if (linked && scenario !== "hot" && !input.forced && !volunteered && leadOnlyCallbackTime(own)) {
    return { text: leadOnlyCallbackNotedLine(input.language, sent), scenario: "callback", remember: null, forget: false,
      intake: sealCustomerLeadOnlyIntake({ eventKey: input.eventKey, conversationId: input.conversationId, scenario: "callback", propertyId: null },
        { phone: null, whatsappPhone: null, clientText: own.slice(0, 1500), promised: "call", lead: false, callbackWhen }) };
  }
  // Отказ дать номер — в этом сообщении или раньше: больше не просим, только номер офиса (второе ревью 13.11).
  const refusedNow = leadOnlyPhoneRefused(own);
  const refused = refusedNow || userTexts.some(text => leadOnlyPhoneRefused(text));
  // Сообщение несёт только номер (тема — в прежних словах): ответ — короткое «номер получил», без повтора всей фразы.
  let numberOnly = false, fromPending = false;
  if (!scenario && (volunteered || refusedNow && !linked)) {
    // Номер (или отказ) в ответ на «оставьте номер» сам сценария не несёт: тема — то, о чём бот просил номер,
    // иначе прежние слова клиента.
    const earlier = leadOnlyScenario({ text: userTexts.join("\n"), ...propertyInput, propertyInMessage: false });
    fromPending = !!pending;
    if (volunteered && (pending || earlier || history.asksSoFar > 0 || linked)) { scenario = pending?.scenario ?? earlier ?? "escalate"; numberOnly = true; }
    else if (!volunteered && (pending || earlier)) scenario = pending?.scenario ?? earlier;
  }
  if (!scenario) return null;
  // Карточка уже есть: «агент позвонит» не повторяем каждый ход. Горячие слова, вопрос к сотруднику и
  // новый номер — исключения: агент обязан узнать сразу.
  if (linked && scenario !== "hot" && scenario !== "escalate" && !volunteered) return null;

  let phone: string | null = null, whatsappPhone: string | null = null, phoneState: LeadOnlyPhoneState;
  const wa = input.channel === "WHATSAPP" ? await resolveWhatsAppLeadIdentity(input.channel, input.peer) : null;
  if (volunteered) {
    // Клиент сам назвал номер («нет, звоните на 900…»): звоним на него, номер WhatsApp остаётся запасным.
    phone = volunteered; whatsappPhone = wa?.waPhone ?? null; phoneState = { kind: "given" };
  } else if (wa && input.config.useWhatsappNumber) {
    phone = wa.leadPhone; whatsappPhone = wa.waPhone; phoneState = { kind: "whatsapp" };
  } else if (linked) {
    // Номер в карточке есть, но в этом ходе клиент его не давал: «номер получил» было бы неправдой (ревью №6).
    phoneState = { kind: "card" };
  } else {
    phone = userTexts.slice().reverse().map(text => extractVolunteeredPhone(text)).find(Boolean) ?? null;
    if (phone) whatsappPhone = wa?.waPhone ?? null;
    // WhatsApp с выключенным рубильником «номер WhatsApp» сюда тоже попадает: номер просим, как в Instagram.
    phoneState = phone ? { kind: "given" } : { kind: "ask", asksSoFar: history.asksSoFar, maxAsks: input.config.maxPhoneAsks,
      officeAlreadyOffered: history.officeAlreadyOffered, refused };
  }
  // Объект разговора: этого хода (фокус), а для ответа номером или отказом — тот, о котором бот просил номер.
  const propertyId = fromPending && pending ? pending.propertyId : scenario === "property" || scenario === "hot" ? knownPropertyId : null;

  let property = null as { shortId: number; price: string | null; currency: string; sold: boolean } | null;
  if (propertyId && (scenario === "property" || scenario === "hot")) {
    const facts = await readCustomerPropertyFacts(propertyId, input.channel).catch(() => null);
    if (facts) property = { shortId: facts.shortId, price: facts.price, currency: facts.currency, sold: facts.availability === "SOLD" };
  }
  const market = scenario === "buyer"
    ? await leadOnlyMarketSummary(customerSearchIntent(own, input.language) ?? customerSearchContinuation(own, input.turns))
    : null;
  // Вопрос к сотруднику — не заявка покупателя (ревью №4); но номер в ответ на просьбу — заявка, тема из прежнего черновика.
  const newLead = !!phone && !linked && (scenario !== "escalate" || numberOnly);
  // Без номера и без карточки обычный сценарий заявки человека не зовёт: бот просит номер, а не обещает. Понравившийся
  // объект — исключение (второе ревью, №2): агент объекта узнаёт сразу и может ответить в переписке, даже без номера.
  const needsHuman = scenario === "hot" || scenario === "escalate" || linked || scenario === "property" && !newLead;
  const humanNotified = needsHuman || await leadOnlyHumanNotifiedRecently(input.conversationId).catch(() => false);
  let text = numberOnly
    ? leadOnlyGivenLineAvoidingRepeat(leadOnlyWhen(input.config), input.language, sent)
    : leadOnlyReplyAvoidingRepeat({ scenario, language: input.language, phone: phoneState, when: leadOnlyWhen(input.config),
      property, market, sellerCommissionPercent: AGENCY_FACTS.commission.sellerPercent }, sent, humanNotified);
  // «Прочее обращение» (другой город, услуги, земля…) агенту не назначается: обещать звонок нельзя (правило 17.09.2026).
  let otherInquiry = false;
  if (newLead) {
    const other = await leadOnlyOtherInquiryReply(scenario === "seller" ? "sell" : scenario === "escalate" ? undefined : "buy", [...userTexts, own].join("\n"), input.language);
    if (other) { text = other; otherInquiry = true; }
  }
  // Объект уходит в заявку, только если разговор о нём: покупатель «ищу в Сино» при старом объекте в фокусе
  // не должен уехать агенту того объекта (тот же класс, что объект рекламы в чужой заявке, ревью №10).
  const intakePropertyId = scenario === "property" || scenario === "hot" ? propertyId : null;
  const intake = newLead || needsHuman ? sealCustomerLeadOnlyIntake({ eventKey: input.eventKey, conversationId: input.conversationId,
    scenario, propertyId: intakePropertyId },
  { phone: linked ? volunteered : phone, whatsappPhone, clientText: own.slice(0, 1500), promised: phoneState.kind === "ask" || otherInquiry ? "chat" : "call",
    lead: newLead, callbackWhen }) : null;
  // Бот просит номер (или клиент отказал) — запомнить тему и объект: следующий ход с одним номером возьмёт их отсюда.
  const remember = phoneState.kind === "ask" && scenario !== "escalate" ? leadOnlyPendingOf(scenario, intakePropertyId) : null;
  return { text, scenario, intake, remember, forget: !remember && topicNow && !fromPending && !!pending };
}

/** Ставится в той же транзакции, что и ответ хода: ответ без заявки или заявка без ответа не остаются. */
export async function enqueueCustomerLeadOnlyIntakeTx(tx: TxClient, intake: CustomerLeadOnlyIntake): Promise<void> {
  await tx.backgroundJob.create({ data: { type: CUSTOMER_LEAD_ONLY_INTAKE_JOB, payload: intake, maxAttempts: CUSTOMER_LEAD_ONLY_INTAKE_ATTEMPTS,
    dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${intake.eventKey}` } });
}
/** С лесенкой задания (10, 20, затем по 30 с) это около 11 минут: дольше всех повторов отправки (≈2,5 мин). */
export const CUSTOMER_LEAD_ONLY_INTAKE_ATTEMPTS = 24;

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
  hot: "🔥 Готов смотреть",
  property: "Интересует конкретный объект",
  seller: "Хочет продать",
  buyer: "Ищет недвижимость",
  escalate: "Вопрос к агенту, бот передал сотруднику",
  callback: "Клиент назвал, когда ему звонить",
};
const PROMISE_NOTE = { call: ", бот обещал звонок агента", chat: ", номера нет: ответьте в переписке" } as const;
const HANDOVER_REASON: Record<CustomerLeadOnlyIntake["scenario"], LeadOnlyHandoverReason> = {
  hot: "hot", property: "property", seller: "escalate", buyer: "escalate", escalate: "escalate", callback: "callback_time",
};
const phoneDigits = (value: string | null | undefined) => (value ?? "").replace(/\D/g, "").slice(-9);

/**
 * Фоновая часть: заявка или человек. Повтор задания безопасен: приём захватывает диалог атомарно,
 * уведомление о передаче не чаще раза в несколько часов на диалог. `force` — последняя попытка:
 * ответ хода так и не ушёл (площадка лежит), а заявка и человек важнее ответа.
 */
export async function runCustomerLeadOnlyIntake(raw: unknown, options: { force?: boolean } = {}): Promise<CustomerLeadOnlyIntakeResult> {
  const intake = customerLeadOnlyIntakeSchema.parse(raw);
  if (!options.force && !await turnSettled(intake.eventKey)) return { status: "wait", reason: "turn_not_settled" };
  const conversation = await prisma.botConversation.findUnique({ where: { id: intake.conversationId },
    select: { id: true, channel: true, name: true, clientId: true, leadDraft: true, messages: true } });
  if (!conversation) return { status: "skipped", reason: "conversation_missing" };
  const sealed = unseal(intake);
  if (!sealed) {
    void logSystemError("background-jobs", `[alarm] Режим «только заявки»: данные заявки не читаются (диалог ${conversation.id}). Откройте переписку.`,
      { dedupKey: `lead-only-unsealed:${conversation.id}` });
    await notifyLeadOnlyHandover({ conversationId: conversation.id, propertyId: intake.propertyId, reason: "intake_failed",
      summary: "данные заявки не прочитались" });
    return { status: "notified", reason: "unsealed" };
  }
  const promise = intake.scenario === "escalate" || intake.scenario === "callback" ? "" : PROMISE_NOTE[sealed.promised];
  const note = leadOnlyNoteWithCallbackTime(`${SCENARIO_NOTE[intake.scenario]}${promise}: «${sealed.clientText.replace(/\s+/g, " ").slice(0, 200)}»`,
    sealed.callbackWhen);
  const reason = HANDOVER_REASON[intake.scenario];
  if (conversation.clientId) {
    // Заявку уже завела прошлая попытка этого же задания (или параллельный приём): агента позвал сам приём,
    // второй раз не зовём. Горячим словам — пометка (тот же горячий повод гасится окном в несколько минут).
    if (sealed.lead) {
      if (intake.scenario === "hot") await notifyLeadOnlyHandover({ conversationId: conversation.id, propertyId: intake.propertyId, reason, summary: note });
      return { status: "accepted", reason: "card_exists" };
    }
    // Карточка была до хода: агенту сразу. Новый номер («звоните на 900…») — отдельным поводом на этот номер; тот же
    // номер, что уже в карточке, новым не считается (второе ревью, №9: срочный пуш на каждый повтор того же номера).
    const card = sealed.phone ? await prisma.client.findUnique({ where: { id: conversation.clientId }, select: { phone: true, extraPhones: true } }) : null;
    const known = new Set([card?.phone, ...(card?.extraPhones ?? [])].map(phoneDigits).filter(Boolean));
    const newNumber = !!sealed.phone && !known.has(phoneDigits(sealed.phone));
    await notifyLeadOnlyHandover(newNumber
      ? { conversationId: conversation.id, propertyId: intake.propertyId, reason: "new_phone", key: phoneDigits(sealed.phone),
        summary: `${note}. Клиент просит звонить на ${sealed.phone}` }
      : { conversationId: conversation.id, propertyId: intake.propertyId, reason, summary: note,
        ...(intake.scenario === "callback" && sealed.callbackWhen ? { key: sealed.callbackWhen } : {}) });
    return { status: "notified" };
  }
  // Вопрос к сотруднику или номера нет: человек отвечает в переписке, карточки без номера не бывает.
  if (!sealed.lead || !sealed.phone) {
    await notifyLeadOnlyHandover({ conversationId: conversation.id, propertyId: intake.propertyId, reason, summary: note });
    return { status: "notified" };
  }
  // lib → messengers → lib: цикл импортов, поэтому приём берём динамически (как lib/phoneLeadWatchdog.ts).
  const { acceptLead } = await import("../messengers/conversation.js");
  const prior = (conversation.leadDraft ?? { stage: "chatting" }) as Record<string, unknown>;
  const draft = { ...prior, stage: prior.stage === "awaiting_phone" ? "awaiting_phone" : "chatting",
    // Номер в ответ на просьбу без ясной темы: намерение — из прежнего черновика, классификатор приёма решит сам.
    ...(intake.scenario === "escalate" ? {} : { intent: intake.scenario === "seller" ? "sell" : "buy", confident: true }), callbackTopic: note,
    ...(intake.propertyId ? { requestedPropertyId: intake.propertyId } : {}) };
  const result = await acceptLead(conversation.id, conversation.channel as never, conversation.name ?? undefined, sealed.phone,
    draft as never, (conversation.messages ?? []) as never, {
      // Объект известен — его агенту сразу, в любое время (сценарий 2). Иначе ночью — утренней волной.
      deferAssignment: intake.propertyId ? false : !(await isWithinWorkingHours()),
      ...(sealed.whatsappPhone ? { whatsappPhone: sealed.whatsappPhone } : {}),
      clientText: sealed.clientText, silent: true, fromHistory: true,
    });
  const linked = await prisma.botConversation.findUnique({ where: { id: conversation.id },
    select: { client: { select: { kind: true, assignedAgentId: true } } } });
  if (!linked?.client) {
    // Заявка не оформилась: клиент ждёт звонка, а его нет нигде. Не тихий пропуск, а тревога и человек (ревью №7).
    void logSystemError("ai", `[alarm] Режим «только заявки»: заявка из ядра не оформлена (диалог ${conversation.id}, ` +
      `${result.accepted ? "принята без карточки" : "приём отказал"}). Откройте переписку и заведите карточку руками.`,
      { dedupKey: `lead-only-no-card:${conversation.id}` });
    await notifyLeadOnlyHandover({ conversationId: conversation.id, propertyId: intake.propertyId, reason: "intake_failed", summary: note });
    return { status: "skipped", reason: result.accepted ? "accepted_without_card" : "declined" };
  }
  // Ответ обещал звонок, а приём счёл обращение «прочим» (агенту не назначается): обещание не должно повиснуть.
  if (linked.client.kind === "OTHER" && sealed.promised === "call") {
    void logSystemError("ai", `[alarm] Режим «только заявки»: бот обещал звонок, а заявка ушла в «Прочие обращения» без агента ` +
      `(диалог ${conversation.id}). Позвоните клиенту или напишите ему.`, { dedupKey: `lead-only-other-promised:${conversation.id}` });
    await notifyLeadOnlyHandover({ conversationId: conversation.id, propertyId: intake.propertyId, reason: "no_agent", summary: note });
  }
  return { status: "accepted" };
}
