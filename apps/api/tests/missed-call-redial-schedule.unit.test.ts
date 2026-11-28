import { describe, expect, it } from "vitest";
import {
  computeNextAttemptAt,
  judgeAttempt,
  parseRedialDelays,
  REDIAL_NO_CARD_SETTLE_MS,
  REDIAL_OUTCOME_WAIT_MS,
} from "../src/lib/telephony/missedCallRedial.js";

/**
 * Автоперезвон пропущенным (28.11.2026): чистые функции расписания и разбора исхода, без базы.
 * Время считается по Душанбе (UTC+5): 06:00Z это 11:00 в Душанбе.
 */

const START = "09:30";
const END = "18:00";
const at = (iso: string) => new Date(iso);

describe("parseRedialDelays", () => {
  it("читает «5,30,120» и пробелы", () => {
    expect(parseRedialDelays("5,30,120")).toEqual([5, 30, 120]);
    expect(parseRedialDelays(" 10 , 60 ")).toEqual([10, 60]);
  });
  it("мусор отбрасывается, пусто или всё мусор: умолчание", () => {
    expect(parseRedialDelays("5,abc,0,-3,30")).toEqual([5, 30]);
    expect(parseRedialDelays("")).toEqual([5, 30, 120]);
    expect(parseRedialDelays(null)).toEqual([5, 30, 120]);
    expect(parseRedialDelays("x,y")).toEqual([5, 30, 120]);
  });
  it("не больше пяти попыток", () => {
    expect(parseRedialDelays("1,2,3,4,5,6,7")).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("computeNextAttemptAt: когда следующая попытка", () => {
  it("днём в рабочее окно: просто плюс пауза", () => {
    expect(computeNextAttemptAt(at("2026-11-30T06:00:00Z"), 5, START, END)).toEqual(at("2026-11-30T06:05:00Z"));
  });
  it("пауза выпала после конца дня (18:25 в Душанбе): на начало следующего дня 09:30", () => {
    // 12:55Z = 17:55 в Душанбе, плюс 30 минут = 18:25: окно закрыто.
    expect(computeNextAttemptAt(at("2026-11-30T12:55:00Z"), 30, START, END)).toEqual(at("2026-12-01T04:30:00Z"));
  });
  it("ночной звонок (23:00 в Душанбе) сдвигается на утро 09:30", () => {
    expect(computeNextAttemptAt(at("2026-11-30T18:00:00Z"), 5, START, END)).toEqual(at("2026-12-01T04:30:00Z"));
  });
  it("раннее утро того же дня (04:00 в Душанбе): на 09:30 того же дня, а не завтра", () => {
    // 21:00Z Nov 30 = 02:00 Dec 1 в Душанбе, плюс 120 минут = 04:00.
    expect(computeNextAttemptAt(at("2026-11-30T21:00:00Z"), 120, START, END)).toEqual(at("2026-12-01T04:30:00Z"));
  });
  it("ровно на границе конца окна 18:00: уже вне окна", () => {
    // 12:55Z + 5 = 13:00Z = 18:00 в Душанбе.
    expect(computeNextAttemptAt(at("2026-11-30T12:55:00Z"), 5, START, END)).toEqual(at("2026-12-01T04:30:00Z"));
  });
  it("окно из настроек, а не зашитое: 08:00-20:00", () => {
    expect(computeNextAttemptAt(at("2026-11-30T12:55:00Z"), 30, "08:00", "20:00")).toEqual(at("2026-11-30T13:25:00Z"));
  });
});

describe("judgeAttempt: исход набранной попытки", () => {
  it("дозвонились: answered", () => {
    expect(judgeAttempt("TALKED", true, 1000)).toBe("answered");
  });
  it("клиент не ответил или отмена: no_answer", () => {
    for (const a of ["NO_ANSWER", "CANCELLED"]) expect(judgeAttempt(a, true, 1000)).toBe("no_answer");
  });
  it("дежурный не снял трубку: это не попытка клиента", () => {
    expect(judgeAttempt("AGENT_NO_PICKUP", true, 1000)).toBe("operator_no_pickup");
  });
  it("с карточкой итога нет: ждём до предела, потом неудача без итога", () => {
    expect(judgeAttempt(null, true, REDIAL_OUTCOME_WAIT_MS - 1)).toBeNull();
    expect(judgeAttempt(null, true, REDIAL_OUTCOME_WAIT_MS)).toBe("unknown");
  });
  it("без карточки итог не виден: недолго ждём и считаем неудачей", () => {
    expect(judgeAttempt(null, false, REDIAL_NO_CARD_SETTLE_MS - 1)).toBeNull();
    expect(judgeAttempt(null, false, REDIAL_NO_CARD_SETTLE_MS)).toBe("unknown");
  });
});
