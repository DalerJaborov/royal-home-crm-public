/**
 * ЦВЕТ ПЛИТКИ — ПО СМЫСЛУ И ЗНАЧЕНИЮ (главные руководителей, 20.11.2026).
 *
 * Разбор кадров 20.11 (critic-uiux P1-2, critic-director-rop §1): лайм, чёрный и
 * белый стояли за позицией плитки, а не за смыслом. Чёрная «Горит 0» выглядела
 * тревогой при полном спокойствии, а в тёмной теме сливалась с фоном. Правило теперь
 * одно и живёт здесь:
 *  - нет числа (не загрузилось)         → `plain`, обычная белая;
 *  - ноль (нечего делать)                → `calm`, спокойная серая, цифра приглушена;
 *  - срочное больше нуля (`urgent`)      → `crit`, светло-красная с красной цифрой;
 *  - есть что сделать (`attention`)      → `brand`, лайм;
 *  - хороший итог больше нуля (`good`)   → `ok`, светло-зелёная;
 *  - справка (`info`)                    → `plain`.
 * Чёрная плитка (`ink`) этой функцией не выдаётся: тревогу она больше не обозначает.
 *
 * Плитки главных руководителей берут вариант только отсюда — сторож
 * `tileTone.test.ts` не пропускает буквальный `variant="…"` у RhTile в их блоках.
 */
export type TileMeaning = "urgent" | "attention" | "good" | "info";
export type TileVariant = "calm" | "crit" | "brand" | "ok" | "plain";

export function tileTone(meaning: TileMeaning, value: number | null | undefined): TileVariant {
  if (value === null || value === undefined || !Number.isFinite(value)) return "plain";
  if (value <= 0) return "calm";
  if (meaning === "urgent") return "crit";
  if (meaning === "attention") return "brand";
  if (meaning === "good") return "ok";
  return "plain";
}
