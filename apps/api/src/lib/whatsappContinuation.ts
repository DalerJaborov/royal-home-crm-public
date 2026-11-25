/**
 * КОД «ПРОДОЛЖЕНИЕ В WHATSAPP» (владелец 25.11.2026: «давай ссылку на наш вотцап каким нибудь специальным ссылкой чтобы бот
 * понял что это продолжение»). Одно место, где код выдаётся, гасится и связывает два разговора.
 *
 *  - Instagram / Facebook: бот даёт кнопку wa.me с предзаполненным «… #RH-XXXXXX» (ai/operator/contactButton.ts). Код
 *    короткий и случайный (31^6 ≈ 887 млн), живёт 3 суток, выдаётся один на переписку, пока жив (повторная просьба — та же ссылка).
 *  - WhatsApp: первое сообщение с кодом гасит его (одноразовый) и привязывает к этому разговору. Повтор того же хода (сбой,
 *    устаревшая память) получает то же продолжение; чужой, старый, погашенный другим разговором или выдуманный код — обычный
 *    разговор: из источника не читается НИЧЕГО.
 *  - Продолжение переносит память оператора (роль, детали, язык, объект — без номера: его в памяти нет) и, после хода,
 *    фоновым заданием связывает переписки с одной карточкой клиента (jobs/whatsappContinuationLink.ts).
 */
import { randomInt } from "node:crypto";
import { z } from "zod";
import { prisma, type TxClient } from "../db.js";
import { CONTINUATION_CODE_ALPHABET } from "../ai/operator/contactButton.js";
import { readOperatorState } from "../ai/operator/state.js";
import type { OperatorState } from "../ai/operator/types.js";
import { logTimeline } from "./timeline.js";
import { whatsAppPhoneFromSubscriberId, rememberWhatsAppPhone } from "./whatsappPhone.js";

export const WHATSAPP_CONTINUATION_TTL_MS = 3 * 24 * 60 * 60_000;
/** Выданный код переиспользуем, только если ему жить ещё хотя бы столько: клиент может нажать ссылку не сразу. */
const REUSE_MIN_LEFT_MS = 12 * 60 * 60_000;
/** Погашенные и истёкшие коды хранятся месяц (разбор «откуда пришёл»), дальше удаляются при выдаче новых. */
const KEEP_MS = 30 * 24 * 60 * 60_000;
export const WHATSAPP_CONTINUATION_LINK_JOB = "whatsapp-continuation-link";

export function newWhatsappContinuationCode(): string {
  let body = "";
  for (let i = 0; i < 6; i++) body += CONTINUATION_CODE_ALPHABET[randomInt(CONTINUATION_CODE_ALPHABET.length)];
  return `RH-${body}`;
}

export interface PreparedContinuationCode { code: string; create: boolean; sourceConversationId: string; sourceChannel: "INSTAGRAM" | "FACEBOOK" }

/** Код для ссылки этой переписки: живой прежний или новый (запишется в транзакции ответа, insertWhatsappContinuationCodeTx). */
export async function prepareWhatsappContinuationCode(input: { conversationId: string; channel: "INSTAGRAM" | "FACEBOOK"; now: Date }):
  Promise<PreparedContinuationCode> {
  const alive = await prisma.whatsappContinuationCode.findFirst({ where: { sourceConversationId: input.conversationId, usedAt: null,
    expiresAt: { gt: new Date(input.now.getTime() + REUSE_MIN_LEFT_MS) } }, orderBy: { createdAt: "desc" }, select: { code: true } });
  if (alive) return { code: alive.code, create: false, sourceConversationId: input.conversationId, sourceChannel: input.channel };
  return { code: newWhatsappContinuationCode(), create: true, sourceConversationId: input.conversationId, sourceChannel: input.channel };
}

/** В транзакции ответа: ссылка с кодом и сам код появляются вместе (ссылка без кода в базе была бы «чужим кодом»). */
export async function insertWhatsappContinuationCodeTx(tx: TxClient, code: PreparedContinuationCode, now: Date): Promise<void> {
  if (!code.create) return;
  await tx.whatsappContinuationCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - KEEP_MS) } } });
  await tx.whatsappContinuationCode.create({ data: { code: code.code, sourceConversationId: code.sourceConversationId,
    sourceChannel: code.sourceChannel, createdAt: now, expiresAt: new Date(now.getTime() + WHATSAPP_CONTINUATION_TTL_MS) } });
}

export interface WhatsappContinuation {
  code: string;
  sourceConversationId: string;
  sourceChannel: "INSTAGRAM" | "FACEBOOK";
  /** Живая карточка клиента переписки-источника; null — карточки нет. */
  sourceClientId: string | null;
  /** Память оператора источника (прочитанная). */
  sourceState: OperatorState;
}

/**
 * Погасить код этим разговором WhatsApp. null — кода нет, истёк, погашен другим разговором, источник пропал или не
 * Instagram/Facebook: тогда это обычный разговор, ничего из источника не берётся.
 */
export async function consumeWhatsappContinuationCode(input: { code: string; conversationId: string; now: Date }):
  Promise<WhatsappContinuation | null> {
  const code = input.code.toUpperCase();
  // Гасит только живой непогашенный код, и только чужой переписке (не самой переписке-источнику).
  await prisma.whatsappContinuationCode.updateMany({ where: { code, usedAt: null, expiresAt: { gt: input.now },
    sourceConversationId: { not: input.conversationId } }, data: { usedAt: input.now, usedByConversationId: input.conversationId } });
  const row = await prisma.whatsappContinuationCode.findUnique({ where: { code },
    select: { sourceConversationId: true, sourceChannel: true, usedByConversationId: true } });
  // Погашен этим разговором — сейчас или прошлой попыткой того же хода (сбой, устаревшая память): продолжение то же.
  // Погашен другим, истёк, не выдавался — обычный разговор.
  if (!row || row.usedByConversationId !== input.conversationId) return null;
  if (row.sourceChannel !== "INSTAGRAM" && row.sourceChannel !== "FACEBOOK") return null;
  const source = await prisma.botConversation.findUnique({ where: { id: row.sourceConversationId },
    select: { leadOnlyPending: true, client: { select: { id: true, deletedAt: true } } } });
  if (!source) return null;
  return { code, sourceConversationId: row.sourceConversationId, sourceChannel: row.sourceChannel,
    sourceClientId: source.client && !source.client.deletedAt ? source.client.id : null,
    sourceState: readOperatorState(source.leadOnlyPending ?? null, input.now) };
}

/** Память разговора WhatsApp ещё пустая: продолжение её заполняет. Начатый в WhatsApp разговор не перетираем. */
export function operatorStateFresh(state: OperatorState): boolean {
  return state.step === "start" && state.role === "unknown" && !state.leadAccepted && !state.closed &&
    Object.values(state.spoken).every(count => !count);
}

/**
 * Память для разговора WhatsApp из памяти источника: роль, детали, язык, объект, пожелания по звонку, что уже звучало. Без
 * служебного (сигналы людям, «закрыт», последнее предложение): это другой канал. Разговор источника закрыт жалобой или
 * грубостью — продолжения нет (null): человек в WhatsApp начинает с чистого листа, решает сотрудник.
 */
export function continuationSeedState(source: OperatorState, leadExists: boolean): OperatorState | null {
  if (source.closed || source.step === "handoff") return null;
  return {
    ...source,
    // Номер в WhatsApp известен по каналу: шаг «просим номер» там не нужен.
    step: leadExists ? "done" : source.step === "contact" ? "details" : source.step,
    leadAccepted: leadExists,
    staffCalled: false,
    closed: false,
    flags: { ...source.flags, lastAck: false, lastOffer: false, signaled: [], closedBy: null },
  };
}

export const whatsappContinuationLinkSchema = z.object({
  version: z.literal(1),
  waConversationId: z.string().uuid(),
  sourceConversationId: z.string().uuid(),
  sourceChannel: z.enum(["INSTAGRAM", "FACEBOOK"]),
  eventKey: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type WhatsappContinuationLink = z.infer<typeof whatsappContinuationLinkSchema>;

/** В транзакции ответа хода WhatsApp: связать переписки с одной карточкой после того, как ход отпустит ответ. */
export async function enqueueWhatsappContinuationLinkTx(tx: TxClient, link: Omit<WhatsappContinuationLink, "version">): Promise<void> {
  const payload = whatsappContinuationLinkSchema.parse({ version: 1, ...link });
  await tx.backgroundJob.create({ data: { type: WHATSAPP_CONTINUATION_LINK_JOB, payload, maxAttempts: 24,
    dedupeKey: `${WHATSAPP_CONTINUATION_LINK_JOB}:${payload.eventKey}` } });
}

export type WhatsappContinuationLinkResult =
  | { status: "linked_whatsapp" | "linked_source" | "same_card" | "noted" | "skipped"; reason?: string }
  | { status: "wait"; reason: "card_pending" };

const SOURCE_LABEL = { INSTAGRAM: "Instagram", FACEBOOK: "Facebook" } as const;

/**
 * Связать переписку WhatsApp и переписку-источник с одной карточкой. Ничего не создаёт и никого не назначает:
 *  - у источника карточка, у WhatsApp нет — WhatsApp к ней (и номер WhatsApp в карточку);
 *  - у WhatsApp карточка (заявка этого хода), у источника нет — источник к ней;
 *  - нет карточки ни там, ни там, а заявка WhatsApp ещё оформляется — подождать (`wait`);
 *  - разные карточки — только пометка в карточке WhatsApp, сводить двух клиентов решает человек.
 * Идемпотентна: повтор задания ничего не портит.
 */
export async function runWhatsappContinuationLink(raw: unknown, options: { force?: boolean } = {}): Promise<WhatsappContinuationLinkResult> {
  const link = whatsappContinuationLinkSchema.parse(raw);
  const live = { select: { id: true, deletedAt: true, assignedAgentId: true } } as const;
  const [wa, source] = await Promise.all([
    prisma.botConversation.findUnique({ where: { id: link.waConversationId }, select: { id: true, channel: true, subscriberId: true, client: live } }),
    prisma.botConversation.findUnique({ where: { id: link.sourceConversationId }, select: { id: true, client: live } }),
  ]);
  if (!wa || !source || wa.channel !== "WHATSAPP") return { status: "skipped", reason: "conversation_missing" };
  const waCard = wa.client && !wa.client.deletedAt ? wa.client : null;
  const sourceCard = source.client && !source.client.deletedAt ? source.client : null;
  const label = SOURCE_LABEL[link.sourceChannel];
  const note = (clientId: string, agentId: string | null, text: string) => logTimeline({ clientId, type: "SYSTEM", notes: text,
    actor: { kind: "client", source: "whatsapp-continuation", ...(agentId ? { subjectAgentId: agentId } : {}) } });
  if (waCard && sourceCard) {
    if (waCard.id === sourceCard.id) return { status: "same_card" };
    await note(waCard.id, waCard.assignedAgentId, `Клиент пришёл в WhatsApp по ссылке из ${label}; переписка ${label} привязана к другой карточке. Проверьте, не один ли это клиент.`);
    return { status: "noted" };
  }
  if (sourceCard) {
    // Только в пустое поле: привязку, сделанную за это время другим путём, не перетираем.
    const changed = await prisma.botConversation.updateMany({ where: { id: wa.id, clientId: null }, data: { clientId: sourceCard.id } });
    if (changed.count === 0) return { status: "skipped", reason: "already_linked" };
    const waPhone = whatsAppPhoneFromSubscriberId("WHATSAPP", wa.subscriberId);
    if (waPhone) await rememberWhatsAppPhone(sourceCard.id, waPhone);
    await note(sourceCard.id, sourceCard.assignedAgentId, `Клиент продолжил переписку из ${label} в WhatsApp по ссылке бота${waPhone ? `, WhatsApp ${waPhone}` : ""}.`);
    return { status: "linked_whatsapp" };
  }
  if (waCard) {
    const changed = await prisma.botConversation.updateMany({ where: { id: source.id, clientId: null }, data: { clientId: waCard.id } });
    if (changed.count === 0) return { status: "skipped", reason: "already_linked" };
    await note(waCard.id, waCard.assignedAgentId, `Клиент пришёл в WhatsApp по ссылке бота из ${label}: переписка ${label} привязана к этой карточке.`);
    return { status: "linked_source" };
  }
  // Карточки нет нигде: заявку WhatsApp этого хода ещё оформляет приём — подождём; на последней попытке — тихо (заявку
  // и её тревоги держит сам приём, здесь только связь переписок).
  return options.force ? { status: "skipped", reason: "no_card" } : { status: "wait", reason: "card_pending" };
}
