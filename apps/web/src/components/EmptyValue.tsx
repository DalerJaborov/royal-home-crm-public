import type { ReactNode } from "react";

/**
 * ПУСТОЕ ЗНАЧЕНИЕ — ОДНО СЛОВО НА ВЕСЬ ИНТЕРФЕЙС (К10 аудита 20.11, решение 21.11.2026).
 *
 * На экране объекта пустое место писали четырьмя способами: «0,00 с.», «0 сомони», «—» и «нет
 * данных» (последнее ещё и цифровым кеглем, в две строки). Теперь, когда значения нет вовсе
 * (расчёт не пришёл, делить не на что), везде стоит слово «нет» — обычным шрифтом, серым, одной
 * строкой. Настоящий ноль («0 обращений») остаётся числом: «нет» — это отсутствие, не ноль.
 * Пояснение, почему нет, — в `reason` (всплывающая подсказка), а не вместо слова; озвучка читает само слово один раз.
 */
export const EMPTY_VALUE_TEXT = "нет";

export function EmptyValue({ reason }: { reason?: string }) {
  return (
    <span className="rh-empty" title={reason}>
      {EMPTY_VALUE_TEXT}
    </span>
  );
}

/** Значение или «нет»: `null`, `undefined` и пустая строка — пусто. */
export function valueOrEmpty(value: ReactNode | null | undefined, reason?: string): ReactNode {
  return value === null || value === undefined || value === "" ? <EmptyValue reason={reason} /> : value;
}

/** Длина строки числа для лесенки `.rh-fit` (theme-look-royal.css): s ≤ 9 знаков, m ≤ 13, l — длиннее. */
export function lenBucket(value: string): "s" | "m" | "l" {
  return value.length <= 9 ? "s" : value.length <= 13 ? "m" : "l";
}
