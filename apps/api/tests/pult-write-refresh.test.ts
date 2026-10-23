import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { isPultRelevantWrite, pultWriteRefresh } from "../src/lib/pultWriteRefresh.js";
import { registerPultSnapshotPublisher } from "../src/lib/pultCacheHook.js";

describe("любое действие сотрудника обновляет пульт", () => {
  it("успешная запись вошедшего сотрудника — да", () => {
    expect(isPultRelevantWrite("POST", "/api/v1/errors/resolve-all", 200, true)).toBe(true);
    expect(isPultRelevantWrite("PATCH", "/api/v1/deals/1", 204, true)).toBe(true);
  });

  it("чтение, отказ, гость и фоновые служебные записи — нет", () => {
    expect(isPultRelevantWrite("GET", "/api/v1/dashboard/mission-control/live", 200, true)).toBe(false);
    expect(isPultRelevantWrite("POST", "/api/v1/errors/resolve-all", 403, true)).toBe(false);
    expect(isPultRelevantWrite("POST", "/api/v1/errors/resolve-all", 200, false)).toBe(false);
    expect(isPultRelevantWrite("POST", "/api/v1/_seen", 204, true)).toBe(false);
    expect(isPultRelevantWrite("POST", "/api/v1/events/ticket", 200, true)).toBe(false);
    expect(isPultRelevantWrite("PUT", "/api/v1/properties/drafts/current", 200, true)).toBe(false);
    // Префикс сравнивается по границе сегмента, а не по подстроке.
    expect(isPultRelevantWrite("POST", "/api/v1/eventsx", 200, true)).toBe(true);
  });

  it("промежуточный слой зовёт снимок пульта после ответа", () => {
    const snapshot = vi.fn();
    registerPultSnapshotPublisher(snapshot);
    const res = Object.assign(new EventEmitter(), { statusCode: 200 });
    const next = vi.fn();
    const req = { method: "POST", originalUrl: "/api/v1/instagram-comments/1/hide?x=1", agent: { id: "a" } };
    pultWriteRefresh(req as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(snapshot).not.toHaveBeenCalled();
    res.emit("finish");
    expect(snapshot).toHaveBeenCalledOnce();
  });
});
