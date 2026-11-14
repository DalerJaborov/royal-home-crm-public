/**
 * ОДИН РАЗБОРЩИК СУММЫ РАСХОДА ИЗ ТЕКСТА (10.11.2026, ревью пачки расходов).
 *
 * Ячейка таблицы, строка фото, поправка «Править» — всё через эту функцию. Правила:
 * - пробелы, неразрывные и узкие пробелы — разделители тысяч («1 200 000»);
 * - «1.200» и «1,200» (ровно три цифры после единственного знака) — тысячи, «12.50» и «1,5» — дробь;
 * - «тыс», «т», «k», «ҳазор», «ming» — ×1000; «млн», «mln», «миллион», «million» — ×1 000 000;
 * - «1E+3» — 1000 (как в Excel);
 * - бухгалтерские скобки «(500)» и минус — отрицательная сумма: расход таким быть не может, отказ;
 * - валюта: $ / USD / доллар — USD; сомони / TJS / смн / с. — TJS; любая другая (€, руб, ₽, тенге,
 *   сум, юань, фунт или код из трёх букв) — `unsupported`: такую строку не пишем и не превращаем в сомони
 *   молча (новые валюты — после миграции enum Currency, следующей пачкой).
 */

export type ParsedCurrency = "TJS" | "USD";
export type AmountParse =
  | { ok: true; amount: number; currency?: ParsedCurrency }
  | { ok: false; reason: "empty" | "not_number" | "negative" | "too_large" | "unsupported_currency"; currency?: string };

const USD = /\$|\busd\b|доллар|dollar/iu;
const TJS = /\btjs\b|сомон|somon|смн|(?:^|[\s\d])с\.?(?=$|\s)/iu;
const OTHER: [RegExp, string][] = [
  [/€|\beur\b|евро|euro/iu, "€"], [/₽|\brub\b|руб/iu, "₽"], [/₸|\bkzt\b|тенге|tenge/iu, "₸"],
  [/\buzs\b|(?:^|[\s\d])сум(?=$|[\s.,])|so'm|сўм/iu, "сум"], [/¥|\bcny\b|юан|yuan/iu, "¥"], [/£|\bgbp\b|фунт/iu, "£"],
];
const THOUSAND = /(?:^|[\d\s])(?:тыс\.?|тысяч\p{L}*|т\.?|k|ҳазор|хазор|ming)(?=$|[\s.,])/iu;
const MILLION = /(?:^|[\d\s])(?:млн\.?|миллион\p{L}*|mln|million|mb\b)(?=$|[\s.,])/iu;

/** Валюта, явно названная в тексте; `other` — не TJS и не USD. */
export function currencyInText(text: string): { currency?: ParsedCurrency; other?: string } {
  const other = OTHER.find(([re]) => re.test(text));
  if (other) return { other: other[1] };
  if (USD.test(text)) return { currency: "USD" };
  if (TJS.test(text)) return { currency: "TJS" };
  const code = /\b([A-Z]{3})\b/u.exec(text)?.[1];
  if (code && code !== "TJS" && code !== "USD") return { other: code };
  return {};
}

export function parseExpenseAmount(raw: string): AmountParse {
  const text = raw.replace(/[   ]/gu, " ").trim();
  if (!text) return { ok: false, reason: "empty" };
  const found = currencyInText(text);
  if (found.other) return { ok: false, reason: "unsupported_currency", currency: found.other };
  const negative = /^\(.*\)$/u.test(text) || /(?:^|[\s$])[-−–]\s*\d/u.test(text);
  const multiplier = MILLION.test(text) ? 1_000_000 : THOUSAND.test(text) ? 1_000 : 1;
  const numeric = /\d[\d\s.,]*(?:[eE][+-]?\d+)?/u.exec(text)?.[0]?.trim();
  if (!numeric) return { ok: false, reason: "not_number" };
  // Лишние цифры рядом (два числа в ячейке) — не угадываем, какое из них сумма.
  const rest = text.replace(numeric, " ");
  if (/\d/u.test(rest)) return { ok: false, reason: "not_number" };
  let value: number;
  if (/[eE]/u.test(numeric)) value = Number(numeric.replace(/\s/gu, "").replace(",", "."));
  else {
    const compact = numeric.replace(/\s/gu, "");
    if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(compact) && !/^\d{1,3}[.,]\d{3}[.,]\d{1,2}$/u.test(compact)) {
      value = Number(compact.replace(/[.,]/gu, ""));
    } else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/u.test(compact)) value = Number(compact.replace(/,/gu, ""));
    else if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/u.test(compact)) value = Number(compact.replace(/\./gu, "").replace(",", "."));
    else if (/^\d+(?:[.,]\d{1,2})?$/u.test(compact)) value = Number(compact.replace(",", "."));
    else return { ok: false, reason: "not_number" };
  }
  if (!Number.isFinite(value)) return { ok: false, reason: "not_number" };
  if (negative) return { ok: false, reason: "negative" };
  const amount = Math.round(value * multiplier * 100) / 100;
  if (amount <= 0) return { ok: false, reason: "not_number" };
  if (amount > 99_999_999.99) return { ok: false, reason: "too_large" };
  return { ok: true, amount, ...(found.currency ? { currency: found.currency } : {}) };
}
