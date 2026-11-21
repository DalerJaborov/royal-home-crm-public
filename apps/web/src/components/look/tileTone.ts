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

/**
 * ТОН ПИЛЮЛИ, МЕТКИ, КРУЖКА И ПОДПИСИ — ОДНА ФУНКЦИЯ (владелец 20.11.2026, аудит К13: «красная
 * пилюля с огнём на каждом звонке, янтарная «позвонить» на каждом клиенте, жёлтый «0»,
 * огромные зелёная и красная «Верно/Неверно»»). Если всё цветное, выделено ничего.
 * Правило одно, оно же у плитки (`tileTone` выше):
 *  - по умолчанию нейтрально (`info`, число не важно);
 *  - `today` — требует внимания сегодня → жёлтая;
 *  - `overdue` — реально просрочено или потеряно → красная, без огня: причину называет текст;
 *  - `good` — хороший итог → зелёная;
 *  - ноль, пусто и «нет числа» — всегда спокойно (`neutral`), каким бы ни был смысл.
 * Экраны нового вида красят пилюли, метки и кружки только отсюда — сторож `pillTone.test.ts`
 * не пропускает буквальный `tone="crit"` и красные/янтарные классы мимо этой функции.
 */
export type PillTone = "crit" | "warn" | "ok" | "neutral";
export type PillMeaning = "overdue" | "today" | "good" | "info";

export function pillTone(meaning: PillMeaning, count?: number | null): PillTone {
  if (count !== undefined && (count === null || !Number.isFinite(count) || count <= 0)) return "neutral";
  if (meaning === "overdue") return "crit";
  if (meaning === "today") return "warn";
  if (meaning === "good") return "ok";
  return "neutral";
}

/** Балл разбора звонка: хороший — зелёный, остальное — спокойно (низкий балл — не тревога, а итог разговора). */
export function scorePillTone(score: number | null | undefined): PillTone {
  return pillTone(typeof score === "number" && score >= 70 ? "good" : "info");
}

/**
 * Слово важности из данных (`crit` / `warn` / `muted` / `ok`, как приходят из чистых функций вроде leader.ts
 * или с сервера) → тон пилюли. Через эту же функцию тона: свой набор цветов у слова не появляется.
 */
export function pillToneOf(severity: "crit" | "warn" | "ok" | "muted" | "mute" | "info" | "neutral" | null | undefined, count?: number | null): PillTone {
  if (severity === "crit") return pillTone("overdue", count);
  if (severity === "warn") return pillTone("today", count);
  if (severity === "ok") return pillTone("good", count);
  return pillTone("info", count);
}
