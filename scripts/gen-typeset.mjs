#!/usr/bin/env node
/**
 * ШРИФТ ПРИЛОЖЕНИЯ: генератор apps/web/src/theme-2026-typeset.css.
 *
 * Делает две вещи разом, потому что обе упираются в одно и то же препятствие:
 *   1. ПОДНИМАЕТ РАЗМЕРЫ ТЕКСТА до читаемых;
 *   2. СВОДИТ ГАРНИТУРУ К ОДНОЙ — Onest вместо пары Manrope + Onest
 *      («Б. Одно семейство делаем», владелец 21.09.2026). Токенов --ff-head/--hf
 *      для этого мало: в теме 49 правил называют "Manrope" прямо строкой, мимо
 *      всяких токенов, и заголовки остались бы прежней гарнитурой.
 *
 * ЗАЧЕМ. Владелец 21.09.2026: «везде всё такое маленькое, будто нужно с очками
 * смотреть». Замер по коду в тот же день: 891 правило с `font-size`, из них 187
 * на 13px, 89 на 12px и 120 правил МЕЛЬЧЕ 13px — вплоть до 11, 10, 9,5, 9 и
 * 8,5px. Общепринятая база в приложениях — 16px, а не 13.
 *
 * ПОЧЕМУ ГЕНЕРАТОР, А НЕ ПРАВКА РАЗМЕРОВ НА МЕСТЕ. Больше половины этих правил
 * лежит в файлах, которые собираются скриптами из артефактов владельца целиком
 * (`theme-2026-proto.css` — sync-proto-css.py, `theme-2026-mobile-home.css` —
 * sync-mobile-css.py, `theme-2026-wizard.css` — sync-wizard-css.py). Правка
 * руками исчезла бы при следующей синхронизации БЕЗ ЕДИНОЙ ОШИБКИ — ровно та
 * ловушка, о которой предупреждает CLAUDE.md. Поэтому размеры не правятся, а
 * ПЕРЕКРЫВАЮТСЯ: для каждого правила с мелким размером печатается правило с тем
 * же селектором и новым размером, в файл, подключённый в index.css последним.
 * Вес селекторов совпадает, побеждает подключённый позже.
 *
 * ПОЧЕМУ ЭТО МОЖНО ПЕРЕЗАПУСКАТЬ. После пересинхронизации любого артефакта
 * достаточно снова выполнить `npm run gen:typeset` — файл соберётся заново по
 * текущим исходникам, и ни один новый мелкий размер не потеряется. Проверка
 * `npm run audit:typescale` (тот же скрипт с --check) валит CI, если файл
 * разошёлся с исходниками.
 *
 * ШКАЛА. Мелкое растёт сильно, крупное почти не трогается: у крупных заголовков
 * высота блоков часто подогнана вручную, и рост на 20% ломал бы вёрстку, тогда
 * как ради читаемости растить надо именно низ шкалы.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = new URL("../apps/web/src/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = "theme-2026-typeset.css";

/** Одна гарнитура на всё приложение. `Onest Fallback` — подменная метрика из
 *  темы (theme-2026-proto.css:35), она же стоит у самого `.rh2`. */
const FAMILY = 'Onest, "Onest Fallback", "Segoe UI", system-ui, sans-serif';

/** Старый размер (px) -> новый. Ничего мельче 13. */
export function scale(px) {
  if (px <= 11) return 13;
  if (px <= 12.5) return 13; // 06.10.2026: без половинок, шкала контракта 13/15/16/18/22/28
  if (px <= 14) return 15;
  if (px <= 15) return 16;
  if (px <= 16) return 17;
  if (px <= 17) return 18;
  if (px <= 19) return 20;
  if (px <= 22) return 22;
  if (px <= 23) return 24;
  return px; // 26, 28, 34 — крупные заголовки оставляем как есть
}

/**
 * Разбор таблицы стилей по глубине скобок. Полноценный парсер CSS здесь не
 * нужен и вреден: нам нужны ровно селектор, его `font-size` и обрамляющие
 * `@media`, а всё остальное должно пройти мимо нетронутым.
 */
function collect(text, file, out) {
  let i = 0;
  const stack = []; // обрамляющие @media/@supports
  let buf = "";
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "{") {
      const prelude = buf.trim();
      buf = "";
      if (prelude.startsWith("@")) {
        if (/^@(media|supports)\b/.test(prelude)) {
          stack.push(prelude);
          i += 1;
          continue;
        }
        // @font-face, @keyframes и прочее — пропускаем блок целиком
        let depth = 1;
        i += 1;
        while (i < text.length && depth > 0) {
          if (text[i] === "{") depth += 1;
          else if (text[i] === "}") depth -= 1;
          i += 1;
        }
        continue;
      }
      // обычное правило
      let depth = 1;
      const start = i + 1;
      i += 1;
      while (i < text.length && depth > 0) {
        if (text[i] === "{") depth += 1;
        else if (text[i] === "}") depth -= 1;
        i += 1;
      }
      const body = text.slice(start, i - 1);
      if (prelude && !prelude.includes("&")) {
        const size = body.match(/(^|[;{\s])font-size:\s*([0-9.]+)px/);
        // Ночная проверка 24.09.2026: первая регулярка не видит шортхенд
        // `font: 700 12px/21px var(--hf)` — размер там не после `font-size:`,
        // а второй непробельной группой после `font:`. Без этого шва 11 правил
        // темы (mobile-home.css, mobile-lists.css, proto.css) оставались мельче
        // 13px и сторож их не видел, потому что он же и не видел.
        const shorthand = !size && body.match(/font:\s*(?:\S+\s+)*?([0-9.]+)px/);
        const from = size ? parseFloat(size[2]) : shorthand ? parseFloat(shorthand[1]) : null;
        const scaled = from === null ? null : scale(from);
        // Гарнитуру перекрываем только там, где она названа строкой: правила
        // через var(--ff-head) уже ведут на Onest через theme-2026-brand.css.
        const family = /font-family:[^;}]*Manrope/.test(body);
        const to = scaled === from ? null : scaled;
        if (to !== null || family) out.push({ file, media: [...stack], selector: prelude, from, to, family });
      }
      continue;
    }
    if (ch === "}") {
      stack.pop();
      buf = "";
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
}

function build() {
  const files = readdirSync(WEB).filter((f) => f.endsWith(".css") && f !== OUT && f !== "index.css");
  const rules = [];
  for (const f of files) collect(readFileSync(join(WEB, f), "utf8"), f, rules);

  const sized = rules.filter((r) => r.to !== null).length;
  const famed = rules.filter((r) => r.family).length;
  const head = `/* СОБРАНО СКРИПТОМ scripts/gen-typeset.mjs — РУКАМИ НЕ ПРАВИТЬ.
 *
 * Каждое правило здесь повторяет селектор из темы и меняет только размер текста
 * и гарнитуру. Зачем это нужно и почему именно генератором — в шапке скрипта.
 * Пересобрать: npm run gen:typeset. Проверить: npm run audit:typeset.
 *
 * Правил: ${rules.length} (размер поднят у ${sized}, гарнитура сведена у ${famed}).
 * Ничего мельче 13px не остаётся, "Manrope" строкой не остаётся нигде.
 */\n`;

  // Группируем по обрамляющим @media, чтобы не открывать их по десять раз.
  const byMedia = new Map();
  for (const r of rules) {
    const key = r.media.join(" || ");
    if (!byMedia.has(key)) byMedia.set(key, []);
    byMedia.get(key).push(r);
  }
  let css = head;
  for (const [key, list] of byMedia) {
    const media = key ? key.split(" || ") : [];
    const pad = "  ".repeat(media.length);
    for (const m of media) css += `${"  ".repeat(media.indexOf(m))}${m} {\n`;
    for (const r of list) {
      const decls = [];
      if (r.to !== null) decls.push(`font-size: ${r.to}px`);
      if (r.family) decls.push(`font-family: ${FAMILY}`);
      css += `${pad}${r.selector} { ${decls.join("; ")}; }\n`;
    }
    for (let k = media.length - 1; k >= 0; k -= 1) css += `${"  ".repeat(k)}}\n`;
  }
  return { css, count: rules.length };
}

const { css, count } = build();
const target = join(WEB, OUT);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    console.error(`Нет файла ${OUT}. Выполните: npm run gen:typeset`);
    process.exit(1);
  }
  if (current !== css) {
    console.error(`${OUT} разошёлся с темой. Выполните: npm run gen:typeset`);
    process.exit(1);
  }
  console.log(`Шрифт приложения на месте: ${count} правил.`);
} else {
  writeFileSync(target, css);
  console.log(`${OUT}: ${count} правил.`);
}
