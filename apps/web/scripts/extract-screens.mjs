#!/usr/bin/env node
/**
 * СПИСОК ВСЕХ ЭКРАНОВ CRM — вторая половина карты обследованного (08.09.2026).
 *
 * Счётчик посещений (lib/screenSeen.ts) отвечает на вопрос «сюда заходили».
 * Чтобы превратить это в ответ на вопрос владельца — «а куда мы НЕ доходили» —
 * нужен второй список: все экраны, которые в приложении вообще есть. Разность и
 * есть искомое.
 *
 * Почему генератором, а не списком руками: список, который надо не забыть
 * дополнить, устаревает в первый же день — и тогда новый экран навсегда
 * останется невидимым для карты, то есть именно там, где вероятность
 * непроверенного кода выше всего.
 *
 * Почему разбором текста, а не импортом роутера: маршруты объявлены в JSX
 * (<Routes> в App.tsx), а не data-роутером, — снаружи их не перечислить, не
 * подняв React. Разбор держится на одном правиле самого React Router: путь
 * дочернего маршрута пишется БЕЗ ведущей косой черты, верхнеуровневого — с ней.
 *
 * Результат кладётся в общий пакет: список нужен и фронту, и серверу (он
 * строит по нему утренний отчёт), а два списка в двух местах разъедутся.
 *
 * Запуск: node apps/web/scripts/extract-screens.mjs
 * CI сверяет, что сгенерированное совпадает с закоммиченным (npm run screens:check).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP_TSX = path.resolve(here, "../src/App.tsx");
const OUT = path.resolve(here, "../../../packages/shared/src/screens.generated.ts");

const source = readFileSync(APP_TSX, "utf8");

/** `path="clients/:id"` — берём и одинарные, и двойные кавычки. */
const PATH_RE = /\bpath=["']([^"']+)["']/;
/**
 * Маршрут-ПЕРЕХОД (`element={<Navigate to=... />}`) — не экран, а обещание не
 * ломать старую ссылку из пуша или закладки (например /hot-clients после
 * удаления раздела «Горячие», решение владельца 09.09.2026). Своего содержимого
 * у него нет, зайти на него нельзя — карта обследованного вечно считала бы его
 * непроверенным разделом.
 */
const REDIRECT_RE = /element=\{\s*<Navigate\b/;

const screens = new Set();

// Индексный маршрут AppLayout — это главная. В разметке у него нет path вовсе.
if (/<Route\s+index\b/.test(source)) screens.add("/");

/**
 * Разбираем по отрезкам между тегами `<Route`: каждый отрезок начинается сразу
 * за своим тегом, поэтому и `path=`, и `element=` в нём принадлежат ЭТОМУ
 * маршруту, а не соседнему. Одной регуляркой по всему тексту это не различить:
 * `[^>]*` останавливается на первом же `>` и до `element=` не доходит.
 */
for (const chunk of source.split("<Route").slice(1)) {
  const match = PATH_RE.exec(chunk);
  if (!match) continue;
  if (REDIRECT_RE.test(chunk)) continue;
  const raw = match[1];
  // Дочерний путь пишется без ведущей косой черты — восстанавливаем полный.
  const full = raw.startsWith("/") ? raw : `/${raw}`;
  // "*" — заглушка «страница не найдена», это не экран.
  if (full === "/*") continue;
  // /dev/* существуют только в дев-сборке (стенды слоёв темы) — на проде их
  // нет, и в карте они выглядели бы вечно необследованными разделами.
  if (full.startsWith("/dev/")) continue;
  screens.add(full);
}

const sorted = [...screens].sort();

const file = `/**
 * СГЕНЕРИРОВАНО: apps/web/scripts/extract-screens.mjs — руками не править.
 *
 * Полный список экранов CRM. Нужен карте обследованного: сервер вычитает из
 * него посещённые (таблица RouteHit) и в утреннем отчёте показывает разность —
 * разделы, куда не заходил никто.
 *
 * Обновляется вместе с App.tsx: добавили маршрут — перегенерируйте
 * (\`npm run screens --workspace=apps/web\`), иначе новый экран будет считаться
 * несуществующим и выпадет из карты.
 */
export const ALL_SCREENS: readonly string[] = [
${sorted.map((s) => `  ${JSON.stringify(s)},`).join("\n")}
];
`;

const previous = (() => {
  try {
    return readFileSync(OUT, "utf8");
  } catch {
    return null;
  }
})();

if (process.argv.includes("--check")) {
  if (previous !== file) {
    console.error(
      "Список экранов устарел: в App.tsx маршруты изменились.\n" +
        "Выполните: npm run screens --workspace=apps/web",
    );
    process.exit(1);
  }
  console.log(`Список экранов актуален (${sorted.length}).`);
  process.exit(0);
}

writeFileSync(OUT, file, "utf8");
console.log(`Экранов записано: ${sorted.length} → ${path.relative(process.cwd(), OUT)}`);
