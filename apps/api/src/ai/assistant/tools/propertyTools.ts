import { changePropertyPricePlugin } from "./changePropertyPrice.js";
import { changePropertyStatusPlugin } from "./changePropertyStatus.js";
import { requestPropertyChangePlugin } from "./requestPropertyChange.js";
import { sendToRemakePlugin } from "./sendToRemake.js";
import type { AssistantToolPlugin } from "./types.js";

/**
 * Группа «объекты» (уровень C): цена, статус, перемонтаж, заявки на изменение.
 *
 * Фаза 1 (док. §3): цена, статус и прочее по опубликованному объекту идут
 * заявками руководителю (`lib/propertyChangeRequestService.ts`), как кнопки в
 * карточке; перемонтаж исполняется сразу после подтверждения и необратим.
 * Правила доступа и проверки — в `lib/*`, их же зовёт REST.
 */
export const propertyTools: readonly AssistantToolPlugin[] = [
  changePropertyPricePlugin,
  changePropertyStatusPlugin,
  requestPropertyChangePlugin,
  sendToRemakePlugin,
];
