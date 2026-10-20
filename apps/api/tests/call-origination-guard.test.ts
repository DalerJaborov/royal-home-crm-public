import { describe, expect, it } from "vitest";
import { beginOrigination, endOrigination } from "../src/lib/telephony/callTracker.js";

/**
 * Гонка двойного клика «Позвонить» (найдено ревью 19.08.2026): hasLiveCall
 * видит живой звонок только ПОСЛЕ trackCall, а между проверкой и записью в
 * originateCallToClient несколько await. beginOrigination — синхронная бронь
 * на это окно, тестируется отдельно от самого HTTP-роута: тут только контракт
 * «второй вызов для того же агента до endOrigination обязан отказать».
 */
describe("beginOrigination / endOrigination", () => {
  it("второй вызов для того же агента до endOrigination — отказывает", () => {
    const agentId = `agent-${Math.random()}`;
    expect(beginOrigination(agentId)).toBe(true);
    expect(beginOrigination(agentId)).toBe(false);
    endOrigination(agentId);
  });

  it("после endOrigination бронь снова доступна", () => {
    const agentId = `agent-${Math.random()}`;
    expect(beginOrigination(agentId)).toBe(true);
    endOrigination(agentId);
    expect(beginOrigination(agentId)).toBe(true);
    endOrigination(agentId);
  });

  it("разные агенты не мешают друг другу", () => {
    const a = `agent-${Math.random()}`;
    const b = `agent-${Math.random()}`;
    expect(beginOrigination(a)).toBe(true);
    expect(beginOrigination(b)).toBe(true);
    endOrigination(a);
    endOrigination(b);
  });

  it("endOrigination без предварительной брони — не бросает", () => {
    expect(() => endOrigination(`agent-${Math.random()}`)).not.toThrow();
  });
});
