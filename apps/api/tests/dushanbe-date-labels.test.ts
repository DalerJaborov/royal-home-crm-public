import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import { dushanbeDateString } from "../src/lib/dushanbeTime.js";
import { computeHiddenReason, deferredReturnMessage } from "../src/routes/clients/shared.js";
import { loadGuardStats } from "../src/ai/guardMetrics.js";

/**
 * Ночная проверка 01.10.2026, №175 и №176: даты в подписях и граница «за N
 * суток» брались по UTC, хотя день у нас — по Душанбе (UTC+5). С 00:00 до 05:00
 * по Душанбе UTC ещё «вчера»: подпись «Удалил(а) …, дата» и «вернётся в работу
 * <дата>» показывали вчерашний день, а метрики стражей отдавали лишние сутки.
 *
 * 02:00 по Душанбе 2 октября = 21:00 UTC 1 октября.
 */
const NIGHT = new Date("2026-10-01T21:00:00.000Z");

const client = (extra: Record<string, unknown>) => ({
  deletedAt: null,
  kind: "BUYER" as const,
  status: "NEW",
  workStatus: "ACTIVE",
  acceptedAt: new Date(),
  ...extra,
});

afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await prisma.guardHit.deleteMany({ where: { guard: "night_e_test" } });
});

describe("даты в подписях — по Душанбе", () => {
  it("dushanbeDateString: 21:00 UTC уже следующие сутки", () => {
    expect(dushanbeDateString(NIGHT)).toBe("2026-10-02");
  });

  it("«В Корзине»: Удалил(а) … — дата по Душанбе", () => {
    const info = computeHiddenReason(client({ deletedAt: NIGHT, deletedByName: "Сафар" }));
    expect(info?.detail).toBe("Удалил(а) Сафар, 2026-10-02");
    expect(computeHiddenReason(client({ deletedAt: NIGHT }))?.detail).toBe("Удалена 2026-10-02");
  });

  it("«Отложен»: до какой даты — по Душанбе", () => {
    const info = computeHiddenReason(client({ workStatus: "DEFERRED", deferredUntil: NIGHT }));
    expect(info?.detail).toBe("До 2026-10-02");
  });

  it("сообщение агенту после «отложить» — дата возврата по Душанбе", () => {
    expect(deferredReturnMessage(NIGHT)).toContain("автоматически 2026-10-02 ");
  });
});

describe("loadGuardStats: граница дней по Душанбе (№175)", () => {
  it("в 01:00 по Душанбе «за 1 день» не захватывает позавчерашний ключ", async () => {
    // Ключи дней пишутся по Душанбе: сегодня 2026-10-02, вчера 2026-10-01, позавчера 2026-09-30.
    for (const day of ["2026-09-30", "2026-10-01", "2026-10-02"]) {
      await prisma.guardHit.upsert({
        where: { day_guard: { day, guard: "night_e_test" } },
        update: { count: 1 },
        create: { day, guard: "night_e_test", count: 1 },
      });
    }
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-01T20:00:00.000Z") }); // 01:00 2 октября по Душанбе
    const days = (await loadGuardStats(1)).filter((r) => r.guard === "night_e_test").map((r) => r.day);
    expect(days.sort()).toEqual(["2026-10-01", "2026-10-02"]);
  });
});
