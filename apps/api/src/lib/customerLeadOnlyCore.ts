/**
 * РЕЖИМ «ТОЛЬКО ЗАЯВКИ» В ЯДРЕ БОТА (CORE, lib/customerDmAgentTurn.ts) — ВЕДЁТ ОПЕРАТОР ПРИЁМА ЗАЯВОК (этап 1.2, 19.11.2026).
 *
 * Весь ход в режиме — одна дверь ai/operator (runOperatorTurn): понять → решить шаг → фраза. Свободная модель ядра в
 * режиме не вызывается никогда (docs/bot-operator/SPEC.md, «один хозяин разговора»); сбой понимания — запасные правила
 * оператора. Здесь — то, что нужно именно ядру:
 *  1. собрать вход оператора из данных ядра (lib/operatorTurn.ts: объект в фокусе или объект рекламы, бренд, вакансии,
 *     рабочие часы) и вложения хода (расшифровка голосового, наш / чужой пост);
 *  2. превратить действия оператора в фоновое задание `customer-lead-only-intake` в той же транзакции, что и ответ:
 *     привязка карточки меняет bindingRevision и отменила бы ответ хода (довод customerNewLeadBridge.ts), поэтому заявку
 *     оформляет задание после хода тем же приёмом, что и старый путь (acceptLead в тихом режиме). Ответ так и не ушёл —
 *     заявка всё равно заводится последней попыткой: заявка важнее ответа (jobs/customerLeadOnlyIntake.ts).
 * Номер и слова клиента в задании — только зашифрованы (ревью 13.11).
 */
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { encryptSecret, decryptSecret } from "../crypto.js";
import { LEAD_ONLY_NO_CALL_NOTE, leadOnlyNoteWithCallbackTime, leadOnlyOutgoing, leadOnlyAppliesTo, type LeadOnlyConfig } from "../ai/leadOnlyMode.js";
import type { LeadOnlyIntentModel } from "../ai/leadOnlyIntent.js";
import { clientOwnWords } from "../ai/untrustedContent.js";
import { runOperatorTurn, type OperatorAction, type OperatorStaffReason, type OperatorTurnResult, type OperatorVoice } from "../ai/operator/index.js";
import { resolveWhatsAppLeadIdentity } from "./whatsappPhone.js";
import { decodeCustomerOutboxPayload } from "./customerOutboxCodec.js";
import { alarmLeadOnlyIntake, noteLeadOnlyNewPhone, noteLeadOnlyOnCard } from "./leadOnlyHandover.js";
import { loadOperatorTurnSetup } from "./operatorTurn.js";
import { isWithinWorkingHours } from "./workingHours.js";
import { logSystemError } from "./systemError.js";
import { LEAD_MODEL_FAILED_NOTE } from "../services/leads/intentUnknown.js";
import { AGENCY_FACTS } from "../ai/agencyFacts.js";
import { findContinuationCode, operatorContactAsk, planOperatorContactButton, stripContinuationMarker } from "../ai/operator/contactButton.js";
import { serializeOperatorState } from "../ai/operator/state.js";
import type { CustomerContactButton } from "./customerDeliveryContracts.js";
import { loadContactButtonPolicy } from "./contactButtonPolicy.js";
import { leadOnlyCardAgentActive } from "./leadOnlyHandover.js";
import { consumeWhatsappContinuationCode, continuationSeedState, enqueueWhatsappContinuationLinkTx, insertWhatsappContinuationCodeTx,
  operatorStateFresh, prepareWhatsappContinuationCode, type PreparedContinuationCode, type WhatsappContinuation,
  type WhatsappContinuationLink } from "./whatsappContinuation.js";

import { CUSTOMER_LEAD_ONLY_INTAKE_JOB } from "./operatorTurn.js";
export { CUSTOMER_LEAD_ONLY_INTAKE_JOB };

/** Номер и слова клиента — только в зашифрованном виде (ревью 13.11: PII открытым текстом в очереди заданий). */
const sealedSchema = z.object({
  phone: z.string().min(5).max(32).nullable(),
  whatsappPhone: z.string().min(5).max(32).nullable(),
  /** Слова клиента этого хода: суть заявки для агента. */
  clientText: z.string().max(1500),
  /** Что бот сказал клиенту: обещал звонок, обещал ответ в чате или ничего. */
  promised: z.enum(["call", "chat"]),
  /** Завести заявку (номер есть, карточки нет). Иначе — только пометка в карточке. */
  lead: z.boolean(),
  /** Когда клиент просит звонить — его слова (третье ревью 13.11, №4). Старые задания без поля читаются. */
  callbackWhen: z.string().max(200).nullable().optional(),
  /** Клиент просит не звонить, а писать в чат (четвёртое ревью 13.11, №1). Старые задания без поля читаются. */
  noCall: z.boolean().optional(),
  /** Заметка оператора агенту (роль, детали, пожелания, слова клиента). Старые задания без поля читаются. */
  note: z.string().max(800).optional(),
}).strict();
type CustomerLeadOnlySealed = z.infer<typeof sealedSchema>;

export const customerLeadOnlyIntakeSchema = z.object({
  version: z.literal(2),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/),
  conversationId: z.string().uuid(),
  // «callback» / «no_call» — прежние пометки в карточке; «note» — пометка оператора к уже принятой заявке.
  scenario: z.enum(["hot", "property", "seller", "buyer", "escalate", "callback", "no_call", "note"]),
  propertyId: z.string().uuid().nullable(),
  /** The model failed on the customer's question (WhatsApp, number known): one such lead per conversation, with a card note. */
  modelFailed: z.literal(true).optional(),
  /** Объект не в Душанбе (оператор): зацепка этапа 1.5 — решение директора. До него заявка идёт обычным приёмом. */
  outOfArea: z.literal(true).optional(),
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
  /** Текущие слова клиента (с отложенными и с расшифровкой голосового), без вложенного чужого текста. */
  inputText: string;
  /** Объект в фокусе ядра (ссылка, пост, реклама, картинка этого или прошлых ходов). */
  focusPropertyId: string | null;
  turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
  /**
   * Канал ядра этого разговора: по нему читаются ответы бота, отправленные И стоящие в очереди (`readCustomerLeadOnlySentTexts`),
   * чтобы ответ, ещё не доставленный к следующему сообщению серии, не считался «не заданным» (слепое ревью #371).
   */
  endpointScopeId?: string;
  /** Вложения хода, как их видит ядро: голосовое расшифровано или нет, наш пост, чужой пост, фото/видео. */
  attachments?: Partial<{ voice: OperatorVoice; ownPost: boolean; foreignPost: boolean; foreignQuiet: boolean; media: boolean }>;
  now?: Date;
  /** Только для тестов: подмена модели понимания оператора. */
  model?: LeadOnlyIntentModel;
  /** Только для тестов: подмена модели «своими словами». */
  composeModel?: LeadOnlyIntentModel;
}

export interface CustomerLeadOnlyTurnPlan {
  /** Ответ клиенту; null — оператор решил молчать (ход завершается без ответа, это намеренная тишина). */
  text: string | null;
  /** Заявка и/или пометка для фонового приёма — в той же транзакции, что и ответ. */
  intakes: CustomerLeadOnlyIntake[];
  /** Память оператора для `BotConversation.leadOnlyPending`. */
  operator: OperatorTurnResult;
  /**
   * Дверь «клиент ждёт» (follow_up): грубость и жалоба (до заявки людей не беспокоим, решение владельца 13.11.2026) и пометка
   * в карточку без живого агента (ревью 19.11, Р4). Кому именно — решает сама дверь (агент карточки или директор).
   */
  signal?: { kind: "follow_up"; reason?: OperatorStaffReason };
  /** Ход отдан прежнему пути рекрутёра (вакансия, ревью 19.11, Р6): ответа нет, ядро идёт своим обычным путём. */
  handoff?: "recruiter";
  /** Отметка времени памяти, от которой оператор решал (Р14): запись сверяет её, устаревшее решение не пишется. */
  baseUpdatedAt: string | null;
  /** Кнопка под ответом: звонок в WhatsApp или ссылка wa.me из Instagram/Facebook (ai/operator/contactButton.ts). */
  button?: CustomerContactButton;
  /** Код продолжения в ссылке wa.me: пишется в той же транзакции, что и ответ (persistCustomerLeadOnlyExtrasTx). */
  continuationCode?: PreparedContinuationCode;
  /** Клиент пришёл в WhatsApp по ссылке: связать переписки с одной карточкой после хода. */
  continuationLink?: Omit<WhatsappContinuationLink, "version">;
}

/** В транзакции ответа хода: код ссылки wa.me и задание связи переписок — вместе с ответом, не отдельно. */
export async function persistCustomerLeadOnlyExtrasTx(tx: TxClient, plan: Pick<CustomerLeadOnlyTurnPlan, "continuationCode" | "continuationLink">,
  now: Date): Promise<void> {
  if (plan.continuationCode) await insertWhatsappContinuationCodeTx(tx, plan.continuationCode, now);
  if (plan.continuationLink) await enqueueWhatsappContinuationLinkTx(tx, plan.continuationLink);
}

/** Пустое после выреза кода сообщение («#RH-…» без слов) — короткое приветствие на языке разговора, чтобы ход был ответом. */
const CONTINUATION_HELLO = { ru: "Здравствуйте", tg: "Салом" } as const;

/** Память разговора изменил параллельный ход, пока этот думал (Р14): решение на устаревшей памяти не записывается. */
export class OperatorStateStaleError extends Error {
  constructor() { super("operator_state_stale"); }
}

/** Отметка времени сохранённой памяти оператора (версия 2), иначе null. */
export function operatorStoredUpdatedAt(raw: unknown): string | null {
  const value = raw && typeof raw === "object" ? Reflect.get(raw, "updatedAt") : null;
  return typeof value === "string" ? value : null;
}

/** В транзакции записи: память всё ещё та, от которой решали (строка диалога заблокирована до конца транзакции). */
export async function assertOperatorStateCurrentTx(tx: TxClient, conversationId: string, baseUpdatedAt: string | null): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ leadOnlyPending: unknown }>>`SELECT "leadOnlyPending" FROM "BotConversation" WHERE "id"=${conversationId} FOR UPDATE`;
  if (operatorStoredUpdatedAt(rows[0]?.leadOnlyPending ?? null) !== baseUpdatedAt) throw new OperatorStateStaleError();
}

/** Тишина оператора — продуктовое решение, а не сбой (lib/customerIntendedSilence.ts). */
export const LEAD_ONLY_OPERATOR_SILENT = "lead_only_operator_silent";

const SENT_WINDOW_MS = 7 * 24 * 60 * 60_000;
/**
 * Что бот РЕАЛЬНО отправил в этом разговоре до текущего входа (ответы ходов и подтверждения передачи).
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

const LEAD_SCENARIO = (action: Extract<OperatorAction, { type: "accept_lead" }>): CustomerLeadOnlyIntake["scenario"] =>
  action.role === "seller" ? "seller" : action.role === "buyer" ? (action.propertyId ? "property" : "buyer") : "escalate";

/**
 * Ход режима «только заявки» в ядре. Никогда не null в режиме: оператор отвечает или намеренно молчит, а свободная модель
 * ядра этот разговор не ведёт. null — только когда режим выключен или канал не его (тогда ядро идёт обычным путём).
 */
export async function planCustomerLeadOnlyTurn(input: CustomerLeadOnlyTurnInput): Promise<CustomerLeadOnlyTurnPlan | null> {
  if (!input.config.enabled || !leadOnlyAppliesTo(input.channel)) return null;
  const now = input.now ?? new Date();
  // ПРОДОЛЖЕНИЕ ИЗ INSTAGRAM / FACEBOOK (владелец 25.11.2026): код из ссылки бота — служебная метка. Из слов клиента он уходит
  // всегда (и из заметки агенту), а живой код этого же клиента переносит память разговора-источника (lib/whatsappContinuation.ts).
  // Чужой, старый, погашенный другим разговором код — обычный разговор, из источника не читается ничего.
  let inputText = input.inputText;
  let continuation: WhatsappContinuation | null = null;
  const continuationCode = input.channel === "WHATSAPP" ? findContinuationCode(input.inputText) : null;
  if (continuationCode) {
    continuation = await consumeWhatsappContinuationCode({ code: continuationCode, conversationId: input.conversationId, now }).catch(error => {
      void logSystemError("ai", `Продолжение из Instagram: код не проверен (диалог ${input.conversationId}): ${error instanceof Error ? error.message : String(error)}`
        .slice(0, 400), { dedupKey: "whatsapp-continuation-consume" });
      return null;
    });
    inputText = stripContinuationMarker(input.inputText);
  }
  const seedLeadExists = !!continuation?.sourceClientId;
  const seed = continuation ? continuationSeedState(continuation.sourceState, seedLeadExists) : null;
  if (continuationCode && !clientOwnWords(inputText).trim()) inputText = CONTINUATION_HELLO[seed?.language ?? "tg"];
  const own = clientOwnWords(inputText);
  const wa = input.channel === "WHATSAPP" && input.config.useWhatsappNumber ? await resolveWhatsAppLeadIdentity(input.channel, input.peer) : null;
  const loadSetup = (focusPropertyId: string | null) => loadOperatorTurnSetup({ channel: input.channel, conversationId: input.conversationId,
    config: input.config, focusPropertyId, phoneKnownByChannel: !!wa?.leadPhone, peerPhone: input.channel === "WHATSAPP" ? input.peer : null, now });
  let setup = await loadSetup(input.focusPropertyId);
  // Память переносится только в пустой разговор WhatsApp без карточки: начатое здесь не перетираем.
  const seeded = !!seed && !setup.clientId && operatorStateFresh(setup.state);
  // Объект, о котором говорили в Instagram, — объект и этого разговора (если это сообщение не назвало свой).
  if (seeded && seed?.propertyId && !input.focusPropertyId && setup.ctx.focus?.propertyId !== seed.propertyId) setup = await loadSetup(seed.propertyId);
  let storedForTurn: unknown = setup.stored;
  let ctx = setup.ctx;
  if (seeded && seed) {
    storedForTurn = serializeOperatorState(seed, now);
    if (seedLeadExists && continuation?.sourceClientId) {
      // У клиента уже есть карточка (из Instagram): новой заявки не заводим — задание после хода привяжет этот разговор к ней.
      ctx = { ...ctx, leadExists: true, leadPending: false,
        cardAgentActive: await leadOnlyCardAgentActive(continuation.sourceClientId).catch(() => true) };
    }
  }
  // Сбой чтения — прежняя сверка по одной доставленной памяти (не причина ронять ход).
  const sentBotTexts = input.endpointScopeId ? await readCustomerLeadOnlySentTexts({ conversationId: input.conversationId,
    endpointScopeId: input.endpointScopeId, before: now }).catch(() => [] as string[]) : [];
  const operator = await runOperatorTurn({ storedState: storedForTurn, ctx, now, ...(input.model ? { model: input.model } : {}),
    ownWords: { enabled: input.config.ownWords === true, ...(input.composeModel ? { model: input.composeModel } : {}) },
    input: { current: inputText, recent: input.turns, sentBotTexts, conversationId: input.conversationId, ...(input.attachments ? { attachments: input.attachments } : {}) } });
  const continuedNote = continuation ? `Продолжение переписки из ${continuation.sourceChannel === "FACEBOOK" ? "Facebook" : "Instagram"} ` +
    "(клиент перешёл в WhatsApp по ссылке бота). " : "";
  const intakes: CustomerLeadOnlyIntake[] = [];
  let signal: CustomerLeadOnlyTurnPlan["signal"];
  for (const action of operator.actions) {
    if (action.type === "accept_lead") {
      const phone = action.phone ?? wa?.leadPhone ?? null;
      if (!phone) {
        void logSystemError("ai", `[alarm] Оператор приёма заявок: заявка без номера (диалог ${input.conversationId}). Откройте переписку.`,
          { dedupKey: `operator-lead-no-phone:${input.conversationId}` });
        continue;
      }
      intakes.push(sealCustomerLeadOnlyIntake({ eventKey: input.eventKey, conversationId: input.conversationId, scenario: LEAD_SCENARIO(action),
        propertyId: action.propertyId, ...(action.outOfArea ? { outOfArea: true as const } : {}) },
      { phone, whatsappPhone: wa?.waPhone ?? null, clientText: own.slice(0, 1500), promised: action.textOnly || action.noCall ? "chat" : "call", lead: true,
        callbackWhen: action.callbackWhen, ...(action.textOnly || action.noCall ? { noCall: true } : {}), note: `${continuedNote}${action.note}`.slice(0, 800) }));
    } else if (action.type === "append_note") {
      intakes.push(sealCustomerLeadOnlyIntake({ eventKey: input.eventKey, conversationId: input.conversationId, scenario: "note", propertyId: null,
        ...(action.outOfArea ? { outOfArea: true as const } : {}) },
      { phone: action.phone, whatsappPhone: null, clientText: own.slice(0, 1500), promised: "call", lead: false, note: action.note.slice(0, 800) }));
    } else if (action.type === "call_staff") {
      // Грубость, жалоба: одна дверь «клиент ждёт», с причиной — её не глушит тишина режима до заявки (20.11.2026).
      signal = { kind: "follow_up", reason: action.reason };
    } else {
      // follow_up (пометка в карточку без живого агента): та же дверь.
      signal ??= { kind: "follow_up" };
    }
  }
  // Последняя дверь текста режима (ai/leadOnlyMode.ts::leadOnlyOutgoing): начало-согласие не уходит никогда.
  let text = operator.text ? leadOnlyOutgoing(operator.text, operator.language) : null;
  // Кнопка под ответом (владелец 25.11.2026): звонок в WhatsApp / ссылка wa.me из Instagram и Facebook. Решает код по рубильникам
  // и готовности звонков; нельзя — обычный текст, как раньше.
  const contactAsk = operatorContactAsk(inputText);
  const leadAcceptedNow = operator.actions.some(action => action.type === "accept_lead");
  let button: CustomerContactButton | undefined;
  let preparedCode: PreparedContinuationCode | undefined;
  if (text && (contactAsk || (leadAcceptedNow && input.channel === "WHATSAPP"))) {
    const policy = await loadContactButtonPolicy(now);
    const linkChannel = input.channel === "INSTAGRAM" || input.channel === "FACEBOOK" ? input.channel : null;
    const mainBrand = ctx.brandName === AGENCY_FACTS.name;
    if (linkChannel && contactAsk && policy.igWhatsappLink && policy.waNumber && mainBrand) {
      preparedCode = await prepareWhatsappContinuationCode({ conversationId: input.conversationId, channel: linkChannel, now }).catch(() => undefined);
    }
    const planned = planOperatorContactButton({ channel: ctx.channel, language: operator.language, text,
      contactAsk, leadAcceptedNow, closed: operator.state.closed, mainBrand, policy, code: preparedCode?.code ?? null, sentBotTexts });
    if (planned) { text = planned.text; button = planned.button; }
    else preparedCode = undefined;
  }
  // Задание связи переписок: у источника карточка (этот разговор к ней) или этим ходом заводится заявка (источник к ней).
  const continuationLink = continuation && (continuation.sourceClientId || leadAcceptedNow)
    ? { waConversationId: input.conversationId, sourceConversationId: continuation.sourceConversationId,
      sourceChannel: continuation.sourceChannel, eventKey: input.eventKey } : undefined;
  return { text, intakes, operator, baseUpdatedAt: operatorStoredUpdatedAt(setup.stored),
    ...(signal ? { signal } : {}), ...(operator.handoff ? { handoff: operator.handoff } : {}),
    ...(button ? { button } : {}), ...(preparedCode ? { continuationCode: preparedCode } : {}),
    ...(continuationLink ? { continuationLink } : {}) };
}

/** Ставится в той же транзакции, что и ответ хода: ответ без заявки или заявка без ответа не остаются. */
export async function enqueueCustomerLeadOnlyIntakeTx(tx: TxClient, intake: CustomerLeadOnlyIntake): Promise<void> {
  // «Bot failed» leads: one per conversation (owner 17.11.2026). Old queued jobs may still carry the mark.
  if (intake.modelFailed && await customerLeadOnlyModelFailedPendingTx(tx, intake.conversationId)) return;
  await tx.backgroundJob.create({ data: { type: CUSTOMER_LEAD_ONLY_INTAKE_JOB, payload: intake, maxAttempts: CUSTOMER_LEAD_ONLY_INTAKE_ATTEMPTS,
    dedupeKey: `${CUSTOMER_LEAD_ONLY_INTAKE_JOB}:${intake.eventKey}${intake.scenario === "note" ? ":note" : ""}` } });
}

/** A «bot failed» lead of this conversation is still queued or running. */
export async function customerLeadOnlyModelFailedPendingTx(tx: TxClient, conversationId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "BackgroundJob"
    WHERE "type"=${CUSTOMER_LEAD_ONLY_INTAKE_JOB} AND "status" IN ('PENDING','RUNNING')
      AND "payload"->>'conversationId'=${conversationId} AND "payload"->>'modelFailed'='true'`;
  return Number(rows[0]?.n ?? 0) > 0;
}
/** С лесенкой задания (10, 20, затем по 30 с) это около 11 минут: дольше всех повторов отправки (≈2,5 мин). */
export const CUSTOMER_LEAD_ONLY_INTAKE_ATTEMPTS = 24;

export type CustomerLeadOnlyIntakeResult = { status: "accepted" | "noted" | "notified" | "skipped"; reason?: string } |
  { status: "wait"; reason: "turn_not_settled" | "card_pending" };

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
  no_call: LEAD_ONLY_NO_CALL_NOTE,
  note: "Пометка бота",
};
const PROMISE_NOTE = { call: ", бот обещал звонок агента", chat: ", номера нет: ответьте в переписке" } as const;

/**
 * Фоновая часть: заявка или пометка в карточке. Повтор задания безопасен: приём захватывает диалог
 * атомарно. `force` — последняя попытка: ответ хода так и не ушёл (площадка лежит), а заявка важнее ответа.
 * Людей отсюда зовёт только сбой заявки с номером (lib/leadOnlyHandover.ts, решение владельца 13.11.2026).
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
    // Номер мог быть внутри: заявку, возможно, потеряли — это сбой, а не «кто-то интересуется».
    await alarmLeadOnlyIntake({ conversationId: conversation.id, propertyId: intake.propertyId, reason: "intake_failed" });
    return { status: "notified", reason: "unsealed" };
  }
  const noCall = sealed.noCall === true && intake.scenario !== "no_call";
  const promise = intake.scenario === "escalate" || intake.scenario === "callback" || intake.scenario === "no_call" ? ""
    : noCall ? `. ${LEAD_ONLY_NO_CALL_NOTE}` : PROMISE_NOTE[sealed.promised];
  // Заметка оператора (роль, детали, пожелания, слова клиента) — как есть; прежние задания без неё — прежняя сборка.
  const note = sealed.note ?? leadOnlyNoteWithCallbackTime(`${intake.modelFailed ? "Вопрос, на который бот не ответил" : SCENARIO_NOTE[intake.scenario]}${promise}: «${sealed.clientText.replace(/\s+/g, " ").slice(0, 200)}»`,
    sealed.callbackWhen);
  if (intake.scenario === "note") {
    // Пометка к заявке, которую заводит задание этого же разговора: карточки может ещё не быть — подождём её (не теряем).
    if (!conversation.clientId && !options.force) return { status: "wait", reason: "card_pending" };
    if (!conversation.clientId) {
      // Бот уже сказал «Передал агенту», а карточки так и нет (заявка этого разговора не завелась): не тихий пропуск.
      // Сторож лидов (lib/phoneLeadWatchdog.ts) считает задание этого типа «заботой приёма ядра» и сам не тревожит.
      void logSystemError("ai", `[alarm] Оператор заявок: пометка агенту без карточки (диалог ${conversation.id}). Откройте переписку и заведите карточку руками.`,
        { dedupKey: `lead-only-note-no-card:${conversation.id}` });
      await alarmLeadOnlyIntake({ conversationId: conversation.id, propertyId: intake.propertyId, reason: "intake_failed" });
      return { status: "notified", reason: "card_missing" };
    }
    if (sealed.phone) {
      const phoneNote = await noteLeadOnlyNewPhone({ conversationId: conversation.id, phone: sealed.phone, note });
      return phoneNote === "noted" ? { status: "noted" } : { status: "skipped", reason: phoneNote };
    }
    return await noteLeadOnlyOnCard({ conversationId: conversation.id, summary: note }) ? { status: "noted" } : { status: "skipped", reason: "card_missing" };
  }
  if (conversation.clientId) {
    // Заявку уже завела прошлая попытка этого же задания (или параллельный приём): агента уведомил сам приём.
    if (sealed.lead) return { status: "accepted", reason: "card_exists" };
    // Карточка была до хода: клиент уже лид, агенту приходит обычное уведомление о сообщении. Режим оставляет только
    // пометку: время звонка, «не звоните» или другой номер. Номер, на который агент и так звонит, новым не считается
    // (одна дверь со старым путём — lib/leadOnlyHandover.ts, пятое ревью 13.11, №5).
    if (sealed.phone) {
      const phoneNote = await noteLeadOnlyNewPhone({ conversationId: conversation.id, phone: sealed.phone, note });
      if (phoneNote === "noted") return { status: "noted" };
      if (phoneNote === "no_card") return { status: "skipped", reason: "card_missing" };
    }
    if (intake.scenario !== "callback" && intake.scenario !== "no_call") return { status: "skipped", reason: "card_exists" };
    return await noteLeadOnlyOnCard({ conversationId: conversation.id, summary: note }) ? { status: "noted" } : { status: "skipped", reason: "card_missing" };
  }
  // Номера нет — заявки нет и звать некого (решение владельца 13.11.2026). Сюда доходят только задания, поставленные
  // прежней версией до выката (тогда объект без номера звал агента объекта).
  if (!sealed.lead || !sealed.phone) return { status: "skipped", reason: "no_phone" };
  // lib → messengers → lib: цикл импортов, поэтому приём берём динамически (как lib/phoneLeadWatchdog.ts).
  const { acceptLead } = await import("../messengers/conversation.js");
  const prior = (conversation.leadDraft ?? { stage: "chatting" }) as Record<string, unknown>;
  const draft = { ...prior, stage: prior.stage === "awaiting_phone" ? "awaiting_phone" : "chatting",
    // Номер в ответ на просьбу без ясной темы: намерение — из прежнего черновика, классификатор приёма решит сам.
    ...(intake.scenario === "escalate" ? {} : { intent: intake.scenario === "seller" ? "sell" : "buy", confident: true }), callbackTopic: note,
    ...(intake.outOfArea ? { outOfArea: true } : {}),
    ...(intake.propertyId ? { requestedPropertyId: intake.propertyId } : {}) };
  const result = await acceptLead(conversation.id, conversation.channel as never, conversation.name ?? undefined, sealed.phone,
    draft as never, (conversation.messages ?? []) as never, {
      // Объект известен — его агенту сразу, в любое время (сценарий 2). Иначе ночью — утренней волной.
      deferAssignment: intake.propertyId ? false : !(await isWithinWorkingHours()),
      ...(sealed.whatsappPhone ? { whatsappPhone: sealed.whatsappPhone } : {}),
      clientText: sealed.clientText, silent: true, fromHistory: true,
      ...(intake.modelFailed ? { leadNote: LEAD_MODEL_FAILED_NOTE } : {}),
    });
  // Проверяющий (дверь — acceptLead): заявку не заводили нарочно, тревоги нет.
  if (result.reviewer) return { status: "skipped", reason: "reviewer" };
  const linked = await prisma.botConversation.findUnique({ where: { id: conversation.id },
    select: { client: { select: { kind: true, assignedAgentId: true } } } });
  if (!linked?.client) {
    // Заявка не оформилась: клиент ждёт звонка, а его нет нигде. Не тихий пропуск, а тревога и человек (ревью №7).
    void logSystemError("ai", `[alarm] Режим «только заявки»: заявка из ядра не оформлена (диалог ${conversation.id}, ` +
      `${result.accepted ? "принята без карточки" : "приём отказал"}). Откройте переписку и заведите карточку руками.`,
      { dedupKey: `lead-only-no-card:${conversation.id}` });
    await alarmLeadOnlyIntake({ conversationId: conversation.id, propertyId: intake.propertyId, reason: "intake_failed" });
    return { status: "skipped", reason: result.accepted ? "accepted_without_card" : "declined" };
  }
  // Ответ обещал звонок, а приём счёл обращение «прочим» (агенту не назначается): обещание не должно повиснуть.
  if (linked.client.kind === "OTHER" && sealed.promised === "call") {
    void logSystemError("ai", `[alarm] Режим «только заявки»: бот обещал звонок, а заявка ушла в «Прочие обращения» без агента ` +
      `(диалог ${conversation.id}). Позвоните клиенту или напишите ему.`, { dedupKey: `lead-only-other-promised:${conversation.id}` });
    await alarmLeadOnlyIntake({ conversationId: conversation.id, propertyId: intake.propertyId, reason: "no_agent" });
  }
  return { status: "accepted" };
}
