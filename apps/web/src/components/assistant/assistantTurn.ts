import type { AssistantActionView, AssistantCard } from "@royal-home/shared";
import type { AssistantMessage } from "../../lib/assistantStream";

/**
 * ОДИН ХОД ПОМОЩНИКА В ПАНЕЛИ (П4а) — чистые функции без React, чтобы ход
 * проверялся тестом без браузера: лента шагов из событий `status`, карточки
 * действий из `confirm`, что из реплики уходит в sessionStorage.
 */

/** Реплика в окне + то, что пришло вместе с ответом (в историю хранилища не попадает). */
export type ThreadMessage = AssistantMessage & {
  cards?: AssistantCard[];
  /** Карточки действий (`confirm`), привязанные к этой реплике помощника. */
  actions?: AssistantActionView[];
};

export interface TurnStep {
  text: string;
  done: boolean;
}

/**
 * Новый статус = предыдущий шаг пройден. Повтор того же текста подряд (два
 * инструмента с одной фразой) — один шаг, а не два одинаковых чипа.
 */
export function pushStep(steps: TurnStep[], message: string): TurnStep[] {
  const text = message.trim();
  if (!text) return steps;
  const last = steps[steps.length - 1];
  if (last && !last.done && last.text === text) return steps;
  return [...steps.map((s) => (s.done ? s : { ...s, done: true })), { text, done: false }];
}

/** Подпись чипа: пройденный шаг — без многоточия и с «✓». */
export function stepLabel(step: TurnStep): string {
  return step.done ? `${step.text.replace(/[.…]+$/u, "")} ✓` : step.text;
}

/** Новое событие по уже показанному действию (повтор, исполнение) заменяет прежнее, порядок сохраняется. */
export function upsertAction(actions: AssistantActionView[], action: AssistantActionView): AssistantActionView[] {
  const index = actions.findIndex((a) => a.id === action.id);
  if (index === -1) return [...actions, action];
  const next = actions.slice();
  next[index] = action;
  return next;
}

/**
 * В sessionStorage уходит ТОЛЬКО текст. Карточки и карточки действий — ответ на
 * момент вопроса: после закрытия и открытия панели уже исполненное (или
 * отменённое, истёкшее) действие не должно снова предлагаться к подтверждению.
 */
export function historyForStorage(messages: ThreadMessage[]): AssistantMessage[] {
  return messages.map(({ role, content }) => ({ role, content }));
}
