import type { PultAreaId } from "@royal-home/shared";

/**
 * Инвентарь решений «Решить одной кнопкой» (спецификация v8 §3, слой 2 задача 6).
 *
 * Правило договора §6.11: ни одна строка-действие не рисуется без реального
 * `data-endpoint` из этого списка — каждый метод+путь здесь проверен по коду
 * `apps/api/src/routes/*` (не придуман по аналогии), см. таблицу в отчёте
 * `docs/pult/theme-2026/reports/L2-T6.md`. Отмена (`hasUndo`) — тоже по факту
 * наличия обратного эндпоинта в §3, не по похожести соседней строки (риск №2
 * плана слоя 2 — «Одобрить материалы» и «Одобрить сделку» выглядят похоже, но
 * у материалов обратного вызова нет).
 */
export type ActionInventoryId =
  | "deal-approve"
  | "property-material-approve"
  | "system-errors-resolve-all"
  | "client-transfer";

export interface ActionInventoryEntry {
  id: ActionInventoryId;
  /** Плитка §2, под которой рисуется строка-действие. */
  areaId: PultAreaId;
  /** Название решения — как в таблице §3 спецификации. */
  decision: string;
  method: "GET" | "POST" | "PATCH";
  /** Путь с `:id`-плейсхолдером, как реально смонтирован в apps/api (app.ts). */
  path: string;
  /** `METHOD /api/v1/path` — то же значение, что уходит в data-endpoint кнопки. */
  endpoint: string;
  hasUndo: boolean;
  /** Обратный вызов — тот же метод+путь, что основное действие (симметричный toggle), либо явный отдельный эндпоинт. */
  undoEndpoint?: string;
}

export const ACTION_INVENTORY: ActionInventoryEntry[] = [
  {
    id: "deal-approve",
    areaId: "deals",
    decision: "Одобрить сделку (комиссию)",
    method: "PATCH",
    path: "/api/v1/deals/:id",
    endpoint: "PATCH /api/v1/deals/:id",
    hasUndo: true,
    undoEndpoint: "PATCH /api/v1/deals/:id",
  },
  {
    id: "property-material-approve",
    areaId: "properties",
    decision: "Одобрить материалы объекта",
    method: "POST",
    path: "/api/v1/properties/:id/review/approve",
    endpoint: "POST /api/v1/properties/:id/review/approve",
    // Нет обратного эндпоинта (спецификация §3, строка «Одобрить материалы») —
    // после нажатия «Одобрено · открыть», без «Отменить».
    hasUndo: false,
  },
  {
    id: "system-errors-resolve-all",
    areaId: "system",
    decision: "Закрыть все ошибки системы",
    method: "POST",
    path: "/api/v1/errors/resolve-all",
    endpoint: "POST /api/v1/errors/resolve-all",
    hasUndo: false,
  },
  {
    id: "client-transfer",
    areaId: "clients",
    decision: "Передать зависшего клиента",
    method: "POST",
    path: "/api/v1/clients/:id/assign",
    endpoint: "POST /api/v1/clients/:id/assign",
    hasUndo: true,
    undoEndpoint: "POST /api/v1/clients/:id/assign",
  },
];

export function findActionInventory(id: ActionInventoryId): ActionInventoryEntry {
  const entry = ACTION_INVENTORY.find((e) => e.id === id);
  if (!entry) throw new Error(`Неизвестное решение инвентаря: ${id}`);
  return entry;
}
