import { phoneDigits } from "@royal-home/shared";

/**
 * Номер в форме, которую принимает провайдер СМС: 992XXXXXXXXX (двенадцать цифр).
 *
 * Те же три записи таджикского номера, что понимает станция
 * (`isDialableTajikNumber` в packages/shared/tajikPhone.ts): с кодом страны, с
 * ведущим нулём и девять цифр без всего. Иностранный номер — null: провайдер
 * шлёт только по Таджикистану, и деньги за заведомо недоставляемое СМС тратить
 * незачем.
 */
export function toSmsPhone(phone: string | null | undefined): string | null {
  const digits = phoneDigits(phone ?? "");
  if (digits.length === 12 && digits.startsWith("992")) return digits;
  if (digits.length === 10 && digits.startsWith("0")) return `992${digits.slice(1)}`;
  if (digits.length === 9) return `992${digits}`;
  return null;
}
