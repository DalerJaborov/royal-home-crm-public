import { describe, expect, it } from "vitest";
import { interactionCreateSchema } from "@royal-home/shared";

/**
 * «Ждёт показ» без даты и времени раньше сохранялся в базу, но ничего не
 * запускал — ни календаря, ни напоминания за 2 часа/40 минут (спецификация,
 * «Путь покупателя»). Дата+время теперь обязательны для этого исхода —
 * только для него: WAITING_CALL/WAITING_OPTIONS такой привязки не требуют.
 */

const base = { type: "CALL" as const, notes: "Звонок" };

describe("WAITING_SHOWING требует nextActionDate", () => {
  it("без даты — отклоняется", () => {
    const res = interactionCreateSchema.safeParse({ ...base, outcome: "WAITING_SHOWING" });
    expect(res.success).toBe(false);
  });

  it("с датой — принимается", () => {
    const res = interactionCreateSchema.safeParse({
      ...base,
      outcome: "WAITING_SHOWING",
      nextActionDate: new Date().toISOString(),
    });
    expect(res.success).toBe(true);
  });

  it("другие исходы дату не требуют", () => {
    for (const outcome of ["WAITING_CALL", "WAITING_OPTIONS", "NEGATIVE", "NO_ANSWER"] as const) {
      expect(interactionCreateSchema.safeParse({ ...base, outcome }).success).toBe(true);
    }
  });

  it("без исхода вовсе дата тоже не требуется", () => {
    expect(interactionCreateSchema.safeParse(base).success).toBe(true);
  });
});
