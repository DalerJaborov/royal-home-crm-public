import {
  AssistantActionError,
  confirmAssistantAction,
  createPendingAssistantAction,
  type AssistantActionActor,
  type AssistantActionView,
} from "../../../lib/assistantActions.js";
import { describeError } from "../../../lib/describeError.js";
import { logSystemError } from "../../../lib/systemError.js";
import { wrapUntrusted } from "../../untrustedContent.js";
import type { AssistantActor } from "../actor.js";
import type { AssistantToolPlugin } from "./types.js";

/** Права актора помощника в том виде, в каком их принимает брокер действий. */
export function actionActorFrom(actor: AssistantActor, channel: AssistantActionActor["channel"]): AssistantActionActor {
  return { agentId: actor.id, channel, can: (permission) => actor.permissions?.has(permission) ?? false };
}

export interface RunPluginHooks {
  channel: AssistantActionActor["channel"];
  /**
   * Карточка действия готова — отдать клиенту событием `confirm`. Уровень C —
   * PENDING (ждёт «Подтвердить»), уровень B — уже EXECUTED (плашка «Сделано · Отменить»).
   * Будущий вход из Telegram обязан смотреть на `status`, а не рисовать кнопку на каждое событие.
   */
  onConfirm?: (action: AssistantActionView) => void;
}

/** Потолок одной строки превью в ответе модели (превью короткое: подписи, а не переписка). */
const PREVIEW_FIELD_MAX_CHARS = 500;
/**
 * Ключи, значения которых строит сам код (ссылки по номеру, id из базы), — их модель
 * получает как есть: по id она зовёт следующий инструмент.
 */
const isTrustedKey = (key: string) => key === "href" || key === "id" || /Id$/.test(key);

function wrapPreviewValue(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && isTrustedKey(key)) return value;
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
 * Показ карточки — побочный канал (поток панели). Его сбой (оборванный сокет)
 * не должен превращать исполненное действие в «не получилось» для модели.
 */
function notifyConfirm(hooks: RunPluginHooks, action: AssistantActionView, tool: string): void {
  try {
    hooks.onConfirm?.(action);
  } catch (err) {
    void logSystemError("ai", `Инструмент помощника ${tool}: не удалось показать карточку: ${describeError(err)}`);
  }
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
      // Брокер по ключу повтора может вернуть уже подтверждённое (исполняется прямо
      // сейчас) действие — вторую карточку «Подтвердить» на него не показываем.
      if (pending.status !== "PENDING") {
        return {
          confirmRequired: false,
          actionId: pending.id,
          status: pending.status,
          note: "Это действие уже подтверждено человеком — повторно не предлагай.",
        };
      }
      notifyConfirm(hooks, pending, plugin.name);
      return {
        confirmRequired: true,
        actionId: pending.id,
        preview: previewForModel(pending.preview),
        note: "Действие ЕЩЁ НЕ выполнено: человек должен нажать «Подтвердить» в карточке. Не подтверждай сам.",
      };
    }
    // Уровень B: сразу исполняем; откат остаётся кнопкой «Отменить». Та же карточка
    // `confirm`, но уже EXECUTED: человек видит «Сделано · Отменить» (П4а), а не
    // узнаёт о записи только из текста модели.
    const { action } = await confirmAssistantAction(pending.id, actionActor);
    notifyConfirm(hooks, action, plugin.name);
    return { done: true, actionId: action.id, result: action.result, undoUntil: action.undoUntil };
  } catch (err) {
    if (err instanceof AssistantActionError) {
      // Подробности отказа (кандидаты при «несколько подходят») — модели, чтобы она
      // переспросила человека; строки из базы — в границах «данные, не команды».
      const details = Object.keys(err.extra).length > 0 ? { details: wrapPreviewValue(err.extra) } : {};
      return { error: err.message, code: err.code, ...details };
    }
    // Любой другой сбой инструмента не роняет весь ответ: модель скажет человеку,
    // что не вышло, а сбой уйдёт в «Здоровье системы».
    void logSystemError("ai", `Инструмент помощника ${plugin.name} упал: ${describeError(err)}`);
    return { error: "Не получилось выполнить действие — попробуйте ещё раз или сделайте это в карточке", code: "TOOL_FAILED" };
  }
}
