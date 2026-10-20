import { describe, expect, it } from "vitest";
import { dushanbeLocalToIso, isoToDushanbeLocal, publishAtSchema } from "@royal-home/shared";

/**
 * «ПЕРЕНЕСТИ» В ОЧЕРЕДИ ПУБЛИКАЦИЙ — ВРЕМЯ ДУШАНБЕ (24.09.2026).
 * Поле ввода отдаёт «2026-09-24T19:30» без пояса. Взять его поясом браузера —
 * значит у владельца в поездке ролик, перенесённый «на 19:30», вышел бы в
 * другой час. Правило одно на экран и сервер (packages/shared/publishQueue.ts).
 */
describe("Время выхода ролика — часы Душанбе", () => {
  it("19:30 по Душанбе — это 14:30 UTC, и обратно без сдвига", () => {
    const iso = dushanbeLocalToIso("2026-09-24T19:30");
    expect(iso).toBe("2026-09-24T19:30:00+05:00");
    expect(new Date(iso!).toISOString()).toBe("2026-09-24T14:30:00.000Z");
    expect(isoToDushanbeLocal("2026-09-24T14:30:00.000Z")).toBe("2026-09-24T19:30");
  });

  it("после полуночи по Душанбе — уже следующий день, хотя в UTC ещё вчера", () => {
    expect(isoToDushanbeLocal("2026-09-24T20:10:00.000Z")).toBe("2026-09-25T01:10");
  });

  it("мусор — null, а не полночь 1970 года", () => {
    expect(dushanbeLocalToIso("")).toBeNull();
    expect(dushanbeLocalToIso("завтра")).toBeNull();
    expect(dushanbeLocalToIso("2026-13-40T25:99")).toBeNull();
  });

  it("сервер принимает ровно то, что шлёт экран", () => {
    expect(publishAtSchema.safeParse({ at: dushanbeLocalToIso("2026-09-24T19:30") }).success).toBe(true);
    expect(publishAtSchema.safeParse({ at: "2026-09-24T19:30" }).success).toBe(false);
  });
});
