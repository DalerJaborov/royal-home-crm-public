/**
 * ОПЕРАТОР ПРИЁМА ЗАЯВОК — ОДНА ДВЕРЬ ХОДА (docs/bot-operator/SPEC.md, PLAN.md этап 1.1).
 *
 * `runOperatorTurn`: память разговора (jsonb) → понять ход (understand.ts, модель или запасные правила) → решить шаг
 * (decide.ts, чистая функция) → текст (phrases.ts). Возвращает и готовый текст, и ключи шагов с переменными-фактами:
 * слой «бот пишет своими словами» (`compose`, этап 1.4 плана) встанет МЕЖДУ решением и текстом — получит `steps` и
 * `facts`, напишет свой вариант, пройдёт проверку, а при провале останется `text` отсюда. Пока его нет, `text` — ответ.
 *
 * К живому пути НЕ подключено (этап 1.2): ни базы, ни отправки, ни заявок здесь нет. Действия (`accept_lead`,
 * `append_note`, `call_staff`) исполняет вызывающий в той же транзакции, что и ответ (приём `customer-lead-only-intake`).
 */
import { decide } from "./decide.js";
import { renderOperatorReply, renderOperatorStep } from "./phrases.js";
import { readOperatorState, serializeOperatorState, type StoredOperatorState } from "./state.js";
import { understandTurn, type OperatorTurnInput } from "./understand.js";
import type { LeadOnlyIntentModel } from "../leadOnlyIntent.js";
import type { OperatorAction, OperatorContext, OperatorLanguage, OperatorState, OperatorStepOut, Understanding } from "./types.js";

export * from "./types.js";
export { decide, initialOperatorState, operatorLeadNote } from "./decide.js";
export { OPERATOR_PHRASES, operatorWhenText, renderOperatorReply, renderOperatorStep } from "./phrases.js";
export { readOperatorState, saveOperatorStateTx, serializeOperatorState } from "./state.js";
export { understandFallback, understandTurn, type OperatorTurnInput } from "./understand.js";

export interface OperatorTurnRequest {
  /** Содержимое `BotConversation.leadOnlyPending` как есть (версия 1, 2, пусто или мусор). */
  storedState: unknown;
  input: OperatorTurnInput;
  ctx: OperatorContext;
  now?: Date;
  /** Только для тестов: подмена модели понимания. */
  model?: LeadOnlyIntentModel;
  timeoutMs?: number;
}

export interface OperatorTurnResult {
  /** Готовый ответ клиенту; null — тишина. */
  text: string | null;
  /** Ответ по шагам (каждый — одно предложение). */
  parts: string[];
  language: OperatorLanguage;
  /** Ключи шагов с переменными — вход будущего слоя `compose` (этап 1.4). */
  steps: OperatorStepOut[];
  /** Факты, которые слою `compose` можно называть (номер объекта, цена, время, комиссия): только из базы и Настроек. */
  facts: Readonly<Record<string, string | number | readonly string[]>>;
  actions: OperatorAction[];
  state: OperatorState;
  /** Значение для записи в `BotConversation.leadOnlyPending` (state.ts::saveOperatorStateTx делает то же). */
  stored: StoredOperatorState;
  understanding: Understanding;
}

export async function runOperatorTurn(request: OperatorTurnRequest): Promise<OperatorTurnResult> {
  const now = request.now ?? new Date();
  const previous = readOperatorState(request.storedState, now);
  const understanding = await understandTurn(request.input, previous, request.ctx, request.model, request.timeoutMs);
  const decision = decide(previous, understanding, request.ctx);
  const parts = decision.steps.map(step => renderOperatorStep(step, decision.language));
  const text = renderOperatorReply(decision.steps, decision.language) || null;
  const facts = Object.assign({}, ...decision.steps.map(step => step.vars)) as OperatorTurnResult["facts"];
  return { text, parts, language: decision.language, steps: decision.steps, facts, actions: decision.actions, state: decision.state,
    stored: serializeOperatorState(decision.state, now), understanding };
}
