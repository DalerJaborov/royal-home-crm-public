import { describe, expect, it } from "vitest";
import { consultantStationMode, failoverDiffers, internalExtensionDigits } from "../src/lib/telephony/failoverSync.js";

/**
 * Сверка настроек непринятого звонка при восстановлении связи со станцией.
 *
 * Зачем тест на сравнение: от него зависит, будет ли CRM писать в станцию при
 * КАЖДОМ открытии подписки (а она открывается и штатно) или только когда
 * значения реально разошлись. Ошибка здесь — либо лишние записи в AstDB на
 * каждом переподключении, либо неприменённое правило, о котором никто не узнает.
 */
const BASE = {
  action: "both",
  seconds: 25,
  phone: "930001001",
  nightAction: "voicemail",
  nightStart: "21:00",
  nightEnd: "09:00",
  target: "",
  aiMode: "",
  aiSeconds: 30,
  aiDayStart: "09:30",
  aiDayEnd: "18:00",
};

describe("сверка правил непринятого звонка", () => {
  it("одинаковые настройки расхождением не считаются", () => {
    expect(failoverDiffers(BASE, { ...BASE })).toBe(false);
  });

  it("видит смену правила", () => {
    expect(failoverDiffers(BASE, { ...BASE, action: "none" })).toBe(true);
  });

  it("видит смену выдержки в секундах", () => {
    expect(failoverDiffers(BASE, { ...BASE, seconds: 20 })).toBe(true);
  });

  it("видит смену номера дежурного", () => {
    expect(failoverDiffers(BASE, { ...BASE, phone: "" })).toBe(true);
  });

  // Ночное правило станция теряет так же, как дневное: перезагрузка АТС чистит
  // её внутреннюю базу, и без этой проверки ночной автоответчик молча пропал бы.
  it("видит смену ночного правила и его границ", () => {
    expect(failoverDiffers(BASE, { ...BASE, nightAction: "none" })).toBe(true);
    expect(failoverDiffers(BASE, { ...BASE, nightStart: "22:00" })).toBe(true);
    expect(failoverDiffers(BASE, { ...BASE, nightEnd: "08:00" })).toBe(true);
  });

  // Перевод приёма на софтфон директора станция теряет так же, как остальные
  // значения: после перезагрузки АТС звонки молча вернулись бы операторам,
  // которых с приёма сняли, — и никто бы этого не заметил до первого звонка.
  it("видит перевод приёма на прямой аппарат", () => {
    expect(failoverDiffers(BASE, { ...BASE, target: "1021" })).toBe(true);
  });

  // Консультант на телефоне вместо автоответчика (24.09.2026): после перезагрузки
  // АТС звонки молча вернулись бы на автоответчик.
  it("видит смену режима консультанта, его ожидания и рабочих часов", () => {
    expect(failoverDiffers(BASE, { ...BASE, aiMode: "no_answer" })).toBe(true);
    expect(failoverDiffers(BASE, { ...BASE, aiSeconds: 20 })).toBe(true);
    expect(failoverDiffers(BASE, { ...BASE, aiDayStart: "10:00" })).toBe(true);
    expect(failoverDiffers(BASE, { ...BASE, aiDayEnd: "19:00" })).toBe(true);
  });
});

describe("режим консультанта для станции", () => {
  const on = { enabled: true, rtpHost: "10.9.0.1" };
  it("передаёт выбранный режим, когда живой голос включён", () => {
    expect(consultantStationMode({ ...on, mode: "no_answer" })).toBe("no_answer");
    expect(consultantStationMode({ ...on, mode: "always" })).toBe("always");
  });

  // Станция, позвавшая консультанта, которого нет, сначала продержала бы человека
  // на гудках, а потом всё равно ушла бы на автоответчик.
  it("пусто, если живой голос выключен, режим «не брать» или CRM не может поднять звук", () => {
    expect(consultantStationMode({ ...on, mode: "off" })).toBe("");
    expect(consultantStationMode({ ...on, enabled: false, mode: "always" })).toBe("");
    expect(consultantStationMode({ ...on, rtpHost: "", mode: "always" })).toBe("");
    expect(consultantStationMode({ ...on, mode: "что-то" })).toBe("");
  });
});

describe("внутренний номер для станции", () => {
  it("оставляет обычный внутренний номер", () => {
    expect(internalExtensionDigits("1021")).toBe("1021");
  });

  it("вычищает разделители, которые человек набирает по привычке", () => {
    expect(internalExtensionDigits(" 10-21 ")).toBe("1021");
  });

  // Значение подставляется в набор станции, поэтому «почти номер» отбрасывается
  // целиком: тишина в трубке безопаснее чужого выражения в диалплане.
  it("отбрасывает всё, что не похоже на внутренний номер", () => {
    expect(internalExtensionDigits("1021@from-internal")).toBe("");
    expect(internalExtensionDigits("")).toBe("");
    expect(internalExtensionDigits(null)).toBe("");
    expect(internalExtensionDigits("123456789")).toBe("");
  });
});
