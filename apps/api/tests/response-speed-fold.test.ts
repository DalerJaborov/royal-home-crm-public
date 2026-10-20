import { describe, expect, it } from "vitest";
import { RESPONSE_SPEED_MIN_SAMPLE } from "@royal-home/shared";
import { bucketKeyForMinutes, foldResponseSpeed, type ResponseSpeedLeadInput } from "../src/lib/responseSpeed.js";

/** Чистая свёртка «скорость ответа против показа» — без базы, на фикстурах. */

const T0 = new Date("2026-08-01T10:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const lead = (answerAfterMin: number | null, reachedShowing: boolean): ResponseSpeedLeadInput => ({
  createdAt: T0,
  firstContactAt: answerAfterMin == null ? null : at(answerAfterMin),
  reachedShowing,
});
const many = (n: number, make: (i: number) => ResponseSpeedLeadInput) => Array.from({ length: n }, (_, i) => make(i));

describe("bucketKeyForMinutes", () => {
  it("границы исключительные сверху: ровно 1, 5, 15, 60 минут — уже в следующей корзине", () => {
    expect(bucketKeyForMinutes(0)).toBe("lt1");
    expect(bucketKeyForMinutes(0.99)).toBe("lt1");
    expect(bucketKeyForMinutes(1)).toBe("m1to5");
    expect(bucketKeyForMinutes(4.9)).toBe("m1to5");
    expect(bucketKeyForMinutes(5)).toBe("m5to15");
    expect(bucketKeyForMinutes(15)).toBe("m15to60");
    expect(bucketKeyForMinutes(59.9)).toBe("m15to60");
    expect(bucketKeyForMinutes(60)).toBe("gt60");
    expect(bucketKeyForMinutes(5000)).toBe("gt60");
  });
});

describe("foldResponseSpeed", () => {
  it("пустой вход — шесть пустых корзин, ни ошибок, ни делений на ноль", () => {
    const r = foldResponseSpeed([]);
    expect(r.leads).toBe(0);
    expect(r.medianMinutes).toBeNull();
    expect(r.excluded).toBe(0);
    expect(r.buckets.map((b) => b.key)).toEqual(["lt1", "m1to5", "m5to15", "m15to60", "gt60", "none"]);
    for (const b of r.buckets) {
      expect(b).toMatchObject({ leads: 0, share: 0, reachedShowing: 0, showingRate: null, medianMinutes: null });
    }
  });

  it("раскладывает по корзинам, считает долю показа и долю обращений", () => {
    const rows = [
      ...many(RESPONSE_SPEED_MIN_SAMPLE, (i) => lead(0.5, i < 5)), // до минуты: 5 из 10 дошли
      ...many(RESPONSE_SPEED_MIN_SAMPLE, (i) => lead(30, i < 2)), // 15–60: 2 из 10
      ...many(RESPONSE_SPEED_MIN_SAMPLE, () => lead(null, false)), // без ответа
    ];
    const r = foldResponseSpeed(rows);
    const by = Object.fromEntries(r.buckets.map((b) => [b.key, b]));
    expect(r.leads).toBe(30);
    expect(by.lt1).toMatchObject({ leads: 10, reachedShowing: 5, showingRate: 0.5 });
    expect(by.lt1.share).toBeCloseTo(1 / 3);
    expect(by.m15to60).toMatchObject({ leads: 10, reachedShowing: 2, showingRate: 0.2, medianMinutes: 30 });
    expect(by.none).toMatchObject({ leads: 10, reachedShowing: 0, showingRate: 0, medianMinutes: null });
    // Медиана — только по ответившим: десять по 0,5 и десять по 30 минут.
    expect(r.medianMinutes).toBe(15.3);
  });

  it("корзина меньше порога выборки — доли показа нет («мало данных»), но обращения посчитаны", () => {
    const r = foldResponseSpeed(many(RESPONSE_SPEED_MIN_SAMPLE - 1, () => lead(3, true)));
    const b = r.buckets.find((x) => x.key === "m1to5")!;
    expect(b.leads).toBe(RESPONSE_SPEED_MIN_SAMPLE - 1);
    expect(b.reachedShowing).toBe(RESPONSE_SPEED_MIN_SAMPLE - 1);
    expect(b.showingRate).toBeNull();
  });

  it("ответ раньше создания карточки — не про скорость: исключён и не попадает ни в одну корзину", () => {
    const r = foldResponseSpeed([lead(-10, true), lead(2, false)]);
    expect(r.excluded).toBe(1);
    expect(r.leads).toBe(1);
    expect(r.buckets.find((b) => b.key === "m1to5")!.leads).toBe(1);
  });
});
