#!/usr/bin/env node
/**
 * ОДНО ПРАВИЛО — ОДНО МЕСТО. Сторож против «одна логика ломает вторую».
 *
 * ЗАЧЕМ. Жалоба владельца 22.09.2026 дословно: «сейчас одна логика ломают
 * вторую». Разбор нашёл её механику. Одно и то же вычислимое правило написано
 * дважды — раз на сервере, раз на сайте. Правят одно, второе остаётся старым, и
 * расходятся они МОЛЧА: сборка довольна (это два разных файла), тесты довольны
 * (каждая сторона согласна сама с собой), карта довольна. Видит расхождение
 * только человек, которому показали не ту цифру.
 *
 * Живой случай (правка #752): перевод суммы в сомони. На сервере — через
 * копейки с округлением, на сайте — умножением без округления. Одна и та же
 * сумма показывалась по-разному, и это лежало в коде, пока не начали искать.
 *
 * ЧТО ДЕЛАЕТ СТОРОЖ. Берёт имена, которые ЭКСПОРТИРУЮТСЯ и из `apps/api/src`,
 * и из `apps/web/src`, и проверяет, есть ли у них общий источник в
 * `packages/shared/src`. Нет — это кандидат в расхождение, и он не проходит.
 * Лечение: правило переезжает в `packages/shared`, обе стороны зовут его
 * оттуда, а в `apps/api/tests` кладётся тест, сверяющий обе стороны между
 * собой (образец — `apps/api/tests/money-shared-rule.test.ts`).
 *
 * ПОЧЕМУ ПО ИМЕНАМ, А НЕ ПО ТЕКСТУ. Совпадение текста ловит `npm run audit:dupes`
 * (jscpd), и оно как раз НЕ ловит опасный случай: у `toTjs` тексты были разные
 * (в том и беда), а имя — одно. Одинаковое имя по обе стороны и есть признак
 * «это задумано как одно правило».
 *
 * ЧЕГО НЕ ЛОВИТ. Правило, переписанное под другим именем, и правило,
 * размазанное по месту использования без отдельной функции. Сторож дешёвый и
 * честный в своих границах, а не всеведущий.
 *
 * ИСКЛЮЧЕНИЯ — файлом `.shared-rules-baseline.json`, с причиной у каждого.
 * Туда попадают настоящие однофамильцы: `subscribe` у шины событий сервера и у
 * очереди загрузок сайта — разные вещи с общим словом. Исключение без причины
 * не принимается: список, в который дописывают молча, через месяц перестаёт
 * что-либо значить. Запись, которой больше нет в коде, не роняет проверку —
 * про неё пишется «можно убрать».
 *
 *   node scripts/audit-shared-rules.mjs          # проверить
 *   node scripts/audit-shared-rules.mjs --list   # показать всё найденное, не заваливая
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, ".shared-rules-baseline.json");
const LIST_ONLY = process.argv.slice(2).includes("--list");

/** Имя короче этого — слишком общее, чтобы по нему о чём-то судить. */
const MIN_NAME = 5;

const EXPORT_RE = /export\s+(?:async\s+)?(?:const|function|class)\s+([A-Za-z_$][\w$]*)/g;

function collect(root) {
  const names = new Map(); // имя -> [файлы]
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      // `generated` — клиент Prisma: машинный код, не наше правило.
      if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.(test|spec|d)\.tsx?$/.test(entry)) continue;
      let text;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = relative(ROOT, full).replace(/\\/g, "/");
      EXPORT_RE.lastIndex = 0;
      let m;
      while ((m = EXPORT_RE.exec(text))) {
        if (!names.has(m[1])) names.set(m[1], []);
        if (!names.get(m[1]).includes(rel)) names.get(m[1]).push(rel);
      }
    }
  };
  walk(join(ROOT, root));
  return names;
}

const api = collect("apps/api/src");
const web = collect("apps/web/src");
const shared = collect("packages/shared/src");

const findings = [];
for (const [name, apiFiles] of api) {
  if (name.length < MIN_NAME) continue;
  if (!web.has(name)) continue;
  // Общий источник есть — обе стороны обязаны звать его, и это проверяет уже
  // не сторож, а типы: расходиться там нечему.
  if (shared.has(name)) continue;
  findings.push({ name, api: apiFiles, web: web.get(name) });
}
findings.sort((a, b) => a.name.localeCompare(b.name));

let baseline = {};
if (existsSync(BASELINE)) {
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8")).allowed || {};
  } catch {
    console.error(`Не разобрать ${relative(ROOT, BASELINE)} — проверка не может быть честной.`);
    process.exit(1);
  }
}

const fresh = findings.filter((f) => !baseline[f.name]);
const stale = Object.keys(baseline).filter((n) => !findings.some((f) => f.name === n));

const describe = (f) =>
  `  ${f.name}\n      сервер: ${f.api.join(", ")}\n      сайт:   ${f.web.join(", ")}`;

if (LIST_ONLY) {
  console.log(`Имён, живущих и на сервере, и на сайте без общего источника: ${findings.length}`);
  for (const f of findings) {
    console.log(describe(f) + (baseline[f.name] ? `\n      разрешено: ${baseline[f.name]}` : ""));
  }
  process.exit(0);
}

if (stale.length) {
  console.log(
    `Из ${relative(ROOT, BASELINE)} можно убрать (в коде этого больше нет): ${stale.join(", ")}`,
  );
}

if (!fresh.length) {
  console.log(
    `Одно правило — одно место: новых двойников нет` +
      (findings.length ? ` (разрешённых в списке: ${findings.length}).` : "."),
  );
  process.exit(0);
}

console.error(
  `\nОДНО ПРАВИЛО НАПИСАНО ДВАЖДЫ — ${fresh.length} шт.\n` +
    `Сервер и сайт объявляют одно имя, а общего источника в packages/shared нет.\n` +
    `Правят одну сторону — вторая тихо остаётся старой (так разошёлся toTjs, правка #752).\n`,
);
for (const f of fresh) console.error(describe(f));
console.error(
  `\nЧто делать: перенести правило в packages/shared, звать оттуда с обеих сторон,\n` +
    `и положить в apps/api/tests тест, сверяющий обе стороны (образец —\n` +
    `apps/api/tests/money-shared-rule.test.ts).\n` +
    `Это однофамильцы, а не одно правило? Дописать в ${relative(ROOT, BASELINE)} с причиной.`,
);
process.exit(1);
