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
import { decide, initialOperatorState } from "./decide.js";
import { OPERATOR_PHRASES, renderOperatorReply, renderOperatorStep } from "./phrases.js";
import { readOperatorState, serializeOperatorState, type StoredOperatorState } from "./state.js";
import { logSystemError } from "../../lib/systemError.js";
import { understandFallback, understandTurn, type OperatorTurnInput } from "./understand.js";
import { REVIEWER_RESET } from "../../lib/botReviewers.js";
import { composeOperatorReply } from "./compose.js";
import { clientOwnWords } from "../untrustedContent.js";
import type { LeadOnlyIntentModel } from "../leadOnlyIntent.js";
import type { OperatorAction, OperatorContext, OperatorLanguage, OperatorState, OperatorStepOut, Understanding } from "./types.js";

export * from "./types.js";
export { decide, initialOperatorState, operatorLeadNote } from "./decide.js";
export { OPERATOR_PHRASES, operatorWhenText, renderOperatorReply, renderOperatorStep } from "./phrases.js";
export { readOperatorState, saveOperatorStateTx, serializeOperatorState } from "./state.js";
export { understandFallback, understandTurn, type OperatorTurnInput } from "./understand.js";
export { checkComposedReply, composeOperatorReply } from "./compose.js";

export interface OperatorTurnRequest {
  /** Содержимое `BotConversation.leadOnlyPending` как есть (версия 1, 2, пусто или мусор). */
  storedState: unknown;
  input: OperatorTurnInput;
  ctx: OperatorContext;
  now?: Date;
  /** Только для тестов: подмена модели понимания. */
  model?: LeadOnlyIntentModel;
  timeoutMs?: number;
  /** «Бот пишет своими словами» (Настройки, botOwnWords): модель пишет ответ под выбранный шаг (compose.ts). */
  ownWords?: { enabled: boolean; model?: LeadOnlyIntentModel };
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
  /** Ход отдан прежнему пути рекрутёра (вакансия): ответа оператора нет, маршрут идёт дальше своим путём. */
  handoff?: "recruiter";
  /** Ход собран запасным путём после сбоя (ошибка в журнале). */
  degraded?: true;
}

/**
 * ЗАПАСНОЙ ХОД ПОСЛЕ СБОЯ (ревью 19.11, Р9): решение или текст не собрались — клиент не остаётся без ответа. Шаг «контакт»:
 * номер известен и роль понятна — заявка всё равно ставится и звучит строка заявки; номера нет — просьба номера; номер
 * есть, роль не ясна — вопрос о роли; заявка уже есть — тишина. Тексты — первые варианты фраз, без подстановки шаблона.
 */
function fallbackTurn(previous: OperatorState, understanding: Understanding, ctx: OperatorContext, now: Date): OperatorTurnResult {
  const language: OperatorLanguage = previous.language ?? understanding.language ?? understanding.contextLanguage ?? understanding.languageHint ?? "ru";
  const role = previous.role === "seller" || understanding.role === "seller" ? "seller"
    : previous.role === "buyer" || previous.role === "buyer_property" || understanding.role === "buyer" ? "buyer" : null;
  const phoneKnown = ctx.phoneKnown || !!understanding.phone;
  const state: OperatorState = { ...previous };
  const actions: OperatorAction[] = [];
  let text: string | null = null;
  if (previous.leadAccepted || ctx.leadExists) text = null;
  // Номер в словах клиента — заявка всегда, даже когда роль не ясна (решит классификатор приёма; владелец 20.11.2026).
  // Соискатель и аренда заявкой не становятся (SPEC, таблица ролей) — и в запасном ходе тоже (ревью #333).
  else if (((phoneKnown && role) || understanding.phone) && !["job", "rent"].includes(previous.role) &&
    understanding.role !== "job" && understanding.role !== "rent") {
    actions.push({ type: "accept_lead", role, propertyId: role === "buyer" && previous.role === "buyer_property" ? previous.propertyId : null,
      phone: understanding.phone, note: `Бот не смог собрать ответ, заявка запасным путём. Слова клиента: «${understanding.quote}»`,
      outOfArea: previous.outOfArea, callbackWhen: null, textOnly: false, noCall: previous.noCall });
    state.leadAccepted = true; state.step = "done";
    text = (understanding.phone && !ctx.phoneKnown ? OPERATOR_PHRASES.phone_received : OPERATOR_PHRASES.lead_known_phone)[language][0]
      .replace("{when}", ctx.callbackWhen[language]);
  } else if (!phoneKnown) text = OPERATOR_PHRASES.ask_phone[language][0];
  else text = OPERATOR_PHRASES.ask_role[language][0];
  let stored: StoredOperatorState;
  try { stored = serializeOperatorState(state, now); } catch { stored = serializeOperatorState(initialOperatorState(), now); }
  return { text, parts: text ? [text] : [], language, steps: [], facts: {}, actions, state, stored, understanding, degraded: true };
}

export async function runOperatorTurn(request: OperatorTurnRequest): Promise<OperatorTurnResult> {
  const now = request.now ?? new Date();
  const previous = readOperatorState(request.storedState, now);
  // Проверяющий (lib/botReviewers.ts) пишет «сброс»: память разговора с нуля, модель не зовётся.
  if (request.ctx.reviewer && REVIEWER_RESET.test(clientOwnWords(request.input.current))) {
    const state = initialOperatorState();
    const language: OperatorLanguage = previous.language ?? "ru";
    const step: OperatorStepOut = { key: "reviewer_reset", vars: {}, variant: 0 };
    const text = renderOperatorStep(step, language);
    return { text, parts: [text], language, steps: [step], facts: {}, actions: [], state, stored: serializeOperatorState(state, now),
      understanding: understandFallback(request.input, state, request.ctx) };
  }
  const understanding = await understandTurn(request.input, previous, request.ctx, request.model, request.timeoutMs);
  try {
    const decision = decide(previous, understanding, request.ctx);
    let parts = decision.steps.map(step => renderOperatorStep(step, decision.language));
    let text = renderOperatorReply(decision.steps, decision.language) || null;
    if (text && request.ownWords?.enabled) {
      const composed = await composeOperatorReply({ steps: decision.steps, template: text, language: decision.language, current: request.input.current,
        ...(request.input.recent ? { recent: request.input.recent } : {}), conversationId: request.input.conversationId ?? null,
        ...(request.ownWords.model ? { model: request.ownWords.model } : {}) });
      if (composed.source === "model") { text = composed.text; parts = [composed.text]; }
    }
    const facts = Object.assign({}, ...decision.steps.map(step => step.vars)) as OperatorTurnResult["facts"];
    return { text, parts, language: decision.language, steps: decision.steps, facts, actions: decision.actions, state: decision.state,
      stored: serializeOperatorState(decision.state, now), understanding, ...(decision.handoff ? { handoff: decision.handoff } : {}) };
  } catch (error) {
    // Ход не собрался (фраза, память): не молчим — запасной шаг «контакт», ошибка в журнал.
    void logSystemError("ai", `[alarm] Оператор заявок: ход не собран (диалог ${request.input.conversationId ?? "?"}): ` +
      `${error instanceof Error ? error.message : String(error)}`.slice(0, 500), { dedupKey: `operator-turn-failed:${request.input.conversationId ?? "?"}` });
    return fallbackTurn(previous, understanding, request.ctx, now);
  }
}
