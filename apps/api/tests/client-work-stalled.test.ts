import { describe, expect, it } from "vitest";
import { isAlarmDayOff, workingDaysBetween, addAlarmWorkingDays } from "../src/lib/alarmCalendar.js";
import {
  evaluateWorkStalled,
  STALLED_WORKING_DAYS,
} from "../src/lib/clientWorkStalled.js";

/**
 * Фундамент контроля без всплывающих окон (владелец 08.09.2026):
 * «агент звонит, клиент не берёт трубку» — это НЕ тишина, это работа.
 * Тишина — когда агент сам перестал пытаться.
 *
 * Даты в тестах — по Душанбе (UTC+5), поэтому берём полдень: сдвиг пояса не
 * перебрасывает момент на соседние сутки, и тест не зависит от того, где он
 * запущен.
 */

/** Полдень указанной даты по Душанбе, выраженный в UTC. */
function dushanbeNoon(iso: string): Date {
  return new Date(`${iso}T07:00:00.000Z`); // 12:00 по Душанбе
}

// 2026-09-06 — воскресенье, 2026-09-07 — понедельник, 2026-09-12 — суббота.
const SUNDAY = dushanbeNoon("2026-09-06");
const MONDAY = dushanbeNoon("2026-09-07");
const SATURDAY = dushanbeNoon("2026-09-12");

/**
 * С 11.10.2026 выходные — из Настроек (владелец: «у нас нет никаких выходных»). По
 * умолчанию календарь пустой; прежнее правило «воскресенье — общий выходной» — это
 * теперь `companyDaysOff: [0]`, и проверки ниже держат его поведение побайтно.
 */
const SUNDAY_OFF = { companyDaysOff: [0] };

describe("Календарь тревог: по умолчанию выходных нет", () => {
  it("пустой календарь — воскресенье рабочий день", () => {
    expect(isAlarmDayOff(SUNDAY)).toBe(false);
    expect(isAlarmDayOff(SUNDAY, { companyDaysOff: [], agentDaysOff: [] })).toBe(false);
    // Пятница → понедельник: трое суток, все рабочие.
    expect(workingDaysBetween(dushanbeNoon("2026-09-11"), dushanbeNoon("2026-09-14"))).toBe(3);
    // Суббота + 1 рабочий день = воскресенье: выходных нет.
    expect(addAlarmWorkingDays(SATURDAY, 1).toISOString()).toBe(dushanbeNoon("2026-09-13").toISOString());
  });

  it("личный выходной агента в среду — среда не в счёт, у соседа — в счёт", () => {
    const wednesdayOff = { companyDaysOff: [], agentDaysOff: [3] };
    // Вторник → четверг (2026-09-08 → 2026-09-10): сутки, кончающиеся в среду, не идут.
    expect(workingDaysBetween(dushanbeNoon("2026-09-08"), dushanbeNoon("2026-09-10"), wednesdayOff)).toBe(1);
    expect(workingDaysBetween(dushanbeNoon("2026-09-08"), dushanbeNoon("2026-09-10"))).toBe(2);
  });
});

describe("Календарь тревог: общий выходной в воскресенье (companyDaysOff: [0]) — как раньше", () => {
  it("воскресенье — выходной, суббота и понедельник — рабочие", () => {
    expect(isAlarmDayOff(SUNDAY, SUNDAY_OFF)).toBe(true);
    expect(isAlarmDayOff(SATURDAY, SUNDAY_OFF)).toBe(false);
    expect(isAlarmDayOff(MONDAY, SUNDAY_OFF)).toBe(false);
  });

  /**
   * Главное, ради чего календарь заведён отдельно от lib/businessDays.ts (там
   * выходными считаются И суббота, И воскресенье, и по нему живёт резерв сделки).
   * Агентство работает по субботам, и пятница-суббота не должны складываться в
   * «два дня тишины» при одном реально пропущенном.
   */
  it("суббота идёт в счёт рабочих дней, воскресенье — нет", () => {
    // Пятница полдень → воскресенье полдень: пройдены пятница→суббота (рабочие
    // сутки) и суббота→воскресенье (воскресные, не в счёт).
    const friday = dushanbeNoon("2026-09-11");
    expect(workingDaysBetween(friday, dushanbeNoon("2026-09-13"), SUNDAY_OFF)).toBe(1);
    // До понедельника — плюс воскресенье→понедельник, снова рабочие сутки.
    expect(workingDaysBetween(friday, dushanbeNoon("2026-09-14"), SUNDAY_OFF)).toBe(2);
  });

  it("addAlarmWorkingDays перепрыгивает воскресенье", () => {
    // Суббота + 1 рабочий день = понедельник (воскресенье пропущено).
    const next = addAlarmWorkingDays(SATURDAY, 1, SUNDAY_OFF);
    expect(next.toISOString()).toBe(dushanbeNoon("2026-09-14").toISOString());
  });

  it("отрицательный и нулевой интервал не ломают счёт", () => {
    expect(workingDaysBetween(MONDAY, MONDAY)).toBe(0);
    expect(workingDaysBetween(SATURDAY, MONDAY.getTime() > SATURDAY.getTime() ? MONDAY : SATURDAY)).toBeGreaterThanOrEqual(0);
    expect(workingDaysBetween(dushanbeNoon("2026-09-14"), dushanbeNoon("2026-09-07"))).toBe(0);
  });
});

describe("«Работа встала» — признак, а не обвинение", () => {
  const since = dushanbeNoon("2026-09-07"); // понедельник, лид принят

  it("агент только что звонил — тишины нет", () => {
    const v = evaluateWorkStalled(
      { lastAgentAttemptAt: dushanbeNoon("2026-09-10"), lastClientMessageAt: null, since },
      dushanbeNoon("2026-09-11")
    );
    expect(v.stalled).toBe(false);
    expect(v.workingDaysSince).toBe(1);
  });

  /**
   * САМОЕ ВАЖНОЕ ПРАВИЛО ВСЕЙ СХЕМЫ. Клиент молчит неделю, а агент звонит — это
   * работа, и руководителя она не касается. Не отличить это от увода значит
   * обвинять человека ровно за то, в чём он не виноват.
   */
  it("клиент молчит, но агент звонит — это работа, не тишина", () => {
    const v = evaluateWorkStalled(
      {
        lastAgentAttemptAt: dushanbeNoon("2026-09-14"), // агент пытался вчера
        lastClientMessageAt: dushanbeNoon("2026-09-07"), // клиент молчит неделю
        since,
      },
      dushanbeNoon("2026-09-15")
    );
    expect(v.stalled).toBe(false);
  });

  it("агент перестал пытаться — через 3 рабочих дня это тишина", () => {
    const v = evaluateWorkStalled(
      { lastAgentAttemptAt: dushanbeNoon("2026-09-07"), lastClientMessageAt: null, since },
      dushanbeNoon("2026-09-11") // пн → чт: вт, ср, чт = 3 рабочих дня
    );
    expect(v.stalled).toBe(true);
    expect(v.thresholdDays).toBe(STALLED_WORKING_DAYS);
  });

  it("общий выходной (воскресенье в Настройках) не приближает тревогу", () => {
    // Пятница → понедельник: суббота и понедельник рабочие, воскресенье нет.
    const v = evaluateWorkStalled(
      { lastAgentAttemptAt: dushanbeNoon("2026-09-11"), lastClientMessageAt: null, since, calendar: SUNDAY_OFF },
      dushanbeNoon("2026-09-14")
    );
    expect(v.workingDaysSince).toBe(2);
    expect(v.stalled).toBe(false);
  });

  it("по умолчанию выходных нет: пятница → понедельник — три рабочих дня, тревога", () => {
    const v = evaluateWorkStalled(
      { lastAgentAttemptAt: dushanbeNoon("2026-09-11"), lastClientMessageAt: null, since },
      dushanbeNoon("2026-09-14")
    );
    expect(v.workingDaysSince).toBe(3);
    expect(v.stalled).toBe(true);
  });

  it("личный выходной агента (суббота) не приближает тревогу ЭТОГО агента", () => {
    const v = evaluateWorkStalled(
      {
        lastAgentAttemptAt: dushanbeNoon("2026-09-11"),
        lastClientMessageAt: null,
        since,
        calendar: { companyDaysOff: [], agentDaysOff: [6] },
      },
      dushanbeNoon("2026-09-14")
    );
    expect(v.workingDaysSince).toBe(2);
    expect(v.stalled).toBe(false);
  });

  it("ответ клиента продлевает отсчёт: разговор идёт", () => {
    const v = evaluateWorkStalled(
      {
        lastAgentAttemptAt: dushanbeNoon("2026-09-07"),
        lastClientMessageAt: dushanbeNoon("2026-09-14"), // клиент ответил вчера
        since,
      },
      dushanbeNoon("2026-09-15")
    );
    expect(v.stalled).toBe(false);
  });

  /**
   * Планка здесь ОДНА — три рабочих дня. Укороченная «два дня, если засветился
   * номер» отсюда убрана 09.09.2026: она опиралась на поле, которое никто не
   * заполнял, и дублировала lib/agentOffCrmAlarm.ts, где то же правило написано
   * полнее (с ИИ-проверкой, не объяснил ли паузу сам клиент).
   */
  it("планка одна — три рабочих дня, укороченной больше нет", () => {
    const at = dushanbeNoon("2026-09-07");
    const twoDays = dushanbeNoon("2026-09-09");
    const threeDays = dushanbeNoon("2026-09-10");
    const input = { lastAgentAttemptAt: at, lastClientMessageAt: null, since };
    expect(evaluateWorkStalled(input, twoDays).stalled).toBe(false);
    const v = evaluateWorkStalled(input, threeDays);
    expect(v.stalled).toBe(true);
    expect(v.thresholdDays).toBe(STALLED_WORKING_DAYS);
  });

  /**
   * Только что назначенная карточка не должна выглядеть заброшенной: отсчитывать
   * тишину от сотворения мира нельзя, точка отсчёта — принятие лида.
   */
  it("попыток не было вовсе — считаем от принятия лида, а не от начала времён", () => {
    const fresh = evaluateWorkStalled(
      { lastAgentAttemptAt: null, lastClientMessageAt: null, since: dushanbeNoon("2026-09-14") },
      dushanbeNoon("2026-09-15")
    );
    expect(fresh.stalled).toBe(false);
    expect(fresh.lastAttemptAt).toBeNull();

    const old = evaluateWorkStalled(
      { lastAgentAttemptAt: null, lastClientMessageAt: null, since: dushanbeNoon("2026-09-07") },
      dushanbeNoon("2026-09-11")
    );
    expect(old.stalled).toBe(true);
  });
});
