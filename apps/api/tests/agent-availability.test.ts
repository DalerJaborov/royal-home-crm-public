import { describe, expect, it } from "vitest";
import { availabilityOf, canStartPause, pauseEndsAt, type PauseLimits } from "../src/lib/agentAvailability.js";

/**
 * «Не принимаю лиды» и экстренная заморозка.
 *
 * Два разных состояния, и их нельзя мерить одной меркой: пауза — просьба самого
 * агента, ограниченная по времени; заморозка — решение руководителя, бессрочное.
 * Свалив их в один флаг, мы получили бы либо агента, который сам себя
 * размораживает, либо решение руководителя, истекающее само через двое суток.
 */

const LIMITS: PauseLimits = { maxHours: 48, cooldownHours: 24 };
const NOW = new Date("2026-08-10T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const hoursAhead = (h: number) => new Date(NOW.getTime() + h * 3600_000);

describe("Кто получает лиды", () => {
  it("обычный агент доступен", () => {
    const state = availabilityOf({ leadsPausedUntil: null, frozenAt: null }, NOW);
    expect(state.available).toBe(true);
  });

  it("во время паузы — нет", () => {
    const state = availabilityOf({ leadsPausedUntil: hoursAhead(5), frozenAt: null }, NOW);
    expect(state.available).toBe(false);
    expect(state.pausedUntil).not.toBeNull();
  });

  /** Истёкшая пауза не требует уборки кроном: сравнение со временем и есть снятие. */
  it("истёкшая пауза больше не действует", () => {
    const state = availabilityOf({ leadsPausedUntil: hoursAgo(1), frozenAt: null }, NOW);
    expect(state.available).toBe(true);
  });

  it("замороженный недоступен независимо от паузы", () => {
    const state = availabilityOf({ leadsPausedUntil: null, frozenAt: hoursAgo(100) }, NOW);
    expect(state.available).toBe(false);
    expect(state.frozen).toBe(true);
  });
});

describe("Когда паузу можно включить", () => {
  it("впервые — можно", () => {
    const verdict = canStartPause({ leadsPausedUntil: null, leadsPausedEndedAt: null, frozenAt: null }, LIMITS, NOW);
    expect(verdict.allowed).toBe(true);
  });

  it("пока пауза идёт — нельзя включить вторую", () => {
    const verdict = canStartPause(
      { leadsPausedUntil: hoursAhead(3), leadsPausedEndedAt: null, frozenAt: null },
      LIMITS,
      NOW
    );
    expect(verdict.allowed).toBe(false);
  });

  /**
   * «Остыть» считается от КОНЦА прошлой паузы. Иначе агент с двухсуточной паузой
   * включал бы следующую в ту же минуту, как истекла предыдущая, и пауза стала бы
   * постоянным состоянием.
   */
  it("сразу после прошлой паузы — нельзя, сутки спустя — можно", () => {
    const tooEarly = canStartPause(
      { leadsPausedUntil: null, leadsPausedEndedAt: hoursAgo(2), frozenAt: null },
      LIMITS,
      NOW
    );
    expect(tooEarly.allowed).toBe(false);
    if (!tooEarly.allowed) expect(tooEarly.reason).toContain("24");

    const later = canStartPause(
      { leadsPausedUntil: null, leadsPausedEndedAt: hoursAgo(25), frozenAt: null },
      LIMITS,
      NOW
    );
    expect(later.allowed).toBe(true);
  });

  it("замороженный паузу не включает — у него другое состояние", () => {
    const verdict = canStartPause(
      { leadsPausedUntil: null, leadsPausedEndedAt: null, frozenAt: hoursAgo(1) },
      LIMITS,
      NOW
    );
    expect(verdict.allowed).toBe(false);
  });
});

describe("Длительность паузы ставит система", () => {
  it("запрошенное сверх потолка обрезается, а не отклоняется", () => {
    // Человек просит «на неделю» — получает максимум и видит, до какого момента.
    expect(pauseEndsAt(168, LIMITS, NOW).getTime()).toBe(hoursAhead(48).getTime());
  });

  it("разумный срок остаётся как есть", () => {
    expect(pauseEndsAt(6, LIMITS, NOW).getTime()).toBe(hoursAhead(6).getTime());
  });

  it("ноль и отрицательное не дают паузу «в прошлом»", () => {
    expect(pauseEndsAt(0, LIMITS, NOW).getTime()).toBe(hoursAhead(1).getTime());
    expect(pauseEndsAt(-5, LIMITS, NOW).getTime()).toBe(hoursAhead(1).getTime());
  });
});
