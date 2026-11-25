#!/usr/bin/env node
// node --test scripts/audit-limits.test.mjs   (входит в npm run test:scripts)
//
// Сторож «большой файл одним запросом» (scripts/audit-limits.mjs, 17.11.2026): чистые функции
// разбора и поведение целиком в одноразовом «репозитории». Внесли поломку — обязан покраснеть;
// убрали — позеленеть. Зелёный прогон одинаково выглядит и когда всё хорошо, и когда сломан
// сам сторож, поэтому каждое правило проверено именно поломкой.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkCaddyBodyTimeout,
  checkCaddyMaxSize,
  checkNginxPartLocation,
  checkNodeTimeouts,
  checkServerSource,
  checkWebSource,
  collectConstants,
  evalBytes,
  parseCaddySize,
  parseDurationSeconds,
  parseLimit,
} from "./audit-limits.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
const CEILING = 90 * MB;

const LIMITS = `const MB = 1024 * 1024;\nexport const PROXY_SINGLE_REQUEST_MAX_BYTES = 90 * MB;\nexport const PHOTO_MAX_BYTES = 20 * MB;\n`;
const DOOR = `import multer from "multer";
export function guardedUpload(options) { return multer(options); }
export const upload = guardedUpload({
  name: "upload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  limits: { fileSize: 30 * 1024 * 1024, files: 3 },
});
`;

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-audit-limits-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const name of ["audit-limits.mjs", "audit-fetch-timeout.mjs", "audit-vi-mock.mjs"]) {
    copyFileSync(path.join(SCRIPTS, name), path.join(dir, "scripts", name));
  }
  const all = {
    "packages/shared/src/uploadLimits.ts": LIMITS,
    "apps/api/src/upload.ts": DOOR,
    "apps/web/src/lib/api.ts": "export const x = 1;\n",
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [path.join(dir, "scripts", "audit-limits.mjs")], { encoding: "utf8" });
const shared = collectConstants(LIMITS);
const server = (source, isDoorFile = false) => checkServerSource(source, { file: "x.ts", ceiling: CEILING, isDoorFile, sharedConstants: shared });
const door = (fields) => `const d = guardedUpload({ name: "d", ${fields} });`;
const REASON = "экран режет пачки по весу и проверяет до отправки";

test("evalBytes: числа, MB и потолок, константы; непонятное — null", () => {
  assert.equal(evalBytes("300 * 1024 * 1024", CEILING), 300 * MB);
  assert.equal(evalBytes("PROXY_SINGLE_REQUEST_MAX_BYTES", CEILING), CEILING);
  assert.equal(evalBytes("90 * MB", 0), 90 * MB);
  assert.equal(evalBytes("PHOTO_MAX_BYTES * 2", CEILING, shared), 40 * MB);
  assert.equal(evalBytes("SOME_CONST", CEILING), null);
  assert.equal(evalBytes("process.exit(1)", CEILING), null);
});

test("parseLimit: строки express", () => {
  assert.equal(parseLimit("32mb"), 32 * MB);
  assert.equal(parseLimit("1gb"), 1024 * MB);
  assert.equal(parseLimit("100kb"), 100 * 1024);
  assert.equal(parseLimit("много"), null);
});

test("maxRequestBytes выше потолка без причины — красный; с причиной — исключение; отписка не считается", () => {
  assert.equal(server(door(`maxRequestBytes: 300 * 1024 * 1024, limits: { fileSize: 1, files: 1 }`)).problems.length, 1);
  const r = server(door(`maxRequestBytes: 300 * 1024 * 1024, overProxyCeilingReason: "бот ходит напрямую на origin, мимо Cloudflare", limits: { fileSize: 1, files: 1 }`));
  assert.equal(r.problems.length, 0);
  assert.equal(r.exceptions[0].name, "d");
  assert.equal(server(door(`maxRequestBytes: 300 * 1024 * 1024, overProxyCeilingReason: "надо", limits: { fileSize: 1, files: 1 }`)).problems.length, 1);
});

test("нет maxRequestBytes, непонятное выражение, вложенный ключ — красный; общая константа — разбирается", () => {
  assert.equal(server(door(`limits: { fileSize: 1, files: 1 }`)).problems.length, 1);
  assert.equal(server(door(`maxRequestBytes: SOMETHING, limits: { fileSize: 1, files: 1 }`)).problems.length, 1);
  assert.equal(server(door(`limits: { maxRequestBytes: 1, fileSize: 1, files: 1 }`)).problems.length, 1);
  assert.equal(server(door(`maxRequestBytes: PHOTO_MAX_BYTES, limits: { fileSize: PHOTO_MAX_BYTES, files: 1 }`)).problems.length, 0);
});

test("fileSize больше maxRequestBytes — красный", () => {
  assert.equal(server(door(`maxRequestBytes: 10 * MB, limits: { fileSize: 20 * MB, files: 1 }`)).problems.length, 1);
});

test("fileSize × files больше maxRequestBytes — красный; без files — тоже; с batchFitsReason — исключение", () => {
  assert.equal(server(door(`maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES, limits: { fileSize: PHOTO_MAX_BYTES, files: 10 }`)).problems.length, 1);
  assert.equal(server(door(`maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES, limits: { fileSize: PHOTO_MAX_BYTES }`)).problems.length, 1);
  const r = server(door(`maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES, batchFitsReason: "${REASON}", limits: { fileSize: PHOTO_MAX_BYTES, files: 10 }`));
  assert.equal(r.problems.length, 0);
  assert.match(r.exceptions[0].reason, /пачка/);
  assert.equal(server(door(`maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES, limits: { fileSize: 18 * MB, files: 5 }`)).problems.length, 0);
});

test("multer( вне двери — красный; в двери — один раз; в комментарии и строке — не вызов", () => {
  assert.equal(server(`const u = multer({ storage });`).problems.length, 1);
  assert.equal(server(`// multer({}) в комментарии не вызов\nconst t = "multer(";`).problems.length, 0);
  assert.equal(server(`multer(a); multer(b);`, true).problems.length, 1);
});

test("парсеры тела: express.raw, bodyParser, import { raw } и псевдоним — выше потолка или не строкой красный", () => {
  assert.equal(server(`app.use(express.raw({ type: () => true, limit: "32mb" }));`).problems.length, 0);
  assert.equal(server(`app.use(express.raw({ type: () => true, limit: "200mb" }));`).problems.length, 1);
  assert.equal(server(`app.use(express.json({ limit: LIMIT }));`).problems.length, 1);
  assert.equal(server(`app.use(bodyParser.raw({ limit: "1gb" }));`).problems.length, 1);
  assert.equal(server(`import express, { raw } from "express";\nr.put("/x", raw({ limit: "200mb" }));`).problems.length, 1);
  assert.equal(server(`import { raw as rawBody } from "express";\nr.put("/x", rawBody({ limit: "500mb" }));`).problems.length, 1);
  assert.equal(server(`import { raw } from "express";\nr.put("/x", raw({ limit: "16mb" }));`).problems.length, 0);
  // Свой raw( без импорта из express — не парсер тела.
  assert.equal(server(`const raw = (o) => o;\nraw({ limit: "500mb" });`).problems.length, 0);
});

test("экран: каждая отправка FormData мимо api() — после assertFitsSingleRequest той же формы", () => {
  const xhr = (pre = "", post = "") => `const form = new FormData();\n${pre}const x = new XMLHttpRequest();\nx.send(form);\n${post}`;
  assert.equal(checkWebSource(xhr()).length, 1);
  assert.equal(checkWebSource(xhr("assertFitsSingleRequest(form);\n")).length, 0);
  // Проверка ПОСЛЕ отправки или другой формы не считается — смотрим на каждую отправку.
  assert.equal(checkWebSource(xhr("", "assertFitsSingleRequest(form);\n")).length, 1);
  assert.equal(checkWebSource(`const other = new FormData();\n${xhr("assertFitsSingleRequest(other);\n")}`).length, 1);
  // Голый fetch с формой в теле.
  assert.equal(checkWebSource(`const form = new FormData();\nawait fetch("/x", { method: "POST", body: form });`).length, 1);
  assert.equal(checkWebSource(`const body = new FormData();\nawait fetch("/x", { body });`).length, 1);
  // Свой помощник отправки.
  assert.equal(checkWebSource(`const form = new FormData();\nawait xhrSendAuthed("POST", "/x", form);`).length, 1);
  // api() и sendToClient() проверяют вес сами.
  assert.equal(checkWebSource(`const form = new FormData();\nawait api("/x", { method: "POST", body: form });`).length, 0);
  assert.equal(checkWebSource(`const form = new FormData();\nawait sendToClient(intent, "/x", form);`).length, 0);
  // Форма прямо в отправке — проверить нечем.
  assert.equal(checkWebSource(`x.send(new FormData());`).length, 1);
});

test("весь прогон: чисто — зелёный; внесли поломку — красный с именем файла", () => {
  const clean = run(repo({}));
  assert.equal(clean.status, 0, clean.stderr);

  const broken = run(
    repo({
      "apps/api/src/routes/videos.ts": `const v = guardedUpload({ name: "videoUpload", maxRequestBytes: 700 * 1024 * 1024, limits: { fileSize: 1, files: 1 } });\n`,
    })
  );
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /apps\/api\/src\/routes\/videos\.ts:1 {2}videoUpload/);

  const batch = run(repo({ "apps/api/src/routes/photos.ts": `const p = guardedUpload({ name: "photoPost", maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES, limits: { fileSize: PHOTO_MAX_BYTES, files: 10 } });\n` }));
  assert.equal(batch.status, 1);
  assert.match(batch.stderr, /photoPost: дверь обещает 10 × 20 МБ = 200 МБ/);

  const web = run(repo({ "apps/web/src/lib/send.ts": `const f = new FormData();\nconst x = new XMLHttpRequest();\nx.send(f);\n` }));
  assert.equal(web.status, 1);
  assert.match(web.stderr, /apps\/web\/src\/lib\/send\.ts:3/);
});

test("правило 5: read_body — потолок на всё тело; часть 8 МБ на 300 Кбит/с ×2 = 448 с (25.11.2026)", () => {
  const PART = 8 * MB;
  const site = (readBody, maxSize = "25MB") =>
    `{\n\tservers {\n\t\ttimeouts {\n\t\t\tread_body ${readBody}\n\t\t}\n\t}\n}\ncrm.example {\n\trequest_body {\n\t\tmax_size ${maxSize}\n\t}\n}\n`;
  // Живой случай 1: 10s — красный, с номером строки.
  const broken = checkCaddyBodyTimeout(site("10s"), { partBytes: PART });
  assert.equal(broken.length, 1);
  assert.equal(broken[0].line, 4);
  assert.match(broken[0].problem, /read_body 10s короче 448 с/);
  // Живой случай 2: 5m хватало на 1 Мбит/с, но не на 300 Кбит/с — теперь красный.
  assert.equal(checkCaddyBodyTimeout(site("5m"), { partBytes: PART }).length, 1);
  assert.equal(checkCaddyBodyTimeout(site("447s"), { partBytes: PART }).length, 1);
  assert.equal(checkCaddyBodyTimeout(site("448s"), { partBytes: PART }).length, 0);
  assert.equal(checkCaddyBodyTimeout(site("10m"), { partBytes: PART }).length, 0);
  // Тяжёлое одиночное тело: 95 МиБ на 1 Мбит/с ≈ 797 с — 10m мало, 15m хватает.
  assert.equal(checkCaddyBodyTimeout(site("10m", "95MiB"), { partBytes: PART }).length, 1);
  assert.equal(checkCaddyBodyTimeout(site("15m", "95MiB"), { partBytes: PART }).length, 0);
  // Без max_size мерилом служит часть.
  assert.equal(checkCaddyBodyTimeout(`read_body 400s\n`, { partBytes: PART }).length, 1);
  // Строка в комментарии не считается; read_body не задан — потолка нет.
  assert.equal(checkCaddyBodyTimeout(`# read_body 1s\nmax_size 25MB\n`, { partBytes: PART }).length, 0);
  // Непонятная запись — красный, а не тихий пропуск.
  assert.equal(checkCaddyBodyTimeout(`read_body {$X}\n`, { partBytes: PART }).length, 1);
  assert.equal(parseDurationSeconds("1m30s"), 90);
  assert.equal(parseDurationSeconds("500ms"), 0.5);
  assert.equal(parseCaddySize("25MB"), 25_000_000);
  assert.equal(parseCaddySize("8MiB"), PART);
});

// Минимальный «хороший» шаблон Caddy и nginx для поведения целиком.
const GOOD_CADDY = (rb = "15m", maxSize = "95MiB", errors = true) =>
  `{\n\tservers {\n\t\ttimeouts {\n\t\t\tread_body ${rb}\n\t\t}\n\t}\n}\ncrm.example.tj {\n\trequest_body {\n\t\tmax_size ${maxSize}\n\t}\n` +
  (errors ? `\thandle_errors {\n\t\theader Content-Type "application/json; charset=utf-8"\n\t\trespond \`{"code":"PROXY_{http.error.status_code}"}\` 502\n\t}\n` : "") +
  `}\n`;
const STUBS = (omit = "") =>
  [408, 413, 502, 503, 504]
    .filter((c) => String(c) !== omit)
    .map(
      (c) =>
        `location @proxy_${c} {\n  default_type application/json;\n  return ${c} '{"code":"PROXY_${c}","message":"Текст","retryable":${c === 413 ? "false" : "true"}}';\n}\n`
    )
    .join("");
const EP = [408, 413, 502, 503, 504].map((c) => `  error_page ${c} @proxy_${c};\n`).join("");
const PARTS_LOC = (extra = {}) => {
  const o = {
    buffering: "  proxy_request_buffering off;\n",
    http: "  proxy_http_version 1.1;\n",
    size: "  client_max_body_size 10m;\n",
    bodyTimeout: "  client_body_timeout 120s;\n",
    timeouts: "  proxy_read_timeout 120s;\n  proxy_send_timeout 300s;\n",
    ...extra,
  };
  return (
    `location ~ "^/api/v1/(upload-sessions/[^/]+|properties/[^/]+/videos/upload-sessions/[^/]+|properties/drafts/current/videos/[^/]+)/parts/[0-9]+$" {\n  proxy_pass $api_upstream;\n` +
    Object.values(o).join("") +
    EP +
    `}\n`
  );
};
const GOOD_NGINX = (parts = PARTS_LOC(), stubs = STUBS(), apiSize = "100m") =>
  `server {\n location /api/ {\n  proxy_pass $api_upstream;\n  client_max_body_size ${apiSize};\n${EP} }\n${parts}${stubs}}\n`;
const PART = 8 * MB;

test("правило 6: PUT частей — свой location без буферизации тела (25.11.2026)", () => {
  assert.equal(checkNginxPartLocation(GOOD_NGINX(), { partBytes: PART }).length, 0);
  const bad = (loc) => checkNginxPartLocation(GOOD_NGINX(loc), { partBytes: PART });
  assert.match(bad(PARTS_LOC({ buffering: "" }))[0].problem, /proxy_request_buffering off/);
  assert.match(bad(PARTS_LOC({ http: "" }))[0].problem, /proxy_http_version 1\.1/);
  assert.match(bad(PARTS_LOC({ size: "  client_max_body_size 4m;\n" }))[0].problem, /меньше части 8 МБ/);
  assert.match(bad(PARTS_LOC({ size: "  client_max_body_size 64m;\n" }))[0].problem, /express\.raw/);
  assert.match(bad(PARTS_LOC({ size: "" }))[0].problem, /client_max_body_size/);
  assert.match(bad(PARTS_LOC({ bodyTimeout: "" }))[0].problem, /client_body_timeout/);
  assert.match(bad(PARTS_LOC({ timeouts: "" }))[0].problem, /proxy_read_timeout/);
  // Части снова под общим /api/ — красный.
  assert.match(checkNginxPartLocation(GOOD_NGINX(""), { partBytes: PART })[0].problem, /нет location для PUT частей/);
  // Забыли одно из трёх семейств адресов — красный.
  const noDraft = PARTS_LOC().replace("|properties/drafts/current/videos/[^/]+", "");
  assert.match(checkNginxPartLocation(GOOD_NGINX(noDraft), { partBytes: PART })[0].problem, /drafts\/current\/videos/);
  // Часть 4 МБ (волна B): запас 10m всё ещё проходит; часть 12 МБ — 10m мало? нет, 10m < 12 МБ → красный.
  assert.equal(checkNginxPartLocation(GOOD_NGINX(), { partBytes: 4 * MB }).length, 0);
  assert.equal(checkNginxPartLocation(GOOD_NGINX(), { partBytes: 12 * MB }).length, 1);
});

test("правило 7: Caddy max_size не ниже потолка одиночного запроса и не выше nginx (25.11.2026)", () => {
  const ng = 100 * MB;
  assert.equal(checkCaddyMaxSize(GOOD_CADDY(), { ceiling: CEILING, nginxApiLimit: ng }).length, 0);
  const low = checkCaddyMaxSize(GOOD_CADDY("15m", "25MB"), { ceiling: CEILING, nginxApiLimit: ng });
  assert.equal(low.length, 1);
  assert.match(low[0].problem, /ниже потолка одиночного запроса 90 МБ/);
  assert.equal(checkCaddyMaxSize(GOOD_CADDY("15m", "200MiB"), { ceiling: CEILING, nginxApiLimit: ng }).length, 1);
  // Другой сайт (royalhome.tj, 10MB) правило не трогает.
  const other = GOOD_CADDY() + `royalhome.tj {\n\trequest_body {\n\t\tmax_size 10MB\n\t}\n}\n`;
  assert.equal(checkCaddyMaxSize(other, { ceiling: CEILING, nginxApiLimit: ng }).length, 0);
});

test("правило 8: ответы-заглушки в JSON у nginx и Caddy (25.11.2026)", () => {
  // Нет handle_errors у Caddy.
  const c = checkCaddyMaxSize(GOOD_CADDY("15m", "95MiB", false), { ceiling: CEILING });
  assert.match(c[0].problem, /handle_errors/);
  // Нет одной заглушки nginx.
  assert.match(checkNginxPartLocation(GOOD_NGINX(PARTS_LOC(), STUBS("504")), { partBytes: PART })[0].problem, /@proxy_504/);
  // Заглушка не JSON.
  const html = STUBS().replaceAll("application/json", "text/html");
  assert.ok(checkNginxPartLocation(GOOD_NGINX(PARTS_LOC(), html), { partBytes: PART }).length >= 5);
  // 413 с retryable true — красный.
  const wrong = STUBS().replace('"PROXY_413","message":"Текст","retryable":false', '"PROXY_413","message":"Текст","retryable":true');
  assert.match(checkNginxPartLocation(GOOD_NGINX(PARTS_LOC(), wrong), { partBytes: PART })[0].problem, /retryable должен быть false/);
  // Прокси-location /api/ без error_page — красный.
  const noEp = GOOD_NGINX().replace(EP, "");
  assert.ok(checkNginxPartLocation(noEp, { partBytes: PART }).some((p) => /error_page 502/.test(p.problem)));
  // /uploads/ error_page не требует.
  const withUploads = GOOD_NGINX() + `location /uploads/ {\n  proxy_pass $api_upstream;\n}\n`;
  assert.equal(checkNginxPartLocation(withUploads, { partBytes: PART }).length, 0);
});

test("правило 9 (мягкое): таймауты Node проверяются, только если заданы явно", () => {
  assert.equal(checkNodeTimeouts("const server = app.listen(4000);\n", { partBytes: PART }).length, 0);
  assert.equal(checkNodeTimeouts("server.requestTimeout = 0;\n", { partBytes: PART }).length, 0);
  assert.equal(checkNodeTimeouts("server.requestTimeout = 600_000;\nserver.headersTimeout = 65_000;\n", { partBytes: PART }).length, 0);
  assert.match(checkNodeTimeouts("server.requestTimeout = 300_000;\n", { partBytes: PART })[0].problem, /короче 448000 мс/);
  assert.match(checkNodeTimeouts("server.requestTimeout = 600000;\nserver.headersTimeout = 700000;\n", { partBytes: PART })[0].problem, /headersTimeout/);
  assert.equal(checkNodeTimeouts("// server.requestTimeout = 1;\n", { partBytes: PART }).length, 0);
});

test("правила 5-9 целиком: нарушение в шаблоне валит прогон, исправление — проходит", () => {
  const limits = `${LIMITS}export const UPLOAD_PART_BYTES = 8 * MB;\n`;
  const files = (over = {}) => ({
    "packages/shared/src/uploadLimits.ts": limits,
    "ops/Caddyfile.example": GOOD_CADDY(),
    "apps/web/nginx.conf": GOOD_NGINX(),
    ...over,
  });
  const ok = run(repo(files()));
  assert.equal(ok.status, 0, ok.stderr);
  // read_body 5m — красный (правило 5).
  const rb = run(repo(files({ "ops/Caddyfile.example": GOOD_CADDY("5m") })));
  assert.equal(rb.status, 1);
  assert.match(rb.stderr, /ops\/Caddyfile\.example:\d+ {2}read_body 5m/);
  // max_size 25MB — красный (правило 7).
  const mx = run(repo(files({ "ops/Caddyfile.example": GOOD_CADDY("15m", "25MB") })));
  assert.equal(mx.status, 1);
  assert.match(mx.stderr, /ниже потолка одиночного запроса/);
  // части без отдельного location — красный (правило 6).
  const np = run(repo(files({ "apps/web/nginx.conf": GOOD_NGINX("") })));
  assert.equal(np.status, 1);
  assert.match(np.stderr, /apps\/web\/nginx\.conf:\d+ {2}нет location для PUT частей/);
  // index.ts без явных таймаутов — пропуск; с коротким requestTimeout — красный (правило 9).
  assert.equal(run(repo(files({ "apps/api/src/index.ts": "const x = 1;\n" }))).status, 0);
  const nt = run(repo(files({ "apps/api/src/index.ts": "server.requestTimeout = 120000;\n" })));
  assert.equal(nt.status, 1);
  assert.match(nt.stderr, /apps\/api\/src\/index\.ts/);
});
