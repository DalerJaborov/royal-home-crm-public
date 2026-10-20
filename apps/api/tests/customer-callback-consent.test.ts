import { describe, expect, it } from "vitest";
import { customerCallbackConsentDecision } from "../src/lib/customerCallbackConsent.js";
describe("server callback consent distinguishes refusal from a reported/corrected call", () => {
  it.each(["Перезвоните мне", "Пожалуйста, позвоните завтра после обеда", "Занг занед", "Илтимос занг кунед", "Тамос гиред"])("explicit %s requests a call without claiming a schedule", text => {
    expect(customerCallbackConsentDecision(text)).toBe("requested");
  });
  it.each(["Не звоните мне", "Не надо мне звонить", "Пожалуйста, не звоните", "занг назанед", "Илтимос, занг накунед"])("direct %s cancels callback before the positive substring matcher", text => {
    expect(customerCallbackConsentDecision(text)).toBe("cancelled");
  });
  it.each(["Не звоните завтра, позвоните в пятницу", "Не звоните завтра", "Он сказал: не звоните мне", "Она сказала «позвоните»", "Ӯ гуфт: занг назанед", "Занг назанед пагоҳ, имрӯз занг занед"])("%s requires review rather than automatic whole-chat refusal or call", text => {
    expect(customerCallbackConsentDecision(text)).toBe("needs_review");
  });
  it.each(["+992 900 00 00 01", "900-000-001", "Мой номер: +992900000001", "Рақами ман: 900000001"])("%s is a phone candidate, not new consent/private proof", text => {
    expect(customerCallbackConsentDecision(text)).toBe("continue_phone");
  });
  it.each(["Не звонили мне", "Мне не позвонили", "Ты бот?", "Цена 900000", "Сколько стоит квартира?", "", "x".repeat(8001)] )("unrecognized wording never mints callback consent", text => {
    expect(customerCallbackConsentDecision(text)).toBe("none");
  });
});
