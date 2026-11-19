import { beforeEach, describe, expect, it, vi } from "vitest";
import { clientPhoneSelectionTokens, resolveClientPhoneSelection } from "../src/lib/clientPhoneSelection.js";
import { maskClientPhone } from "../src/lib/clientPhone.js";
describe("opaque phone selection", () => {
  beforeEach(() => vi.stubEnv("JWT_ACCESS_SECRET", "isolated-phone-selection-test-secret"));
  const client = { id: "client-one", phone: "+992900000001", extraPhones: ["+992911111157", "+992911122157"] };
  it("selects the intended number despite identical masks without exposing digits", () => {
    expect(maskClientPhone(client.extraPhones[0])).toBe(maskClientPhone(client.extraPhones[1]));
    const keys = clientPhoneSelectionTokens(client);
    expect(resolveClientPhoneSelection(client, { phoneKey: keys["extra-1"] }, false)).toEqual({ phone: client.extraPhones[1] });
    expect(JSON.stringify(keys)).not.toContain("911122157");
    expect(resolveClientPhoneSelection(client, { phone: maskClientPhone(client.extraPhones[0]) }, false)).toEqual({ conflict: true });
  });
  it("rejects reorder with the same mask and cross-client replay", () => {
    const keys = clientPhoneSelectionTokens(client);
    expect(resolveClientPhoneSelection({ ...client, extraPhones: [...client.extraPhones].reverse() }, { phoneKey: keys["extra-1"] }, false)).toEqual({ conflict: true });
    expect(resolveClientPhoneSelection({ ...client, id: "other" }, { phoneKey: keys["extra-1"] }, false)).toEqual({ conflict: true });
  });
  it("never falls back from invalid supplied token to a phone", () => {
    expect(resolveClientPhoneSelection(client, { phoneKey: "tampered", phone: client.phone }, false)).toEqual({ conflict: true });
    expect(resolveClientPhoneSelection(client, {}, false)).toEqual({ phone: undefined });
  });
  it("открытые цифры без права видеть номер: ответ один, угадал или нет (подбор двух скрытых цифр, ревью 19.11.2026)", () => {
    // Маска закрывает две цифры — сто вариантов. Ответ не должен отличать верную догадку от неверной.
    const guessedRight = resolveClientPhoneSelection(client, { phone: client.phone }, false);
    const guessedWrong = resolveClientPhoneSelection(client, { phone: "+992900000991" }, false);
    expect(guessedRight).toEqual({ conflict: true });
    expect(guessedWrong).toEqual(guessedRight);
    expect(resolveClientPhoneSelection(client, { phone: client.extraPhones[0] }, false)).toEqual({ conflict: true });
    // Кто номер и так видит, шлёт его как раньше; принадлежность карточке проверяет маршрут.
    expect(resolveClientPhoneSelection(client, { phone: client.extraPhones[0] }, true)).toEqual({ phone: client.extraPhones[0] });
    // Маска, которую сотруднику показали, по-прежнему разворачивается в номер этой карточки.
    expect(resolveClientPhoneSelection({ ...client, extraPhones: [] }, { phone: maskClientPhone(client.phone) }, false)).toEqual({ phone: client.phone });
  });
  it("keeps legacy selection working when two slots contain the same complete number", () => {
    const same = { ...client, whatsappPhone: "+992 900 000 001", extraPhones: [] };
    const result = resolveClientPhoneSelection(same, { phone: maskClientPhone(same.phone) }, false);
    expect("conflict" in result).toBe(false);
    expect(result.phone?.replace(/\D/g, "")).toBe("992900000001");
  });
});
