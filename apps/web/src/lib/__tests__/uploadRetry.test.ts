import { describe, expect, it } from "vitest";
import { MAX_RETRY_ATTEMPTS, planServerRetry, retryDelayMs } from "../uploadRetry";
import * as queue from "../uploadQueue";

/**
 * Разбор 502 мастера 25.11.2026: IMG_0461.mov (45,7 МБ, 6 частей) и IMG_0452.mov
 * (55,5 МБ, 7 частей). Прокси обрывал часть на десятой секунде, телефон получал 502,
 * а части между отказами всё же уходили (2 → 3 → 4). Прежняя очередь мастера
 * считала каждый отказ и сдавалась на 6/6 через ~2 минуты, требуя «Повторить».
 */
describe("uploadRetry: одно расписание повторов загрузок", () => {
  it("паузы 5 с … 5 мин, потолок 10 попыток — те же, что у очереди карточки", () => {
    expect(retryDelayMs(1)).toBe(5_000);
    expect(retryDelayMs(4)).toBe(40_000);
    expect(retryDelayMs(MAX_RETRY_ATTEMPTS)).toBe(5 * 60_000);
    // Очередь карточки переизлучает тот же модуль, а не держит копию.
    expect(queue.retryDelayMs).toBe(retryDelayMs);
    expect(queue.MAX_RETRY_ATTEMPTS).toBe(MAX_RETRY_ATTEMPTS);
  });

  it("окно повторов перекрывает выкат с запасом (API недоступен ~12 с, замер 23.11)", () => {
    let waited = 0;
    for (let a = 1; a < MAX_RETRY_ATTEMPTS; a++) waited += retryDelayMs(a);
    expect(waited).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("отказ без продвижения копит попытки и в конце ждёт человека", () => {
    let attempts = 0;
    let plan = planServerRetry(attempts, false);
    for (let i = 1; i < MAX_RETRY_ATTEMPTS; i++) {
      expect(plan.delayMs).not.toBeNull();
      attempts = plan.attempts;
      plan = planServerRetry(attempts, false);
    }
    expect(plan.attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(plan.delayMs).toBeNull();
  });

  it("ролик, у которого части уходят через раз, не сдаётся: принятая часть обнуляет счёт", () => {
    // Последовательность IMG_0461 23.11: отказ, часть ушла и отказ, отказ, часть ушла и отказ…
    // Повторяем её с запасом — прежняя очередь сдалась бы на шестом отказе.
    const rounds = [false, true, false, false, true, false, false, true, false, true, false, false];
    let attempts = 0;
    for (const progressed of rounds) {
      const plan = planServerRetry(attempts, progressed);
      expect(plan.delayMs).not.toBeNull();
      attempts = plan.attempts;
    }
    expect(attempts).toBeLessThan(MAX_RETRY_ATTEMPTS);
  });
});
