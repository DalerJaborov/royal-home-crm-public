/**
 * МОЖНО ЛИ НАБРАТЬ НОМЕР: ОДНО ПРАВИЛО — ОДНО МЕСТО.
 *
 * Это правило было написано дважды, и стороны отвечают на него по разным
 * поводам: сервер решает, ЗВОНИТЬ ли (`lib/telephony/ariClient.ts`), сайт
 * решает, показывать ли КНОПКУ звонка (`lib/phone.ts`). Именно поэтому
 * расхождение здесь особенно неприятно: разойдутся — агент видит кнопку,
 * жмёт, а звонок не уходит, и выглядит это как поломка телефонии, а не как
 * разная проверка номера.
 */

/** Только цифры: набирают их, а не скобки, пробелы и плюс. */
export function phoneDigits(phone: string): string {
  return String(phone ?? "").replace(/\D/g, "");
}

/**
 * Три формы таджикского номера, которые станция умеет набрать:
 *   992 XX XXX XX XX — двенадцать цифр с кодом страны;
 *   0 XX XXX XX XX   — десять цифр с ведущим нулём (местная запись);
 *   XX XXX XX XX     — девять цифр без всего.
 */
export function isDialableTajikNumber(phone: string): boolean {
  const digits = phoneDigits(phone);
  if (digits.length === 12 && digits.startsWith("992")) return true;
  if (digits.length === 10 && digits.startsWith("0")) return true;
  return digits.length === 9;
}
