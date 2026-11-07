/**
 * ЧЕСТНЫЙ ОТВЕТ, КОГДА ШАГИ КОНЧИЛИСЬ (07.11.2026). Раньше человек получал
 * «Не удалось собрать ответ за разумное число шагов» и терял всё, что помощница уже
 * нашла. Теперь: что нашли — списком, что проверили, и один уточняющий вопрос.
 * Результаты инструментов не выдумываются: берём только поля `items[].code/href/...`.
 */

export const LAST_ROUND_INSTRUCTION =
  "\n\nЭТО ПОСЛЕДНИЙ ШАГ: инструменты больше не вызывай. Ответь по тому, что УЖЕ найдено выше. " +
  "Чего не нашла или не успела проверить — скажи прямо и задай ОДИН уточняющий вопрос (ориентир, район, цена).";

export interface CollectedToolResult {
  name: string;
  result: unknown;
}

interface ItemLike {
  code?: unknown;
  href?: unknown;
  title?: unknown;
  address?: unknown;
  name?: unknown;
  district?: unknown;
  price?: unknown;
  currency?: unknown;
  inTrash?: unknown;
  distanceM?: unknown;
}

function lineOf(item: ItemLike): string | null {
  const code = typeof item.code === "string" ? item.code : null;
  if (!code) return null;
  const label = [item.title, item.name, item.address, item.district].find((v) => typeof v === "string" && v.trim()) as string | undefined;
  const price =
    typeof item.price === "number" && typeof item.currency === "string"
      ? `${item.price.toLocaleString("ru-RU")} ${item.currency === "USD" ? "$" : "с."}`
      : null;
  const href = typeof item.href === "string" ? item.href : null;
  const parts = [
    href ? `[${code}](${href})` : code,
    label ? label.slice(0, 80) : null,
    price,
    typeof item.distanceM === "number" ? `${item.distanceM} м` : null,
    item.inTrash === true ? "в Корзине" : null,
  ].filter(Boolean);
  return `- ${parts.join(" · ")}`;
}

/** Есть ли в результатах инструментов хоть одна карточка с кодом. */
export function hasFoundItems(collected: readonly CollectedToolResult[]): boolean {
  return collected.some(({ result }) => {
    const items = (result as { items?: unknown } | null)?.items;
    return Array.isArray(items) && items.some((i) => typeof (i as ItemLike)?.code === "string");
  });
}

/** Текст «собрала частично» из результатов инструментов за диалог. */
export function partialAnswerFromResults(collected: readonly CollectedToolResult[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const { result } of collected) {
    const items = (result as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) continue;
    for (const raw of items) {
      const line = lineOf(raw as ItemLike);
      if (line && !seen.has(line)) {
        seen.add(line);
        lines.push(line);
      }
      if (lines.length >= 6) break;
    }
    if (lines.length >= 6) break;
  }
  if (lines.length === 0) {
    return (
      `Я сделала ${collected.length || "несколько"} проверок, но ответа не собрала — запрос получился слишком широким. ` +
      "Назовите ориентир или улицу, район и цену (в сомони или долларах), и я поищу точнее."
    );
  }
  return (
    "Собрала пока вот что, остальное не успела проверить:\n" +
    lines.join("\n") +
    "\nСкажите ориентир или район точнее — продолжу поиск."
  );
}
