import { describe, expect, it } from "vitest";
import { classifyInbound, isShieldSetPause } from "../src/lib/outboundShield.js";
import { composeCarriedInput, CARRIED_INPUT_MAX_CHARS } from "../src/lib/customerDeferredInput.js";

/** F03 / F12 pure rules (23.10.2026). DB behaviour is covered in outbound-shield.test.ts. */
const T = (minutes: number) => new Date(Date.UTC(2026, 9, 23, 10, minutes));

describe("lastInboundAt only moves forward", () => {
  it("applies the first inbound and any later one", () => {
    expect(classifyInbound({ lastInboundAt: null, lastInboundId: null }, "m1", T(0))).toBe("apply");
    expect(classifyInbound({ lastInboundAt: T(0), lastInboundId: "m1" }, "m2", T(5))).toBe("apply");
    expect(classifyInbound({ lastInboundAt: T(5), lastInboundId: "m2" }, "m3", T(5))).toBe("apply");
  });
  it("ignores a re-preparation of an older ticket: no clock rollback, no counter reset", () => {
    expect(classifyInbound({ lastInboundAt: T(5), lastInboundId: "m2" }, "m1", T(0))).toBe("stale");
  });
  it("treats the same provider id as already recorded", () => {
    expect(classifyInbound({ lastInboundAt: T(5), lastInboundId: "m2" }, "m2", T(5))).toBe("duplicate");
    expect(classifyInbound({ lastInboundAt: T(5), lastInboundId: "m2" }, "m2", T(9))).toBe("duplicate");
  });
});

describe("which pause a human message may lift", () => {
  it.each(["repeat", "monologue", "rate_hour", "rate_day"])("%s is the shield's own pause", reason => {
    expect(isShieldSetPause(reason)).toBe(true);
  });
  it.each([null, undefined, "", "own_account", "global_pulse", "staff", "manual"])("%s is not lifted by an inbound", reason => {
    expect(isShieldSetPause(reason)).toBe(false);
  });
});

describe("deferred inputs merge into one turn", () => {
  it("keeps chronological order and joins with a newline", () => {
    expect(composeCarriedInput(["Сколько стоит?", "[вложение: image]", "  ", "Какой этаж?"])).toBe("Сколько стоит?\n[вложение: image]\nКакой этаж?");
  });
  it("drops the OLDEST whole pieces when over the bound, never slices one", () => {
    const old = "а".repeat(60), mid = "б".repeat(60), last = "в".repeat(60);
    expect(composeCarriedInput([old, mid, last], 125)).toBe(`${mid}\n${last}`);
    expect(composeCarriedInput([old], 10)).toBe("");
  });
  it("is empty for nothing and bounded by default", () => {
    expect(composeCarriedInput([])).toBe("");
    expect(composeCarriedInput(Array.from({ length: 50 }, (_, i) => `вопрос номер ${i} про квартиру`)).length).toBeLessThanOrEqual(CARRIED_INPUT_MAX_CHARS);
  });
});
