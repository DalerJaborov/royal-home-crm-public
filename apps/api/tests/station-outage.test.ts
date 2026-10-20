import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { loadWorkWindow, outageOverlapMs, outagesBetween, workingOutageMs } from "../src/lib/stationOutage.js";
import { evaluateWorkStalled } from "../src/lib/clientWorkStalled.js";

/**
 * ПРОСТОЙ ТЕЛЕФОНИИ НЕ ДОЛЖЕН ВЫГЛЯДЕТЬ КАК ЛЕНЬ АГЕНТОВ (дыра 4.2,
 * docs/karta-resheniy-i-dyr-09-09-2026.md).
 *
 * Счётчик тишины считает попытки агента по доказанным следам, и главный след —
 * звонок через АТС. Станция лежит день: следов нет ни у кого, и наутро владелец
 * получает тревогу сразу по ВСЕМ агентам, которые работали как обычно.
 *
 * Тесты держат три границы, на которых поправка может соврать в обе стороны:
 * ночной простой не дарит отсрочку, воскресный тоже, а незакрытый простой
 * (станция лежит прямо сейчас) считается идущим до текущего момента.
 */

const WINDOW = { start: "09:30", end: "18:00" };
const HOUR = 3_600_000;

/**
 * Момент «HH:MM по Душанбе» указанной даты, как UTC.
 *
 * Считаем арифметикой над UTC, а не подстановкой часа в строку: для 00:00–04:59
 * подстановка даёт отрицательный час и невалидную дату, а невалидная дата в тесте
 * тихо превращает любую проверку в «ноль равен нулю».
 */
const DUSHANBE_OFFSET_MS = 5 * 3_600_000;
function dushanbe(dateISO: string, hhmm: string): Date {
  const [y, mo, d] = dateISO.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const at = new Date(Date.UTC(y, mo - 1, d, h, mi, 0) - DUSHANBE_OFFSET_MS);
  if (Number.isNaN(at.getTime())) throw new Error(`плохая дата в тесте: ${dateISO} ${hhmm}`);
  return at;
}

describe("outageOverlapMs — простой по часам, для коротких сроков (23.09.2026)", () => {
  const t = (hhmm: string) => dushanbe("2026-09-23", hhmm);

  it("простой 11:57–13:06 внутри окна считается целиком", () => {
    const ms = outageOverlapMs(t("11:50"), t("13:30"), [{ startedAt: t("11:57"), endedAt: t("13:06") }]);
    expect(ms).toBe(69 * 60_000);
  });

  it("режется по краям окна, незакрытый идёт до конца окна", () => {
    const ms = outageOverlapMs(t("12:00"), t("12:30"), [
      { startedAt: t("11:00"), endedAt: t("12:10") },
      { startedAt: t("12:20"), endedAt: null },
    ]);
    expect(ms).toBe(20 * 60_000);
  });

  it("простой вне окна не считается", () => {
    expect(outageOverlapMs(t("12:00"), t("12:30"), [{ startedAt: t("10:00"), endedAt: t("11:00") }])).toBe(0);
  });
});

describe("Рабочие часы простоя станции", () => {
  it("простой целиком внутри рабочего дня считается весь", () => {
    // Вторник, 10:00–13:00 по Душанбе.
    const from = dushanbe("2026-09-01", "09:30");
    const to = dushanbe("2026-09-01", "18:00");
    const ms = workingOutageMs(
      from,
      to,
      [{ startedAt: dushanbe("2026-09-01", "10:00"), endedAt: dushanbe("2026-09-01", "13:00") }],
      WINDOW
    );
    expect(ms).toBe(3 * HOUR);
  });

  it("НОЧНОЙ простой не засчитывается вовсе", () => {
    // Ночью звонить всё равно некуда — зачесть значило бы подарить отсрочку
    // и тому, кто правда забросил клиента.
    const ms = workingOutageMs(
      dushanbe("2026-09-01", "00:00"),
      dushanbe("2026-09-02", "00:00"),
      [{ startedAt: dushanbe("2026-09-01", "01:00"), endedAt: dushanbe("2026-09-01", "05:00") }],
      WINDOW
    );
    expect(ms).toBe(0);
  });

  it("простой на границе дня режется по рабочему окну", () => {
    // 17:00–20:00: рабочими являются только 17:00–18:00.
    const ms = workingOutageMs(
      dushanbe("2026-09-01", "00:00"),
      dushanbe("2026-09-02", "00:00"),
      [{ startedAt: dushanbe("2026-09-01", "17:00"), endedAt: dushanbe("2026-09-01", "20:00") }],
      WINDOW
    );
    expect(ms).toBe(HOUR);
  });

  it("простой в ВЫХОДНОЙ (воскресенье в Настройках) не засчитывается: выходной и так не в счёт", () => {
    // 06.09.2026 — воскресенье. Двойной зачёт сделал бы поправку щедрее правила.
    const ms = workingOutageMs(
      dushanbe("2026-09-06", "00:00"),
      dushanbe("2026-09-07", "00:00"),
      [{ startedAt: dushanbe("2026-09-06", "10:00"), endedAt: dushanbe("2026-09-06", "16:00") }],
      WINDOW,
      { companyDaysOff: [0] }
    );
    expect(ms).toBe(0);
  });

  it("по умолчанию выходных нет (11.10.2026): воскресный простой в рабочие часы засчитывается", () => {
    const ms = workingOutageMs(
      dushanbe("2026-09-06", "00:00"),
      dushanbe("2026-09-07", "00:00"),
      [{ startedAt: dushanbe("2026-09-06", "10:00"), endedAt: dushanbe("2026-09-06", "16:00") }],
      WINDOW
    );
    expect(ms).toBe(6 * HOUR);
  });

  it("незакрытый простой считается идущим до текущего момента", () => {
    // Станция может лежать прямо сейчас — ждать её возвращения, чтобы перестать
    // обвинять агентов, поздно.
    const ms = workingOutageMs(
      dushanbe("2026-09-01", "09:30"),
      dushanbe("2026-09-01", "12:30"),
      [{ startedAt: dushanbe("2026-09-01", "10:30"), endedAt: null }],
      WINDOW
    );
    expect(ms).toBe(2 * HOUR);
  });

  it("простоев нет — поправки нет", () => {
    expect(workingOutageMs(dushanbe("2026-09-01", "09:30"), dushanbe("2026-09-01", "18:00"), [], WINDOW)).toBe(0);
  });
});

describe("«Работа встала» с поправкой на простой", () => {
  const since = dushanbe("2026-09-01", "09:30"); // вторник
  const now = dushanbe("2026-09-04", "10:00"); // пятница, три рабочих дня спустя

  it("без простоя три рабочих дня тишины — сигнал", () => {
    const v = evaluateWorkStalled({ lastAgentAttemptAt: null, lastClientMessageAt: null, since }, now);
    expect(v.workingDaysSince).toBeGreaterThanOrEqual(3);
    expect(v.stalled).toBe(true);
  });

  it("сутки простоя отодвигают сигнал на сутки, а не отменяют его", () => {
    const v = evaluateWorkStalled(
      { lastAgentAttemptAt: null, lastClientMessageAt: null, since, outageMs: 24 * HOUR },
      now
    );
    expect(v.stalled).toBe(false);

    // Ещё сутки прошли — сигнал всё равно приходит. Простой стоит отсрочки,
    // а не прощения накопленной тишины.
    const later = new Date(now.getTime() + 24 * HOUR);
    expect(
      evaluateWorkStalled({ lastAgentAttemptAt: null, lastClientMessageAt: null, since, outageMs: 24 * HOUR }, later)
        .stalled
    ).toBe(true);
  });
});

describe("Запись простоев в базе", () => {
  const ids: string[] = [];

  afterEach(async () => {
    if (ids.length === 0) return;
    await prisma.stationOutage.deleteMany({ where: { id: { in: ids } } });
    ids.length = 0;
  });

  it("outagesBetween отдаёт пересекающиеся окна, включая незакрытое", async () => {
    const base = new Date("2026-03-01T06:00:00.000Z");
    const before = await prisma.stationOutage.create({
      data: { startedAt: new Date(base.getTime() - 10 * HOUR), endedAt: new Date(base.getTime() - 9 * HOUR) },
    });
    const overlapping = await prisma.stationOutage.create({
      data: { startedAt: new Date(base.getTime() + HOUR), endedAt: new Date(base.getTime() + 2 * HOUR) },
    });
    const openOne = await prisma.stationOutage.create({
      data: { startedAt: new Date(base.getTime() + 3 * HOUR), endedAt: null },
    });
    ids.push(before.id, overlapping.id, openOne.id);

    const found = await outagesBetween(base, new Date(base.getTime() + 5 * HOUR));
    const starts = found.map((o) => o.startedAt.getTime());
    expect(starts).toContain(overlapping.startedAt.getTime());
    expect(starts).toContain(openOne.startedAt.getTime());
    expect(starts).not.toContain(before.startedAt.getTime());
  });

  it("рабочее окно читается из настроек и имеет разумный запасной вариант", async () => {
    const window = await loadWorkWindow();
    expect(window.start).toMatch(/^\d{2}:\d{2}$/);
    expect(window.end).toMatch(/^\d{2}:\d{2}$/);
  });
});
