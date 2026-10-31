/**
 * Канонический JSON: одинаковые по смыслу значения дают одну и ту же строку
 * независимо от порядка ключей. Нужен там, где значение сравнивается или
 * хешируется после хранения в JSONB — Postgres сам переставляет ключи, и
 * наивный `JSON.stringify` на сохранённом и свежем снимке разошёлся бы на
 * совпадающих данных.
 *
 * Сначала значение проходит через `toPlainJson` (тот же путь, что у записи в
 * базу: `Date` → ISO-строка, `Decimal` → строка, `undefined`-поля пропадают),
 * поэтому свежий снимок из Prisma и прочитанный из JSONB сравниваются честно.
 *
 * ДОЛГ (31.10.2026): в apps/api ещё пять приватных копий того же приёма
 * (`customerAgentRevision.ts`, `customerApprovedFiles.ts`,
 * `customerDeliveryMedia.ts`, `customerPropertyMedia.ts`,
 * `customerAgentProviderConfig.ts`). Новый код берёт этот модуль; перевод
 * старых — отдельной правкой с их тестами, не попутно.
 */
export function toPlainJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("Значение не сериализуется в JSON");
  return JSON.parse(text) as unknown;
}

function stringifySorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stringifySorted).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stringifySorted(record[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value: unknown): string {
  return stringifySorted(toPlainJson(value));
}
