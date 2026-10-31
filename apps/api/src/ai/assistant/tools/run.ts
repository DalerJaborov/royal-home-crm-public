import {
  AssistantActionError,
  confirmAssistantAction,
  createPendingAssistantAction,
  type AssistantActionActor,
  type AssistantActionView,
} from "../../../lib/assistantActions.js";
import type { AssistantActor } from "../actor.js";
import type { AssistantToolPlugin } from "./types.js";

/** Права актора помощника в том виде, в каком их принимает брокер действий. */
export function actionActorFrom(actor: AssistantActor, channel: AssistantActionActor["channel"]): AssistantActionActor {
  return { agentId: actor.id, channel, can: (permission) => actor.permissions?.has(permission) ?? false };
}

export interface RunPluginHooks {
  channel: AssistantActionActor["channel"];
  /** Карточка подтверждения готова — отдать клиенту событием `confirm`. */
  onConfirm?: (action: AssistantActionView) => void;
}

/**
 * Исполняет вызов инструмента-плагина и возвращает то, что увидит МОДЕЛЬ.
 * Ошибки прав и устаревания — обычным ответом `{ error }`, чтобы модель
 * объяснила человеку, а не падала.
 */
export async function runAssistantToolPlugin(
  plugin: AssistantToolPlugin,
  args: Record<string, unknown>,
  actor: AssistantActor,
  hooks: RunPluginHooks,
): Promise<unknown> {
  try {
    if (plugin.level === "A") return await plugin.run(args, { actor });

    const actionActor = actionActorFrom(actor, hooks.channel);
    const pending = await createPendingAssistantAction(actionActor, plugin.name, args);
    if (plugin.level === "C") {
      hooks.onConfirm?.(pending);
      return {
        confirmRequired: true,
        actionId: pending.id,
        preview: pending.preview,
        note: "Действие ЕЩЁ НЕ выполнено: человек должен нажать «Подтвердить» в карточке. Не подтверждай сам.",
      };
    }
    // Уровень B: сразу исполняем; откат остаётся кнопкой «Отменить».
    const { action } = await confirmAssistantAction(pending.id, actionActor);
    return { done: true, actionId: action.id, result: action.result, undoUntil: action.undoUntil };
  } catch (err) {
    if (err instanceof AssistantActionError) return { error: err.message, code: err.code };
    throw err;
  }
}
