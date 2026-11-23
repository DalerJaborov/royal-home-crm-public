#!/usr/bin/env node
/**
 * Не даёт повторить простой прода 14.09.2026: `types { ... }` в контексте
 * server{}/location{} не ДОБАВЛЯЕТ расширение к унаследованной карте MIME —
 * он ПОЛНОСТЬЮ ЕЁ ЗАМЕНЯЕТ. apps/web/nginx.conf содержит только один
 * server{} (без своего http{}), поэтому любой `types {` в этом файле —
 * ровно та ошибка: в тот вечер она стёрла типы для index.html/.js/.css,
 * весь сайт стал отдаваться как application/octet-stream, и вместе с
 * X-Content-Type-Options: nosniff (Caddy) браузер не рендерил и не выполнял
 * ничего — PR #374.
 *
 * Правильный способ добавить MIME для нового расширения — scoped-location:
 *   location ~* \.ext$ { default_type application/что-нужно; }
 * Он не трогает унаследованную карту типов ни для одного другого расширения.
 *
 *   node scripts/audit-nginx-conf.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const CONF_PATH = join(ROOT, "apps", "web", "nginx.conf");

const text = readFileSync(CONF_PATH, "utf8");

// Убираем построчные комментарии перед поиском — иначе этот же файл ловит
// сам себя на упоминаниях `types {` в объяснительных комментариях выше.
// Файл в CRLF: `\r` остаётся в конце каждой строки после split("\n"), а `.`
// в JS-регэкспе `\r` не матчит — якорь `$` тогда никогда не совпадает, и
// `.replace(/#.*$/, "")` молча ничего не убирает. Без `$` `.*` останавливается
// перед `\r` сама, этого достаточно.
const withoutComments = text
  .split("\n")
  .map((line) => line.replace(/#.*/, ""))
  .join("\n");

const match = withoutComments.match(/\btypes\s*\{/);

if (match) {
  const line = withoutComments.slice(0, match.index).split("\n").length;
  console.error(
    `apps/web/nginx.conf:${line}: найден блок \`types { ... }\`.\n\n` +
      "Этот файл — единственный server{} без своего http{}, поэтому любой\n" +
      "`types {}` здесь ПОЛНОСТЬЮ ЗАМЕНЯЕТ унаследованную карту MIME-типов,\n" +
      "а не добавляет к ней расширение. 14.09.2026 это уронило весь прод:\n" +
      "index.html/.js/.css стали отдаваться как application/octet-stream,\n" +
      "и вместе с X-Content-Type-Options: nosniff браузер не рендерил и не\n" +
      "выполнял ничего (PR #374).\n\n" +
      "Вместо этого — scoped location только на нужное расширение:\n" +
      "  location ~* \\.ext$ { default_type application/что-нужно; }\n"
  );
  process.exit(1);
}

// ── Второе правило (16.11.2026, ролик №197) ──────────────────────────────────
// Каждый location с proxy_pass обязан не копить ответ во временном файле:
// `proxy_buffering off;` или `proxy_max_temp_file_size 0;`. Временные файлы nginx
// лежат в tmpfs (/var/cache/nginx), который считается в mem_limit 128m контейнера
// web, — ответ крупнее ~110 МБ туда не влезает, и nginx рвёт соединение посреди
// отдачи. Так Instagram опубликовал ~10 с из ролика 236,8 МБ, а Facebook отказал
// «Unable to fetch video file from URL» (location /uploads/ был без этих строк).
const proxiedLocations = [];
{
  const locRe = /\blocation\b([^{]*)\{/g;
  let m;
  while ((m = locRe.exec(withoutComments))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < withoutComments.length && depth > 0; i++) {
      if (withoutComments[i] === "{") depth++;
      else if (withoutComments[i] === "}") depth--;
    }
    const body = withoutComments.slice(m.index + m[0].length, i - 1);
    if (/\bproxy_pass\b/.test(body)) {
      proxiedLocations.push({
        name: m[1].trim(),
        line: withoutComments.slice(0, m.index).split("\n").length,
        safe: /\bproxy_buffering\s+off\s*;/.test(body) || /\bproxy_max_temp_file_size\s+0\s*;/.test(body),
      });
    }
  }
}

if (proxiedLocations.length === 0) {
  console.error("apps/web/nginx.conf: не найдено ни одного location с proxy_pass — сторож сломан или файл переписан.");
  process.exit(1);
}

const unsafe = proxiedLocations.filter((loc) => !loc.safe);
if (unsafe.length) {
  for (const loc of unsafe) {
    console.error(
      `apps/web/nginx.conf:${loc.line}: \`location ${loc.name}\` проксирует к API, но копит ответ во временном файле.\n` +
        "Временные файлы nginx — в tmpfs внутри mem_limit 128m контейнера web: ответ больше ~110 МБ\n" +
        "обрывается посреди отдачи (16.11.2026: ролик №197 236,8 МБ — Instagram выложил ~10 с,\n" +
        "Facebook «Unable to fetch video file from URL»).\n" +
        "Добавьте в этот location: `proxy_buffering off;` (и для надёжности `proxy_max_temp_file_size 0;`).\n"
    );
  }
  process.exit(1);
}

// ── Третье правило (17.11.2026, аудит скорости P1) ───────────────────────────
// Впереди nginx стоит Caddy, и он шлёт заголовок Via. Без `gzip_proxied any;` nginx
// такие запросы не сжимает вовсе: CSS уходил 696 090 Б вместо 157 553 Б, JSON API —
// тоже несжатым. И наоборот: поток событий (text/event-stream) в gzip_types попасть
// не должен — сжатие копит буфер, и живые обновления CRM приходят пачками с опозданием.
const gzipProblems = [];
if (!/^\s*gzip_proxied\s+any\s*;/m.test(withoutComments)) {
  gzipProblems.push("нет `gzip_proxied any;` — ответы для Caddy/Cloudflare (с заголовком Via) уходят несжатыми");
}
const gzipTypes = [...withoutComments.matchAll(/^\s*gzip_types\s+([^;]*);/gm)].map((m) => m[1].split(/\s+/).filter(Boolean)).flat();
for (const must of ["text/css", "application/javascript", "application/json", "image/svg+xml"]) {
  if (!gzipTypes.includes(must)) gzipProblems.push(`в gzip_types нет ${must}`);
}
if (gzipTypes.includes("text/event-stream") || gzipTypes.includes("*")) {
  gzipProblems.push("text/event-stream (или «*») в gzip_types — поток /api/v1/events начнёт приходить пачками");
}
if (gzipProblems.length) {
  for (const p of gzipProblems) console.error(`apps/web/nginx.conf: ${p}.`);
  process.exit(1);
}

console.log(
  `apps/web/nginx.conf: типов не глушит, ${proxiedLocations.length} прокси-location без временных файлов, сжатие для прокси включено — ok`
);
