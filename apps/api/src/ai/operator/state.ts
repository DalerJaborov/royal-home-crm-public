/**
 * ОПЕРАТОР ПРИЁМА ЗАЯВОК — ПАМЯТЬ РАЗГОВОРА В jsonb `BotConversation.leadOnlyPending` (версия 2, без миграции базы).
 *
 * Версия 1 (lib/leadOnlyPending.ts: `{version: 1, scenario, propertyId, askedAt}` — «о чём бот просил номер») читается
 * без падения и переводится в версию 2: роль из сценария, номер уже просили один раз, вопрос о деталях считается
 * заданным (старый режим его не задавал, и начинать с него посреди просьбы номера — второй круг вопросов).
 * Битое, чужое или просроченное — новое пустое состояние: память — подсказка, а не приказ.
 *
 * Чистые функции чтения и записи (время приходит аргументом) и одна запись в базу внутри транзакции хода.
 * Номер телефона и слова клиента целиком сюда не пишутся: только признак «номер есть» и короткие детали.
 */
import { z } from "zod";
import { parseLeadOnlyPending } from "../../lib/leadOnlyPending.js";
import type { prisma, TxClient } from "../../db.js";
import { emptyOperatorDetails, initialOperatorState } from "./decide.js";
import { OPERATOR_DETAIL_FIELDS, OPERATOR_PHRASE_KEYS, type OperatorState } from "./types.js";

/** Разговор, где клиент молчал дольше месяца, начинается заново (заявка и карточка живут в CRM, не здесь). */
export const OPERATOR_STATE_TTL_MS = 30 * 24 * 60 * 60_000;
/**
 * Бот замолчал (грубость, жалоба, роль не прояснилась, номер не дали) — не навсегда: через сутки после последнего хода
 * клиент, вернувшийся с новым вопросом, снова получает ответ (П3 приёмки 19.11). Роль, язык и детали остаются.
 */
export const OPERATOR_HANDOFF_RESET_MS = 24 * 60 * 60_000;

const KNOWN_KEYS: ReadonlySet<string> = new Set(OPERATOR_PHRASE_KEYS);
const shortText = z.string().trim().max(120).nullable();
const counter = z.number().int().min(0).max(1000);
const storedSchema = z.object({
  version: z.literal(2),
  updatedAt: z.string().datetime(),
  role: z.enum(["unknown", "buyer", "buyer_property", "seller", "job", "rent"]),
  step: z.enum(["start", "role", "details", "contact", "done", "handoff"]),
  language: z.enum(["ru", "tg"]).nullable(),
  asked: z.object({ role: counter, details: counter, phone: counter }),
  // Ключи, убранные из фраз (OPERATOR_RETIRED_PHRASE_KEYS), и любые незнакомые молча отбрасываются: из-за одной старой
  // отметки память разговора (роль, язык, «заявка принята») не должна обнуляться (20.11.2026).
  spoken: z.record(z.string(), counter).default({}).transform(raw =>
    Object.fromEntries(Object.entries(raw).filter(([key]) => KNOWN_KEYS.has(key))) as Partial<Record<(typeof OPERATOR_PHRASE_KEYS)[number], number>>),
  propertyId: z.string().uuid().nullable(),
  details: z.object(Object.fromEntries(OPERATOR_DETAIL_FIELDS.map(field => [field, shortText.default(null)])) as Record<(typeof OPERATOR_DETAIL_FIELDS)[number], z.ZodDefault<typeof shortText>>),
  callback: z.object({ when: shortText, textOnly: z.boolean() }),
  noCall: z.boolean().default(false),
  outOfArea: z.boolean(),
  place: shortText.default(null),
  flags: z.object({ bargainAsked: z.boolean().default(false), adPriceAsked: z.boolean().default(false),
    propertyLineFor: z.string().uuid().nullable().default(null), lastAck: z.boolean().default(false),
    sellerByWords: z.boolean().default(false),
    signaled: z.array(z.string()).default([]).transform(list => list.filter((item): item is "unclear" | "attachments" | "no_phone" =>
      item === "unclear" || item === "attachments" || item === "no_phone")) }),
  leadAccepted: z.boolean(),
  staffCalled: z.boolean(),
  closed: z.boolean().default(false),
  jobAnswered: shortText.default(null),
});
export type StoredOperatorState = OperatorState & { updatedAt: string };

/**
 * Прочитать память разговора. Никогда не бросает: версия 2 — как есть (если не просрочена), версия 1 — переводом,
 * всё прочее — новое состояние.
 */
export function readOperatorState(raw: unknown, now: Date = new Date()): OperatorState {
  if (raw && typeof raw === "object" && Reflect.get(raw, "version") === 2) {
    const parsed = storedSchema.safeParse(raw);
    if (!parsed.success) return initialOperatorState();
    const age = now.getTime() - Date.parse(parsed.data.updatedAt);
    if (!(age >= 0 && age <= OPERATOR_STATE_TTL_MS)) return initialOperatorState();
    const { updatedAt: _updatedAt, ...rest } = parsed.data;
    const state = { ...rest, details: { ...emptyOperatorDetails(), ...rest.details }, spoken: { ...rest.spoken } } as OperatorState;
    // Через сутки «Передал агенту» снова можно сказать один раз (ревью 19.11, Р5).
    if (age > OPERATOR_HANDOFF_RESET_MS) {
      delete state.spoken.note_added; delete state.spoken.no_agent_noted; delete state.spoken.welcome; delete state.spoken.lead_reminder;
      // Новый эпизод: сигналы «не понял» и «вложения» снова возможны (ревью #333).
      state.flags = { ...state.flags, signaled: [] };
    }
    if ((state.closed || state.step === "handoff") && age > OPERATOR_HANDOFF_RESET_MS) {
      state.closed = false; state.staffCalled = false;
      state.step = state.leadAccepted ? "done" : "start";
      state.asked = { ...state.asked, role: 0, phone: 0 };
      delete state.spoken.office_phone;
    }
    return state;
  }
  const v1 = parseLeadOnlyPending(raw, now);
  if (!v1) return initialOperatorState();
  const state = initialOperatorState();
  state.role = v1.scenario === "seller" ? "seller" : v1.propertyId && (v1.scenario === "property" || v1.scenario === "hot") ? "buyer_property" : "buyer";
  state.propertyId = state.role === "buyer_property" ? v1.propertyId : null;
  state.step = "contact";
  state.asked = { role: 0, details: 1, phone: 1 };
  // Старый режим уже назвал объект или условия продавцу: повторять их не надо.
  if (state.role === "buyer_property") state.flags.propertyLineFor = state.propertyId;
  if (state.role === "seller") state.spoken.seller_intro = 1;
  state.spoken.ask_phone = 1;
  return state;
}

/** Значение для колонки jsonb. Перед записью проверяется той же схемой, что и чтение: битое не пишется. */
export function serializeOperatorState(state: OperatorState, now: Date = new Date()): StoredOperatorState {
  const clip = (value: string | null) => value === null ? null : value.trim().slice(0, 120);
  const details = Object.fromEntries(OPERATOR_DETAIL_FIELDS.map(field => [field, clip(state.details[field])])) as OperatorState["details"];
  const stored: StoredOperatorState = { ...state, details, place: clip(state.place), jobAnswered: clip(state.jobAnswered),
    callback: { ...state.callback, when: clip(state.callback.when) }, updatedAt: now.toISOString() };
  storedSchema.parse(stored);
  return stored;
}

/** В колонке лежит память оператора (версия 2), а не прежняя «о чём просили номер» (версия 1). */
export function isOperatorStateStored(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && Reflect.get(raw, "version") === 2;
}

/**
 * Запись внутри транзакции ответа, но за точкой сохранения: сбой памяти откатывает только её, ответ клиенту остаётся
 * (тот же приём, что прежний applyLeadOnlyPendingIsolatedTx). Возвращает ошибку для журнала или null.
 */
export async function saveOperatorStateIsolatedTx(tx: TxClient, conversationId: string, state: OperatorState, now: Date = new Date()): Promise<unknown> {
  await tx.$executeRaw`SAVEPOINT operator_state`;
  try {
    await saveOperatorStateTx(tx, conversationId, state, now);
    await tx.$executeRaw`RELEASE SAVEPOINT operator_state`;
    return null;
  } catch (err) {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT operator_state`;
    return err ?? new Error("operator state write failed");
  }
}

/** Записать память в транзакции хода (вместе с ответом). */
export async function saveOperatorStateTx(tx: TxClient | typeof prisma, conversationId: string, state: OperatorState, now: Date = new Date()): Promise<void> {
  await tx.botConversation.updateMany({ where: { id: conversationId }, data: { leadOnlyPending: serializeOperatorState(state, now) as object } });
}
