import { createHmac, timingSafeEqual } from "node:crypto";
import { maskClientPhone } from "./clientPhone.js";
import { CLIENT_PHONE_MASK_CHAR } from "@royal-home/shared";
type Phones = { id: string; phone: string; whatsappPhone?: string | null; extraPhones: string[] };
function slots(client: Phones): Array<[string, string]> {
  return [["main", client.phone], ...(client.whatsappPhone ? [["whatsapp", client.whatsappPhone] as [string, string]] : []), ...client.extraPhones.map((p, i): [string, string] => [`extra-${i}`, p])];
}
function token(clientId: string, slot: string, phone: string): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET is required for phone selection");
  return `${slot}.${createHmac("sha256", secret).update(JSON.stringify(["client-call-selection-v1", clientId, slot, phone.replace(/\D/g, "")])).digest("base64url")}`;
}
export function clientPhoneSelectionTokens(client: Phones): Record<string, string> {
  return Object.fromEntries(slots(client).map(([slot, phone]) => [slot, token(client.id, slot, phone)]));
}
/**
 * Tokens contain no phone/hash. Slot and current full number are both authenticated.
 *
 * ОТКРЫТЫЙ НОМЕР — ТОЛЬКО ОТ ТОГО, КТО ЕГО И ТАК ВИДИТ (ревью 19.11.2026). Маска
 * закрывает две цифры, то есть сто вариантов. Пока сюда принимался номер цифрами от
 * любого, ответ «принадлежит карточке / не принадлежит» работал как подсказка:
 * сто тихих запросов — и номер клиента известен. Без права видеть номер годятся
 * только ключ выбора или та самая маска, которую сотруднику показали; на открытые
 * цифры ответ один и тот же, угадал он или нет.
 */
export function resolveClientPhoneSelection(
  client: Phones,
  input: { phone?: string; phoneKey?: string },
  canSeeFullPhone: boolean
): { phone?: string; conflict?: true } {
  if (input.phoneKey !== undefined) {
    const supplied = Buffer.from(input.phoneKey);
    for (const [slot, phone] of slots(client)) {
      const expected = Buffer.from(token(client.id, slot, phone));
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return { phone };
    }
    return { conflict: true };
  }
  if (input.phone?.includes(CLIENT_PHONE_MASK_CHAR)) {
    const byDigits = new Map(slots(client).map(([, phone]) => phone)
      .filter(phone => maskClientPhone(phone) === input.phone).map(phone => [phone.replace(/\D/g, ""), phone]));
    const matches = [...byDigits.values()];
    return matches.length === 1 ? { phone: matches[0] } : { conflict: true };
  }
  if (input.phone !== undefined && !canSeeFullPhone) return { conflict: true };
  return { phone: input.phone };
}
