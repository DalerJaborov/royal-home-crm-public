import { positiveBudget } from "@royal-home/shared";
import { glueNumbers } from "./glueNumbers";

/** Одна цифра после запятой, без хвоста «,0»: 1,7 млн, но 2 млн. */
const oneDecimal = (x: number) => (Math.round(x * 10) / 10).toLocaleString("ru-RU");

type Unit = { div: number; label: string };
const unitOf = (x: number): Unit => (x >= 1_000_000 ? { div: 1_000_000, label: " млн" } : x >= 1_000 ? { div: 1_000, label: " тыс." } : { div: 1, label: "" });

/**
 * Бюджет для второй строки клиента: «$55–70 тыс.», «до $45 тыс.», «от 1,2 млн с.».
 *
 * Единица берётся по большему краю, чтобы «55–70» не превращалось в «55–70 000». Но если края
 * в разных единицах (от 300 000 до 99 999 999), общая единица по большему краю превращает
 * нижний в «0,3» (К10.5 аудита 20.11: «0,3–100 млн с.»), и читается, что клиент ищет от нуля.
 * Тогда у каждого края своя единица: «300 тыс. – 100 млн с.» (пробелы вокруг тире — неразрывные
 * в glueNumbers, строка рвётся только по тире).
 */
export function budgetShort(c: { budgetMin?: number | string | null; budgetMax?: number | string | null; currency?: string | null }): string | null {
  const min = c.budgetMin ? Number(c.budgetMin) : null;
  const max = positiveBudget(c.budgetMax);
  if (!min && !max) return null;
  const sym = c.currency === "USD" ? "$" : "";
  const tail = c.currency === "USD" ? "" : " с.";
  if (min && max) {
    const uMin = unitOf(min), uMax = unitOf(max);
    // Нижний край меньше своей единицы большего (0,3 млн) — каждому краю своя единица.
    if (uMin.div !== uMax.div && min / uMax.div < 1) {
      return glueNumbers(`${sym}${oneDecimal(min / uMin.div)}${uMin.label} – ${sym}${oneDecimal(max / uMax.div)}${uMax.label}${tail}`);
    }
    return glueNumbers(`${sym}${oneDecimal(min / uMax.div)}–${oneDecimal(max / uMax.div)}${uMax.label}${tail}`);
  }
  const ref = (max || min) as number;
  const u = unitOf(ref);
  // glueNumbers: «1,1–1,3 млн с.» не рвётся на «1,3 / млн с.» на узком телефоне (20.11).
  if (max) return glueNumbers(`до ${sym}${oneDecimal(max / u.div)}${u.label}${tail}`);
  return glueNumbers(`от ${sym}${oneDecimal((min as number) / u.div)}${u.label}${tail}`);
}
