/** Маска секрета для экрана: только последние 4 символа. Сам ключ наружу не уходит. */
export function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••${key.slice(-4)}`;
}
