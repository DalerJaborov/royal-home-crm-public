import { describe, expect, it } from "vitest";
import { runInOverlaySlot } from "../src/lib/ffmpeg.js";

/** Один ffmpeg наложения на процесс (26.11.2026): истории-ролики очереди и ежедневной подборки не идут разом. */
describe("runInOverlaySlot", () => {
  it("одновременно идёт только одна работа, порядок вызовов сохраняется", async () => {
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const work = (n: number) => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 15));
      order.push(n);
      running--;
      return n;
    };
    const results = await Promise.all([1, 2, 3].map((n) => runInOverlaySlot(work(n))));
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(peak).toBe(1);
  });

  it("отказ предыдущей работы не рвёт очередь", async () => {
    const failed = runInOverlaySlot(async () => {
      throw new Error("ffmpeg упал");
    });
    const next = runInOverlaySlot(async () => "дальше");
    await expect(failed).rejects.toThrow("ffmpeg упал");
    await expect(next).resolves.toBe("дальше");
  });
});
