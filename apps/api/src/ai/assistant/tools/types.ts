import type { AssistantActionExecutor } from "../../../lib/assistantActions.js";
import type { AssistantActor } from "../actor.js";

/**
 * ТОЧКА РАСШИРЕНИЯ ИНСТРУМЕНТОВ ПОМОЩНИКА (П3, 31.10.2026,
 * docs/design/internal-assistant-architecture-2026-10-31.md §2.2).
 *
 * Новый инструмент — один файл в `ai/assistant/tools/` и одна запись в группе
 * (`readTools.ts` и т.п.), а не правка `assistant.ts`. Ядро само объявляет его
 * модели, выбирает параллельный или последовательный запуск и показывает фразу
 * статуса.
 *
 * Уровни (§2.2):
 *  - A — читает: `run`, идёт параллельно с другими чтениями, ничего не пишет;
 *  - B — малая запись (заметка, своя задача): `executor`, исполняется сразу, ответ
 *    несёт `undoUntil` — откат кнопкой «Отменить»;
 *  - C — изменение с подтверждением: `executor`, ядро только готовит действие
 *    («было → станет»), исполняет его человек кнопкой «Подтвердить».
 * Запись (B, C) НЕ объявляется модели, пока клиент не умеет показать подтверждение
 * (заголовок `X-Assistant-Confirm: 1`): иначе модель просила бы нажать кнопку,
 * которой нет.
 */
export type AssistantToolLevel = "A" | "B" | "C";

export interface AssistantToolContext {
  actor: AssistantActor;
}

interface AssistantToolBase {
  /** Имя для Gemini: латиница, snake_case, уникально среди всех инструментов. */
  name: string;
  description: string;
  /** Пусто у функции без аргументов: пустую схему объекта Gemini отвергает с 400. */
  parameters?: Record<string, unknown>;
  /** Фраза пошагового статуса («Ищу клиентов…»). */
  statusPhrase: string;
  /**
   * Доступен ли инструмент этому актору. Недоступный модели не объявляется
   * (подсказка, не защита): защита — проверка прав внутри `run` / исполнителя.
   */
  allowed?: (actor: AssistantActor) => boolean;
}

export interface AssistantReadToolPlugin extends AssistantToolBase {
  level: "A";
  /** Аргументы приходят «как есть» от модели — разбирать zod-схемой на входе. */
  run: (args: Record<string, unknown>, ctx: AssistantToolContext) => Promise<unknown>;
}

export interface AssistantWriteToolPlugin extends AssistantToolBase {
  level: "B" | "C";
  /**
   * Исполнитель действия. Его `tool` обязан совпадать с `name` плагина — по нему
   * брокер (lib/assistantActions.ts) находит исполнителя на подтверждении и откате.
   */
  executor: AssistantActionExecutor<never>;
}

export type AssistantToolPlugin = AssistantReadToolPlugin | AssistantWriteToolPlugin;
