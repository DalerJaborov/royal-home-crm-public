#!/usr/bin/env node
/**
 * Правила зависимостей с поправкой на уже существующие циклы.
 *
 * Зачем. `npm run audit:deps` красный на самом `main`: в узле «лиды ↔ телефония»
 * лежат три круговые зависимости, развязка которых ждёт слияния чужих веток
 * (см. .dependency-cruiser-baseline.json). Красная проверка, которую нельзя
 * сделать зелёной, не может быть обязательной при слиянии — а необязательную
 * проверку никто не читает. В итоге правило `no-circular` перестало защищать
 * от НОВЫХ циклов, ради которых его и заводили.
 *
 * Что делает. Гоняет тот же dependency-cruiser с тем же конфигом, но сверяет
 * найденные ошибки со списком известных. Новая ошибка — красный прогон. Ошибка
 * из списка — строка «известная, ждёт развязки» и зелёный прогон. Исчезнувшая
 * из кода строка списка — громкое напоминание убрать её оттуда (не падение:
 * иначе починка цикла красит чужой PR).
 *
 * Предупреждения (no-orphans и прочее) не трогаем вовсе: они и раньше не роняли
 * прогон, депкрузер возвращает код по числу ОШИБОК.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TARGETS = ["apps/api/src", "apps/web/src", "packages/shared/src"];

// На Windows `npx` — это `npx.cmd`, и spawnSync без shell не может его найти
// (ENOENT): CreateProcess не умеет исполнять .cmd напрямую, только через
// оболочку. На POSIX (GitHub-раннер до 22.09.2026) `npx` — обычный
// исполняемый файл, `shell: true` там не нужен, но и не мешает. Тот же
// приём уже есть в scripts/precheck.mjs (needsShell).
const run = spawnSync(
  "npx",
  ["depcruise", "--config", ".dependency-cruiser.cjs", "--output-type", "json", ...TARGETS],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" }
);

if (run.error) {
  console.error("Не удалось запустить dependency-cruiser:", run.error.message);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  // Депкрузер упал раньше, чем напечатал отчёт: показать его же вывод, а не
  // молча «проверка прошла».
  console.error(run.stdout);
  console.error(run.stderr);
  console.error("dependency-cruiser не вернул отчёт в JSON — см. вывод выше.");
  process.exit(1);
}

const violations = report.summary?.violations ?? [];
const errors = violations.filter((v) => v.rule?.severity === "error");
const warnings = violations.length - errors.length;

const baseline = JSON.parse(readFileSync(".dependency-cruiser-baseline.json", "utf8")).known ?? [];
const key = (v) => `${v.rule?.name ?? v.rule}|${v.from}|${v.to}`;
const knownKeys = new Set(baseline.map(key));

const fresh = errors.filter((v) => !knownKeys.has(key(v)));
const seenKeys = new Set(errors.map(key));
const gone = baseline.filter((v) => !seenKeys.has(key(v)));

console.log(
  `Модулей: ${report.summary?.totalCruised ?? "?"}, нарушений: ${violations.length} ` +
    `(ошибок ${errors.length}, предупреждений ${warnings}).`
);

for (const v of errors.filter((e) => knownKeys.has(key(e)))) {
  console.log(`  известная, ждёт развязки: ${v.rule.name}  ${v.from} → ${v.to}`);
}

for (const v of gone) {
  console.log(`  РАЗВЯЗАНО: ${v.rule}  ${v.from} → ${v.to}`);
  console.log("    убери эту строку из .dependency-cruiser-baseline.json — список должен укорачиваться");
}

if (fresh.length > 0) {
  console.error("");
  console.error(`НОВЫЕ нарушения правил зависимостей: ${fresh.length}`);
  for (const v of fresh) {
    console.error(`  ${v.rule.name}  ${v.from} → ${v.to}`);
    if (v.cycle) console.error(`    круг: ${v.cycle.map((c) => c.name ?? c).join(" → ")}`);
    if (v.rule.comment) console.error(`    ${v.rule.comment.split("\n")[0]}`);
  }
  console.error("");
  console.error("Почему это важно: цикл импортов делает порядок инициализации неявным");
  console.error("(так у нас однажды упал дашборд), а серверный модуль в браузерном бандле");
  console.error("тянет за собой Prisma и логику прав. Правила: .dependency-cruiser.cjs");
  process.exit(1);
}

console.log("Новых нарушений нет.");
