import { tajikNationalNumber } from "@royal-home/shared";

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
  const national = tajikNationalNumber(phone);
  return national ? `992${national}` : null;
}
