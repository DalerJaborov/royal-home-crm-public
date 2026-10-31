import {
  AssistantActionError,
  confirmAssistantAction,
  createPendingAssistantAction,
  type AssistantActionActor,
  type AssistantActionView,
} from "../../../lib/assistantActions.js";
import { wrapUntrusted } from "../../untrustedContent.js";
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

/** Потолок одной строки превью в ответе модели (превью короткое: подписи, а не переписка). */
const PREVIEW_FIELD_MAX_CHARS = 500;
/** Ключи, значения которых строит сам код (ссылки по номеру), — их модель получает как есть. */
const TRUSTED_PREVIEW_KEYS = new Set(["href"]);

function wrapPreviewValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && TRUSTED_PREVIEW_KEYS.has(key)) return value;
    return wrapUntrusted("crm_note", value, PREVIEW_FIELD_MAX_CHARS) || value;
  }
  if (Array.isArray(value)) return value.map((item) => wrapPreviewValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrapPreviewValue(v, k)]));
  }
  return value;
}

/**
 * ПРЕВЬЮ ДЛЯ МОДЕЛИ — КОПИЯ, ГДЕ КАЖДАЯ СТРОКА В ГРАНИЦАХ «ДАННЫЕ, НЕ КОМАНДЫ»
 * (сборка П3). Превью собирают инструменты из карточек: имя клиента, адрес,
 * название объекта, причина — свободный текст из базы, и голым в контекст модели
 * он не идёт (тот же приём, что `safeField`). Событие `confirm` для интерфейса
 * получает ИСХОДНОЕ превью без обёрток: его читает человек, теги ему не нужны.
 * Исходник не меняется — копия строится заново.
 */
export function previewForModel(preview: AssistantActionView["preview"]): unknown {
  return wrapPreviewValue(preview);
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
        preview: previewForModel(pending.preview),
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
