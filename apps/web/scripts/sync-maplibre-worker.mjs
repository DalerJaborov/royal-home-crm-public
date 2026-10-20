#!/usr/bin/env node
/**
 * Копирует воркер тайлов MapLibre и его соседний чанк в `public/vendor/maplibre/`
 * (12.09.2026, блок N плана: карта объектов на MapLibre GL JS).
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ СКРИПТ, А НЕ `?url`-ИМПОРТ. MapLibre грузит воркер через
 * свою `getWorkerUrl()`, а не через `new Worker(new URL(...))`, который Vite
 * умеет разобрать статически и включить в сборку сам. Импорт файла воркера
 * суффиксом `?url` копирует ровно этот один файл — а воркер изнутри
 * импортирует соседний чанк библиотеки (`maplibre-gl-shared.mjs`, разбор
 * тайлов), которого рядом с ним тогда не оказывается: воркер падает на
 * разборе module-импорта без единого сообщения на главном потоке (браузер
 * прячет детали ошибок парсинга внутри воркера — карта просто остаётся
 * пустой, источники GeoJSON вечно висят в состоянии «загружается»).
 *
 * `public/` Vite отдаёt как есть и в dev, и в проде, без хеширования и без
 * анализа зависимостей — то, что здесь и нужно: оба файла лежат рядом друг с
 * другом под теми именами, которые ждёт относительный импорт внутри воркера.
 *
 * ЗАПУСК: node scripts/sync-maplibre-worker.mjs (или npm run sync-maplibre-worker).
 * Перезапускать после каждого обновления версии `maplibre-gl` в package.json —
 * файлы вручную не редактируются и в апстриме не отслеживаются построчно.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "../../../node_modules/maplibre-gl/dist");
const OUT_DIR = path.resolve(here, "../public/vendor/maplibre");

const FILES = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

mkdirSync(OUT_DIR, { recursive: true });
for (const file of FILES) {
  const src = path.join(SRC_DIR, file);
  if (!existsSync(src)) {
    console.error(`Не найден ${src} — проверьте версию maplibre-gl в node_modules.`);
    process.exit(1);
  }
  copyFileSync(src, path.join(OUT_DIR, file));
  console.log(`скопирован ${file}`);
}
