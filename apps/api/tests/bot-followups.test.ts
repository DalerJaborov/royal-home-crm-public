import { describe, expect, it } from "vitest";
import {
  followUpDueAt,
  isClosingMessage,
  isFollowUpDue,
  isOptOutMessage,
  shiftIntoWindow,
  MAX_FOLLOW_UPS,
} from "../src/lib/botFollowUps.js";

/**
 * Напоминания молчащему клиенту. Два правила важнее всех остальных:
 * вся цепочка обязана уместиться в сутки (позже Meta не доставит сообщение),
 * и ни одно письмо не должно уйти ночью.
 */

const WINDOW = { start: "08:00", end: "20:00" };
/** Полдень по Душанбе (UTC+5) — 07:00 UTC. */
const noon = (day = 1) => new Date(Date.UTC(2026, 6, day, 7, 0, 0));
const CONV = "conv-12345";

describe("shiftIntoWindow — ночью не пишем", () => {
  it("внутри окна ничего не двигает", () => {
    const at = noon();
    expect(shiftIntoWindow(at, WINDOW).getTime()).toBe(at.getTime());
  });

  it("раннее утро переносит на 08:00 того же дня", () => {
    // 06:20 по Душанбе = 01:20 UTC
    const early = new Date(Date.UTC(2026, 6, 1, 1, 20));
    const shifted = shiftIntoWindow(early, WINDOW);
    expect(shifted.toISOString()).toBe("2026-07-01T03:00:00.000Z"); // 08:00 Душанбе
  });

  it("поздний вечер переносит на утро следующего дня", () => {
    // 20:30 по Душанбе = 15:30 UTC
    const late = new Date(Date.UTC(2026, 6, 1, 15, 30));
    const shifted = shiftIntoWindow(late, WINDOW);
    expect(shifted.toISOString()).toBe("2026-07-02T03:00:00.000Z");
  });

  it("полночь — это следующее утро, а не текущее", () => {
    // 00:30 по Душанбе = 19:30 UTC предыдущего дня
    const midnight = new Date(Date.UTC(2026, 6, 1, 19, 30));
    expect(shiftIntoWindow(midnight, WINDOW).toISOString()).toBe("2026-07-02T03:00:00.000Z");
  });
});

describe("followUpDueAt — расписание трёх попыток", () => {
  it("первая — примерно через час", () => {
    const due = followUpDueAt(CONV, noon(), 1, WINDOW)!;
    expect(due.getTime() - noon().getTime()).toBe(60 * 60 * 1000);
  });

  it("попытки идут строго по возрастанию", () => {
    const first = followUpDueAt(CONV, noon(), 1, WINDOW)!;
    const second = followUpDueAt(CONV, noon(), 2, WINDOW)!;
    const third = followUpDueAt(CONV, noon(), 3, WINDOW)!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(third.getTime()).toBeGreaterThan(second.getTime());
  });

  it("вся цепочка укладывается в сутки — иначе Meta не доставит", () => {
    for (let attempt = 1; attempt <= MAX_FOLLOW_UPS; attempt++) {
      const due = followUpDueAt(CONV, noon(), attempt, WINDOW);
      if (due === null) continue;
      expect(due.getTime() - noon().getTime()).toBeLessThanOrEqual(23 * 60 * 60 * 1000);
    }
  });

  it("ни одна попытка не попадает в ночь", () => {
    for (const day of [1, 2, 3]) {
      for (let hour = 0; hour < 24; hour++) {
        const lastMessage = new Date(Date.UTC(2026, 6, day, hour, 0));
        for (let attempt = 1; attempt <= MAX_FOLLOW_UPS; attempt++) {
          const due = followUpDueAt(CONV, lastMessage, attempt, WINDOW);
          if (!due) continue;
          const wallHour = new Date(due.getTime() + 5 * 60 * 60 * 1000).getUTCHours();
          expect(wallHour).toBeGreaterThanOrEqual(8);
          expect(wallHour).toBeLessThan(20);
        }
      }
    }
  });

  it("расписание одинаково при каждом запуске: разброс из id диалога", () => {
    const a = followUpDueAt(CONV, noon(), 2, WINDOW)!;
    const b = followUpDueAt(CONV, noon(), 2, WINDOW)!;
    expect(a.getTime()).toBe(b.getTime());
  });

  it("у разных диалогов время попыток не совпадает точь-в-точь", () => {
    // Вторая попытка приходится на вечер и остаётся внутри окна — разброс виден.
    // У третьей он часто «съедается» переносом на утро, и это правильно: лучше
    // одинаковые 08:00, чем письмо в ночи.
    const a = followUpDueAt("conv-aaa", noon(), 2, WINDOW)!;
    const b = followUpDueAt("conv-zzz", noon(), 2, WINDOW)!;
    expect(a.getTime()).not.toBe(b.getTime());
  });

  it("четвёртой попытки не существует", () => {
    expect(followUpDueAt(CONV, noon(), 4, WINDOW)).toBeNull();
  });
});

describe("isFollowUpDue — пора ли писать", () => {
  it("через полчаса ещё рано", () => {
    const now = new Date(noon().getTime() + 30 * 60 * 1000);
    expect(isFollowUpDue(CONV, noon(), 0, WINDOW, now)).toBe(false);
  });

  it("через полтора часа первая попытка созрела", () => {
    const now = new Date(noon().getTime() + 90 * 60 * 1000);
    expect(isFollowUpDue(CONV, noon(), 0, WINDOW, now)).toBe(true);
  });

  /**
   * АУДИТ CODEX 04.10.2026, CHANNEL-NEW-01: due уже сдвинут в окно, но на момент
   * ИСПОЛНЕНИЯ окно не проверялось: тик, восстановившийся после конца окна, слал
   * инициативное сообщение ночью, пока сутки Meta ещё открыты.
   */
  it("созрело в окне, но тик пришёл после его конца (22:10 Душанбе) — ночью не пишем", () => {
    const last = new Date(Date.UTC(2026, 6, 1, 13, 0)); // 18:00 Душанбе, первая попытка через час = 19:00
    const lateTick = new Date(Date.UTC(2026, 6, 1, 17, 10)); // 22:10 Душанбе
    expect(isFollowUpDue(CONV, last, 0, WINDOW, lateTick)).toBe(false);
  });

  it("тот же диалог в 19:30 — внутри окна, пишем", () => {
    const last = new Date(Date.UTC(2026, 6, 1, 13, 0));
    const tick = new Date(Date.UTC(2026, 6, 1, 14, 30)); // 19:30 Душанбе
    expect(isFollowUpDue(CONV, last, 0, WINDOW, tick)).toBe(true);
  });

  it("после трёх попыток бот замолкает навсегда", () => {
    const now = new Date(noon().getTime() + 30 * 60 * 60 * 1000);
    expect(isFollowUpDue(CONV, noon(), MAX_FOLLOW_UPS, WINDOW, now)).toBe(false);
  });
});

describe("isOptOutMessage — просьба не писать", () => {
  it("узнаёт отказ по-русски", () => {
    expect(isOptOutMessage("не пишите мне больше")).toBe(true);
    expect(isOptOutMessage("отстаньте")).toBe(true);
    expect(isOptOutMessage("удалите мой номер")).toBe(true);
  });

  it("узнаёт отказ по-таджикски и латиницей", () => {
    expect(isOptOutMessage("лозим нест")).toBe(true);
    expect(isOptOutMessage("бас")).toBe(true);
    expect(isOptOutMessage("STOP")).toBe(true);
  });

  it("обычный разговор отказом не считает", () => {
    expect(isOptOutMessage("салом, хона даркор")).toBe(false);
    expect(isOptOutMessage("напишите мне цену")).toBe(false);
    expect(isOptOutMessage("не понял, повторите")).toBe(false);
  });

  /**
   * Обратная ошибка, дороже пропущенного отказа: принять за «отстаньте» просьбу
   * ОТВЕТИТЬ. Тогда бот замолкает навсегда, а в разборе потерянных диалогов человек
   * числится как «просил не писать» — ровно наоборот к тому, что он сказал.
   */
  it("жалобу и просьбу ответить за отказ не принимает", () => {
    expect(isOptOutMessage("почему мне никто не пишет?")).toBe(false);
    expect(isOptOutMessage("агент не пишет уже второй день")).toBe(false);
    expect(isOptOutMessage("отпишите, пожалуйста, цену")).toBe(false);
  });

  // Ревизия бота 02.10.2026: вежливость и слова о предмете — не отказ.
  it("«не беспокойтесь» и «лозим нест» внутри фразы — не отказ", () => {
    expect(isOptOutMessage("Не беспокойтесь, я подожду")).toBe(false);
    expect(isOptOutMessage("Ипотека лозим нест, нақд мехарам")).toBe(false);
    expect(isOptOutMessage("больше не надо двушку, теперь ищу трёшку")).toBe(false);
    expect(isOptOutMessage("не беспокойте меня")).toBe(true);
    expect(isOptOutMessage("больше не надо")).toBe(true);
  });
});

describe("isClosingMessage — клиент сам закрыл разговор благодарностью", () => {
  it("узнаёт закрытие по-русски и по-таджикски", () => {
    expect(isClosingMessage("Да все хорошо спасибо")).toBe(true);
    expect(isClosingMessage("Спасибо!")).toBe(true);
    expect(isClosingMessage("Ташаккур")).toBe(true);
    expect(isClosingMessage("благодарю")).toBe(true);
  });

  it("благодарность с вопросом — не закрытие, ответ всё ещё нужен", () => {
    expect(isClosingMessage("спасибо, а сколько стоит?")).toBe(false);
  });

  it("обычное «хорошо»/«ок» без благодарности закрытием не считает", () => {
    expect(isClosingMessage("хорошо")).toBe(false);
    expect(isClosingMessage("ок")).toBe(false);
    expect(isClosingMessage("салом, хона даркор")).toBe(false);
  });
});
