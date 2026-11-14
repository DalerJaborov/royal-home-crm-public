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

// Аудит 14.11.2026: модель понимала эти просьбы, а прежний список из пяти фраз —
// нет; клиент повторял, сторож исходящих ставил паузу на 6 часов, заявка терялась.
describe("callback consent understands ordinary paraphrases (ru, tg, Latin, typos)", () => {
  it.each(["позвони мне", "Можете позвонить?", "Пусть позвонят", "Свяжитесь со мной", "zang zaned", "Zang zanen iltimos",
    "Ба ман занг занад", "Можете ли вы мне перезвонить завтра", "Жду звонка", "Хочу обратный звонок", "пазвоните мне пожалуйста",
    "перизвоните", "Занг зада метавонед?", "tamos gired", "Я вам написал, позвоните мне"])("requested: %s", text => {
    expect(customerCallbackConsentDecision(text)).toBe("requested");
  });
  it.each(["Мне никто не звонит", "Агент вчера звонил", "Я работаю оператором", "У меня оператор Билайн", "Спасибо, всё понятно",
    "Хорошо", "Да, конечно"])("not a request by itself: %s", text => {
    expect(customerCallbackConsentDecision(text)).toBe("none");
  });
  it.each(["Он написал: позвоните", "Она сказала, что позвоните завтра", "«Перезвоните мне»"])("reported or quoted call stays review: %s", text => {
    expect(customerCallbackConsentDecision(text)).toBe("needs_review");
  });
  it.each(["Не пазвоните", "zang nazaned", "Занг накунед лутфан"])("typo/Latin refusal is never a request: %s", text => {
    expect(customerCallbackConsentDecision(text)).not.toBe("requested");
  });
});
