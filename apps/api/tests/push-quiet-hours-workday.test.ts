import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { handledByQuietHours } from "../src/push.js";
import { quietDecision } from "../src/lib/pushQuietHours.js";
import { staleLeadCircleOpen } from "../src/services/leads/reassignment.js";
import { dushanbeInputToDate } from "../src/lib/dushanbeTime.js";

/**
 * РАБОЧИЙ ДЕНЬ СИЛЬНЕЕ ТИШИНЫ (14.11.2026, аудит скрытых механизмов №3).
 *
 * На проде раздача лидов шла до 22:30, а тишина пушей начиналась в 21:00: пуш о
 * новом лиде в 21:00–22:30 выбрасывался, а круг через 15 минут молча передавал
 * лид следующему (29 лидов за 30 дней). Здесь проверяется главное свойство:
 * пока круг «не принял за N минут» открыт, пуш о лиде НЕ подавляется; подавлен —
 * круг стоит. Оба окна читают одну функцию (lib/workingHours.ts).
 */

const at = (hhmm: string, date = "2026-11-14") => dushanbeInputToDate(date, hhmm);
let saved: { workHoursStart: string | null; workHoursEnd: string | null } | null = null;

async function setWorkHours(start: string, end: string) {
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { workHoursStart: start, workHoursEnd: end },
    create: { id: "singleton", workHoursStart: start, workHoursEnd: end },
  });
}

beforeAll(async () => {
  process.env.PUSH_QUIET_HOURS = "on";
  saved = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true } });
});

afterAll(async () => {
  process.env.PUSH_QUIET_HOURS = "off";
  if (saved) await setWorkHours(saved.workHoursStart ?? "09:30", saved.workHoursEnd ?? "18:00");
  await prisma.backgroundJob.deleteMany({ where: { type: "deferred-push", dedupeKey: { contains: "workday-test-" } } });
});

describe("quietDecision: открытый рабочий день снимает тишину", () => {
  it("ночью при открытом рабочем дне лид и сообщение уходят сразу", () => {
    expect(quietDecision({ kind: "lead" }, at("21:30"), true)).toBe("send");
    expect(quietDecision({ kind: "message" }, at("21:30"), true)).toBe("send");
  });
  it("вне рабочего дня — прежнее правило: лид отбрасывается, сообщение откладывается", () => {
    expect(quietDecision({ kind: "lead" }, at("23:00"), false)).toBe("drop");
    expect(quietDecision({ kind: "message" }, at("23:00"), false)).toBe("defer");
  });
});

describe("Транспорт по часам раздачи из Настроек (как на проде: 10:00–22:30)", () => {
  it("21:30 — раздача идёт: пуш о лиде не подавлен", async () => {
    await setWorkHours("10:00", "22:30");
    expect(await handledByQuietHours(["x"], { kind: "lead", title: "t", body: "b", tag: "workday-test-a" }, at("21:30"))).toBe(false);
  });
  it("23:00 — раздача закрыта: пуш о лиде подавлен", async () => {
    await setWorkHours("10:00", "22:30");
    expect(await handledByQuietHours(["x"], { kind: "lead", title: "t", body: "b", tag: "workday-test-b" }, at("23:00"))).toBe(true);
  });

  it("за сутки шагом 5 минут: где круг передачи открыт, пуш о лиде не подавляется ни разу", async () => {
    for (const [start, end] of [
      ["10:00", "22:30"],
      ["09:30", "18:00"],
      ["07:00", "23:30"],
    ] as const) {
      await setWorkHours(start, end);
      for (let minute = 0; minute < 24 * 60; minute += 5) {
        const hhmm = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
        const now = at(hhmm);
        const circleOpen = await staleLeadCircleOpen(now);
        const suppressed = await handledByQuietHours(["x"], { kind: "lead", title: "t", body: "b" }, now);
        // Подавлен пуш — круг обязан стоять; круг идёт — пуш обязан уйти.
        if (circleOpen) expect({ window: `${start}–${end}`, hhmm, suppressed }).toEqual({ window: `${start}–${end}`, hhmm, suppressed: false });
        if (suppressed) expect({ window: `${start}–${end}`, hhmm, circleOpen }).toEqual({ window: `${start}–${end}`, hhmm, circleOpen: false });
      }
    }
  });
});
