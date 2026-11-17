import { describe, expect, it } from "vitest";
import { smsPartsEstimate } from "./MissedCallSetting";

describe("число частей СМС (кириллица: 70 знаков, в склейке по 67)", () => {
  it("считает по знакам, а не по байтам", () => {
    expect(smsPartsEstimate("")).toBe(0);
    expect(smsPartsEstimate("а".repeat(70))).toBe(1);
    expect(smsPartsEstimate("а".repeat(71))).toBe(2);
    expect(smsPartsEstimate("а".repeat(134))).toBe(2);
    expect(smsPartsEstimate("а".repeat(135))).toBe(3);
  });

  it("утверждённый текст: 159 знаков, 3 части", () => {
    const text = "Салом. Шумо занг задед, мо ҷавоб дода натавонистем. Ба WhatsApp нависед: https://wa.me/992777776001 Вы звонили, мы не успели ответить. Напишите нам в WhatsApp.";
    expect(Array.from(text).length).toBe(159);
    expect(smsPartsEstimate(text)).toBe(3);
  });
});
