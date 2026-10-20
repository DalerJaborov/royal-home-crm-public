import { describe, expect, it } from "vitest";
import { ACTION_INVENTORY } from "../ActionInventory";

/**
 * Таблица реально смонтированных маршрутов apps/api (проверено вручную по
 * `apps/api/src/app.ts` + соответствующему роутеру на момент задачи L2-T6 —
 * см. `docs/pult/theme-2026/reports/L2-T6.md`, раздел «Проверка эндпоинтов»):
 *
 * - PATCH /api/v1/deals/:id            — dealsRouter.patch("/:id", ...)      app.ts: app.use("/api/v1/deals", dealsRouter)
 * - POST  /api/v1/properties/:id/review/approve — moderationRouter, смонтирован в propertiesRouter, app.ts: app.use("/api/v1/properties", propertiesRouter)
 * - POST  /api/v1/errors/resolve-all   — errorLogRouter.post("/resolve-all") app.ts: app.use("/api/v1/errors", errorLogRouter)
 * - POST  /api/v1/clients/:id/assign   — lifecycleRouter.post("/:id/assign") app.ts: app.use("/api/v1/clients", clientsRouter) (lifecycleRouter смонтирован внутри clientsRouter)
 *
 * Правило договора §6.11 (ни одной строки без реального data-endpoint) проверяется
 * здесь на уровне таблицы: каждая запись инвентаря обязана совпасть с одной из
 * этих строк по методу+пути (плейсхолдер `:id` нормализуется одинаково).
 */
const KNOWN_ROUTES = new Set([
  "PATCH /api/v1/deals/:id",
  "POST /api/v1/properties/:id/review/approve",
  "POST /api/v1/errors/resolve-all",
  "POST /api/v1/clients/:id/assign",
]);

describe("ActionInventory: каждое решение указывает на реально существующий эндпоинт", () => {
  it("инвентарь не пуст и содержит 3–4 записи (задача L2-T6)", () => {
    expect(ACTION_INVENTORY.length).toBeGreaterThanOrEqual(3);
    expect(ACTION_INVENTORY.length).toBeLessThanOrEqual(4);
  });

  it.each(ACTION_INVENTORY)("$id: $endpoint существует в apps/api/src/routes", (entry) => {
    expect(KNOWN_ROUTES.has(entry.endpoint)).toBe(true);
    expect(entry.endpoint).toBe(`${entry.method} ${entry.path}`);
  });

  it.each(ACTION_INVENTORY.filter((e) => e.hasUndo))(
    "$id: если hasUndo=true, undoEndpoint тоже существует в apps/api/src/routes",
    (entry) => {
      expect(entry.undoEndpoint).toBeTruthy();
      expect(KNOWN_ROUTES.has(entry.undoEndpoint!)).toBe(true);
    }
  );

  it("ни одна запись без hasUndo не указывает undoEndpoint (не выдумываем отмену)", () => {
    for (const entry of ACTION_INVENTORY.filter((e) => !e.hasUndo)) {
      expect(entry.undoEndpoint).toBeUndefined();
    }
  });

  it("id инвентаря уникальны", () => {
    const ids = ACTION_INVENTORY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
