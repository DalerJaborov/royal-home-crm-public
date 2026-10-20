import { describe, expect, it } from "vitest";
import { consultantInboundState } from "../consultantInbound";

/**
 * Пометка «сейчас не действует» над правилами Телефонии должна говорить правду в
 * обе стороны (28.09.2026): консультант заменяет ночное правило и «если оператор
 * не ответил» только когда его реально можно позвать.
 */
describe("кто берёт входящий: консультант или правила Телефонии", () => {
  const ready = { rtpHostConfigured: true, stationDialplan: { ok: true } };

  it("консультант не выбран — правила действуют", () => {
    expect(consultantInboundState({ liveVoiceEnabled: true, liveVoiceInboundMode: "off", liveVoiceInbound: ready })).toBe("off");
    expect(consultantInboundState({ liveVoiceEnabled: false, liveVoiceInboundMode: "always" })).toBe("off");
    expect(consultantInboundState(undefined)).toBe("off");
  });

  it("выбран и готов — правила спят", () => {
    expect(consultantInboundState({ liveVoiceEnabled: true, liveVoiceInboundMode: "no_answer", liveVoiceInbound: ready })).toBe(
      "active"
    );
  });

  it("станцию ещё не проверяли — считаем, что консультант работает", () => {
    expect(
      consultantInboundState({
        liveVoiceEnabled: true,
        liveVoiceInboundMode: "always",
        liveVoiceInbound: { rtpHostConfigured: true, stationDialplan: null },
      })
    ).toBe("active");
  });

  it("нет адреса звука на сервере — правила по-прежнему действуют", () => {
    expect(
      consultantInboundState({
        liveVoiceEnabled: true,
        liveVoiceInboundMode: "no_answer",
        liveVoiceInbound: { rtpHostConfigured: false, stationDialplan: null },
      })
    ).toBe("blocked");
  });

  it("станция без ветки консультанта — правила по-прежнему действуют", () => {
    expect(
      consultantInboundState({
        liveVoiceEnabled: true,
        liveVoiceInboundMode: "no_answer",
        liveVoiceInbound: { rtpHostConfigured: true, stationDialplan: { ok: false } },
      })
    ).toBe("blocked");
  });
});
