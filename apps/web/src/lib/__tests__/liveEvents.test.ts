import { describe, expect, it } from "vitest";
import { LIVE_EVENT_TYPES } from "@royal-home/shared";
import { INVALIDATION } from "../liveEvents";

/**
 * КАРТА «СОБЫТИЕ → ЧТО ПРОТУХЛО».
 *
 * Тип Record<LiveEventType, ...> ловит забытую строку прямо на сборке, но не
 * ловит две вещи, которые ломают живость молча: пустой список (событие приходит
 * и не делает ничего) и опечатку в ключе запроса, который в CRM не существует.
 * Ровно это здесь и проверяется.
 */

/** Ключи TanStack Query, которые реально живут в хуках apps/web/src/hooks. */
const KNOWN_ROOTS = new Set([
  "clients",
  "client",
  "conversations",
  "deals",
  "counters",
  "notifications",
  "mission-control",
  "mission-control-ticker",
  "dashboard-summary",
  "dashboard-team-live",
  "team",
  "oversight",
  "properties",
  "property",
  "marketing",
  "incoming-calls",
  "calls",
  "call-feed",
  "call-insights",
  "calls-summary",
  "delete-requests",
  "client-delete-request",
  "property-delete-requests",
  "property-delete-request",
  "property-change-requests",
  "property-count-disputes",
  "client-property-count-dispute",
  "report-waiting-now",
  "me",
  "clients-lost",
  "clients-deferred",
  "clients-trash",
  "reactivation-offers",
]);

describe("карта инвалидации живых событий", () => {
  it("у каждого типа события есть непустая запись", () => {
    for (const type of LIVE_EVENT_TYPES) {
      expect(INVALIDATION[type], `нет записи для ${type}`).toBeDefined();
      expect(INVALIDATION[type].length, `пустой список у ${type}`).toBeGreaterThan(0);
    }
  });

  it("лишних типов в карте нет", () => {
    expect(Object.keys(INVALIDATION).sort()).toEqual([...LIVE_EVENT_TYPES].sort());
  });

  it("каждый ключ — непустой массив строк с известным корнем", () => {
    for (const [type, keys] of Object.entries(INVALIDATION)) {
      for (const key of keys) {
        expect(Array.isArray(key), `${type}: ключ не массив`).toBe(true);
        expect(key.length, `${type}: пустой ключ`).toBeGreaterThan(0);
        for (const part of key) expect(typeof part).toBe("string");
        expect(KNOWN_ROOTS.has(key[0]), `${type}: неизвестный корень ключа «${key[0]}»`).toBe(true);
      }
    }
  });

  it("события второго захода покрывают свои экраны", () => {
    const roots = (type: (typeof LIVE_EVENT_TYPES)[number]) => INVALIDATION[type].map((k) => k[0]);
    expect(roots("call.updated")).toContain("incoming-calls");
    expect(roots("client.updated")).toEqual(
      expect.arrayContaining([
        "clients",
        "client",
        "oversight",
        // Ночной аудит 24.09.2026 (№12): «Потеряны», «Отложены», «Корзина» и
        // предложения реактивации — те же три окна, что и остальные списки
        // клиентов, но с отдельными ключами запроса (useClients.ts:657, 690,
        // 260, 867).
        "clients-lost",
        "clients-deferred",
        "clients-trash",
        "reactivation-offers",
      ])
    );
    // «marketing» — очереди передачи видео читают те же объекты (ночная проверка 01.10.2026, №252).
    expect(roots("property.updated")).toEqual(expect.arrayContaining(["properties", "property", "marketing"]));
    expect(roots("request.updated")).toEqual(
      expect.arrayContaining(["delete-requests", "property-delete-requests", "property-count-disputes"])
    );
  });
});
