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

test("правило 5: read_body у Caddy — потолок на всё тело; 10s режет часть ролика (25.11.2026)", () => {
  const PART = 8 * MB;
  const site = (readBody, maxSize = "25MB") =>
    `{\n\tservers {\n\t\ttimeouts {\n\t\t\tread_body ${readBody}\n\t\t}\n\t}\n}\ncrm.example {\n\trequest_body {\n\t\tmax_size ${maxSize}\n\t}\n}\n`;
  // Живой случай: 10s — красный, с номером строки.
  const broken = checkCaddyBodyTimeout(site("10s"), { partBytes: PART });
  assert.equal(broken.length, 1);
  assert.equal(broken[0].line, 4);
  assert.match(broken[0].problem, /read_body 10s короче 200 с/);
  // 5m хватает на 25 МБ при 1 Мбит/с (200 с); 3m — нет.
  assert.equal(checkCaddyBodyTimeout(site("5m"), { partBytes: PART }).length, 0);
  assert.equal(checkCaddyBodyTimeout(site("3m"), { partBytes: PART }).length, 1);
  // Без max_size мерилом служит часть загрузки: 8 МиБ ≈ 68 с.
  assert.equal(checkCaddyBodyTimeout(`read_body 60s\n`, { partBytes: PART }).length, 1);
  assert.equal(checkCaddyBodyTimeout(`read_body 70s\n`, { partBytes: PART }).length, 0);
  // Строка в комментарии не считается; read_body не задан — потолка нет.
  assert.equal(checkCaddyBodyTimeout(`# read_body 1s\nmax_size 25MB\n`, { partBytes: PART }).length, 0);
  // Непонятная запись — красный, а не тихий пропуск.
  assert.equal(checkCaddyBodyTimeout(`read_body {$X}\n`, { partBytes: PART }).length, 1);
  assert.equal(parseDurationSeconds("1m30s"), 90);
  assert.equal(parseDurationSeconds("500ms"), 0.5);
  assert.equal(parseCaddySize("25MB"), 25_000_000);
  assert.equal(parseCaddySize("8MiB"), PART);
});

test("правило 5 целиком: шаблон Caddy с read_body 10s валит прогон, 5m — проходит", () => {
  const limits = `${LIMITS}export const UPLOAD_PART_BYTES = 8 * MB;\n`;
  const caddy = (rb) => `{\n\tservers {\n\t\ttimeouts {\n\t\t\tread_body ${rb}\n\t\t}\n\t}\n}\n`;
  const ok = run(repo({ "packages/shared/src/uploadLimits.ts": limits, "ops/Caddyfile.example": caddy("5m") }));
  assert.equal(ok.status, 0, ok.stderr);
  const bad = run(repo({ "packages/shared/src/uploadLimits.ts": limits, "ops/Caddyfile.example": caddy("10s") }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /ops\/Caddyfile\.example:4 {2}read_body 10s/);
});
