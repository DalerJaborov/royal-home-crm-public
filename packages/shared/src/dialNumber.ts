/**
 * Номер для набора: как его понимает станция и как его видит человек.
 *
 * Живёт в общем пакете, потому что этим знанием пользуются обе стороны: браузерный
 * наборщик (показать и собрать) и сервер (нормализовать перед звонком). Две копии
 * правила разошлись бы в первый же месяц — и звонок ушёл бы не туда, о чём стало
 * бы известно по тишине в трубке, а не по ошибке.
 */

/** Местный номер Таджикистана — девять цифр без кода страны. */
export const LOCAL_NUMBER_LENGTH = 9;

/**
 * Что человек набрал или вставил → девять местных цифр.
 *
 * Понимает `+992 93 000 10 01`, `992930001001`, `0930001001` и голые девять цифр:
 * номера копируют из WhatsApp, из объявления, из записной книжки, и «неверный
 * формат» на вставленном номере — худший из возможных ответов.
 *
 * Короткие наборы (внутренние 1006, служебные *43) остаются как есть: они тоже
 * законный набор, и обрезать их до девяти цифр нечем.
 */
export function toLocalDialDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 12 && digits.startsWith("992")) return digits.slice(3, 3 + LOCAL_NUMBER_LENGTH);
  if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length <= 5) return digits;
  return digits.slice(0, LOCAL_NUMBER_LENGTH);
}

/**
 * `930001001` → `93 000 10 01`. Разбивка привычная для Таджикистана: оператор
 * читает номер вслух клиенту именно так, и сплошные девять цифр он проговаривает
 * с ошибками.
 */
export function formatLocalDialNumber(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, LOCAL_NUMBER_LENGTH);
  return [d.slice(0, 2), d.slice(2, 5), d.slice(5, 7), d.slice(7, 9)].filter(Boolean).join(" ");
}

/**
 * Можно ли звонить на то, что набрано.
 *
 * Полный местный номер (9), внутренний (3–4 цифры) и служебный код (`*43`) —
 * законны. Всё остальное — незаконченный набор, и кнопка звонка ждёт.
 */
export function isDialable(input: string): boolean {
  if (/^[*#]/.test(input)) return input.length >= 2;
  const digits = input.replace(/\D/g, "");
  return digits.length === LOCAL_NUMBER_LENGTH || digits.length === 3 || digits.length === 4;
}
