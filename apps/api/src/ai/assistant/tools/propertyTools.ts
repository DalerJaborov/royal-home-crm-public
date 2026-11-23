import { changePropertyPricePlugin } from "./changePropertyPrice.js";
import { deletePropertyPlugin } from "./deletePropertyTool.js";
import { changePropertyStatusPlugin } from "./changePropertyStatus.js";
import { completePropertyEditingPlugin } from "./completePropertyEditing.js";
import { narrationTools } from "./narrationTools.js";
import { requestPropertyChangePlugin } from "./requestPropertyChange.js";
import { restorePropertyPlugin } from "./restorePropertyTool.js";
import { sendToRemakePlugin } from "./sendToRemake.js";
import type { AssistantToolPlugin } from "./types.js";

/**
 * Группа «объекты» (уровень C): цена, статус, выход из монтажа в продажу («Готово»), перемонтаж, заявки на изменение;
 * озвучка словами (narrationTools.ts, 18.11.2026): текст, файл, голос/шаблон/текст, одобрение.
 *
 * Фаза 1 (док. §3): цена, статус и прочее по опубликованному объекту идут
 * заявками руководителю (`lib/propertyChangeRequestService.ts`), как кнопки в
 * карточке; перемонтаж исполняется сразу после подтверждения и необратим.
 * Правила доступа и проверки — в `lib/*`, их же зовёт REST.
 */
export const propertyTools: readonly AssistantToolPlugin[] = [
  changePropertyPricePlugin,
  changePropertyStatusPlugin,
  completePropertyEditingPlugin,
  requestPropertyChangePlugin,
  sendToRemakePlugin,
  deletePropertyPlugin,
  ...narrationTools,
  restorePropertyPlugin,
];
