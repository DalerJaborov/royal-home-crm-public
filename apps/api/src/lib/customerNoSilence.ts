// КЛИЕНТ НЕ ОСТАЁТСЯ БЕЗ СТРОКИ — ОДНА ДВЕРЬ (16.11.2026, аудит молчания 11–15.11).
//
// ФАКТ (прод, 11–15.11): 9 переписок, где ход нового ядра закончился HELD, и 4, где щит повторов вырезал
// единственную часть ответа, — клиенту тишина до конца. Примеры: покупатель по объекту №192 «рафта бинем»,
// «гучо равем» (три turn_unavailable + unsupported_decision_evidence); соискатель «я подошёл, а тут никто
// не в курсе» (round_limit). После #193 человеку уходит пуш, но клиенту не уходит ничего.
//
// Правило: каждая причина HELD — ровно в одном из трёх списков.
//  1. Намеренное молчание (customerIntendedSilence.ts) — решение продукта, не трогаем.
//  2. CUSTOMER_SAFETY_LINE_REASONS — бот не смог ответить по существу, но ничего не сделал (нет записей и
//     квитанций): клиенту одна короткая строка «это скажет агент» (те же проверенные фразы, что у двери
//     «это скажет агент» #201, ai/customerAgentStaffFollowUp.ts), человеку — тот же сигнал follow_up
//     (alertClientWaiting, один на чат до ответа человека — второго пуша нет).
//  3. CUSTOMER_NO_SAFETY_LINE_REASONS — говорить нельзя или незачем: действие могло совершиться
//     (effect_unknown, квитанция), поломка настройки (каждый клиент получил бы одну и ту же строку), лимит
//     ходов против злоупотребления. Здесь как раньше: тишина + пуш человеку (customerTurnSilence.ts).
// Причина, которой нет ни в одном списке, — молчание + пуш (защита по умолчанию: не говорить, если не
// доказано, что безопасно). Сторож: tests/customer-no-silence-16-11.test.ts сверяет списки с кодом ядра.
//
// Чистые функции без базы.
import { customerPhoneAskLines, customerStaffFollowUpFixedLines, customerStaffFollowUpLine, PHONE_ASK_TEXT,
  type FollowUpMemory } from "../ai/customerAgentStaffFollowUp.js";
import { CUSTOMER_TURN_INTENDED_SILENCE } from "./customerIntendedSilence.js";

/** The bot could not produce a supported answer and changed nothing: the customer gets one short hand-off line. */
export const CUSTOMER_SAFETY_LINE_REASONS: readonly string[] = [
  // the model / provider failed or ran out of its bounds
  "turn_unavailable", "turn_deadline", "round_limit", "tool_limit", "output_limit",
  // the model answered something the server cannot render or must not send
  "unsupported_decision_evidence", "invalid_model_decision", "surface_decision_denied", "invalid_model_call",
  "invalid_model_turn", "missing_model_parts", "invalid_call_id", "duplicate_call_id", "call_id_reused",
  // a read the answer needed failed
  "unavailable_tool", "facts_unavailable",
  // the model chose "hand to a person" (escalate): the person is told, the customer hears it too
  "staff_or_supported_reply_required",
];

/** Speaking is unsafe or pointless here: silence + a push to a person, as before. Keep every entry justified. */
export const CUSTOMER_NO_SAFETY_LINE_REASONS: readonly string[] = [
  "effect_unknown", // a write may have happened: a person reconciles first
  "receipt_requires_reconciliation", // a committed result must be confirmed, not replaced
  "repeated_effect_denied", // the model tried to repeat an action: a person decides
  "operation_stopped", // the turn was stopped on purpose (superseded / shutdown)
  "original_context_changed", // the chat changed under the turn: a newer input answers (see customerDmAgentTurn)
  "customer_turn_budget_or_context", // the daily turn ceiling against abuse: no endless replies to a flood
  "input_limit", "model_payload_limit", // an oversized request is refused as a resource/abuse bound, not answered
  "customer_core_unavailable", // an exception inside the adapter: state unknown
  // configuration / contract faults: every customer would get the same line; the director alarms cover them
  "managed_operation_required", "context_scope_mismatch", "duplicate_tool_definition", "public_write_definition_denied",
  "publication_context_invalid", "media_surface_unqualified",
];

export function customerSafetyLineAllowed(reason: string): boolean {
  return CUSTOMER_SAFETY_LINE_REASONS.includes(reason) && !CUSTOMER_TURN_INTENDED_SILENCE.includes(reason);
}

/**
 * ONE retry of the core turn inside the same claim and the same provider operation (its own attempt/money/deadline
 * bounds stay in force). Only a provider failure qualifies: the chat did not change (that cause is answered by the
 * newer input), nothing was written, no receipt exists, and there is time left. ФАКТ (BotTurnTrace 7 дней до 16.11):
 * 29 из 32 turn_unavailable — это original_context_changed (клиент дописал), их повтор не лечит.
 */
export function customerCoreRetryWorthwhile(result: { status: string; reason?: string; cause?: string;
  unknownToolCalls?: readonly unknown[]; evidence?: readonly { value: { kind: string } }[] }, remainingMs: number): boolean {
  return result.status === "held" && result.reason === "turn_unavailable" && result.cause !== "original_context_changed" &&
    !(result.unknownToolCalls?.length) && !result.evidence?.some(e => e.value.kind === "receipt") && remainingMs >= 20_000;
}

/** Held because the chat changed while the turn ran: a NEWER customer input carries these words instead. */
export function customerHeldForChangedContext(reason: string, cause?: string): boolean {
  return reason === "original_context_changed" || reason === "operation_stopped" ||
    reason === "turn_unavailable" && cause === "original_context_changed";
}

type Lang = "ru" | "tg";
type KnownPhone = "none" | "current_input" | "scoped_contact";

/** What this chat already holds: bot lines said (so a line is not repeated) and whether the phone was asked for. */
export function customerSafetyMemory(assistantTexts: readonly string[], blocked: (line: string) => boolean = () => false): FollowUpMemory {
  const said = (line: string) => blocked(line) || assistantTexts.some(text => text.split("\n").some(part => part.trim() === line));
  const phoneAsked = customerPhoneAskLines().some(line => assistantTexts.some(text => text.includes(line))) ||
    assistantTexts.some(text => PHONE_ASK_TEXT.test(text));
  return { said, phoneAsked };
}

/** The line the customer gets instead of silence: the verified "the agent will tell / call" door of #201. */
export function customerSafetyLine(language: Lang, knownPhone: KnownPhone, memory: FollowUpMemory): string {
  return customerStaffFollowUpLine(language, knownPhone, memory);
}

/** Every line the safety door can produce (for the shield pre-check of all candidates in one read). */
export function customerSafetyCandidateLines(): string[] {
  return customerStaffFollowUpFixedLines();
}
