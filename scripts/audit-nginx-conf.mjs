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

console.log("apps/web/nginx.conf: типов не глушит — ok");
