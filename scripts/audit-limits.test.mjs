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

import { checkServerSource, checkWebSource, evalBytes, parseLimit } from "./audit-limits.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const MB = 1024 * 1024;
const CEILING = 90 * MB;

const LIMITS = `const MB = 1024 * 1024;\nexport const PROXY_SINGLE_REQUEST_MAX_BYTES = 90 * MB;\n`;
const DOOR = `import multer from "multer";
export function guardedUpload(options) { return multer(options); }
export const upload = guardedUpload({
  name: "upload",
  maxRequestBytes: PROXY_SINGLE_REQUEST_MAX_BYTES,
  limits: { fileSize: 30 * 1024 * 1024, files: 30 },
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
const server = (source, isDoorFile = false) => checkServerSource(source, { file: "x.ts", ceiling: CEILING, isDoorFile });

test("evalBytes: числа, MB и потолок; непонятное — null", () => {
  assert.equal(evalBytes("300 * 1024 * 1024", CEILING), 300 * MB);
  assert.equal(evalBytes("PROXY_SINGLE_REQUEST_MAX_BYTES", CEILING), CEILING);
  assert.equal(evalBytes("90 * MB", 0), 90 * MB);
  assert.equal(evalBytes("SOME_CONST", CEILING), null);
  assert.equal(evalBytes("process.exit(1)", CEILING), null);
});

test("parseLimit: строки express", () => {
  assert.equal(parseLimit("32mb"), 32 * MB);
  assert.equal(parseLimit("1gb"), 1024 * MB);
  assert.equal(parseLimit("100kb"), 100 * 1024);
  assert.equal(parseLimit("много"), null);
});

test("guardedUpload выше потолка без причины — красный; с причиной — исключение", () => {
  const over = `const a = guardedUpload({ name: "big", maxRequestBytes: 300 * 1024 * 1024, limits: { fileSize: 1 } });`;
  assert.equal(server(over).problems.length, 1);
  const excused = `const a = guardedUpload({ name: "big", maxRequestBytes: 300 * 1024 * 1024, overProxyCeilingReason: "бот ходит напрямую на origin, мимо Cloudflare" });`;
  const r = server(excused);
  assert.equal(r.problems.length, 0);
  assert.equal(r.exceptions[0].name, "big");
  // Причина-отписка не считается.
  const lazy = `const a = guardedUpload({ name: "big", maxRequestBytes: 300 * 1024 * 1024, overProxyCeilingReason: "надо" });`;
  assert.equal(server(lazy).problems.length, 1);
});

test("guardedUpload без maxRequestBytes или с непонятным выражением — красный", () => {
  assert.equal(server(`guardedUpload({ name: "a", limits: { fileSize: 1 } })`).problems.length, 1);
  assert.equal(server(`guardedUpload({ name: "a", maxRequestBytes: SOMETHING })`).problems.length, 1);
  // maxRequestBytes во вложенном объекте не засчитывается за верхний уровень.
  assert.equal(server(`guardedUpload({ name: "a", limits: { maxRequestBytes: 1 } })`).problems.length, 1);
});

test("multer( вне двери — красный; в двери — один раз", () => {
  assert.equal(server(`const u = multer({ storage });`).problems.length, 1);
  assert.equal(server(`// multer({}) в комментарии не вызов\nconst t = "multer(";`).problems.length, 0);
  assert.equal(server(`multer(a); multer(b);`, true).problems.length, 1);
});

test("express.raw выше потолка или не строкой — красный", () => {
  assert.equal(server(`app.use(express.raw({ type: () => true, limit: "32mb" }));`).problems.length, 0);
  assert.equal(server(`app.use(express.raw({ type: () => true, limit: "200mb" }));`).problems.length, 1);
  assert.equal(server(`app.use(express.json({ limit: LIMIT }));`).problems.length, 1);
});

test("экран: FormData через XMLHttpRequest без проверки веса — красный", () => {
  const bad = `const f = new FormData(); const x = new XMLHttpRequest(); x.send(f);`;
  assert.equal(checkWebSource(bad).length, 1);
  assert.equal(checkWebSource(`assertFitsSingleRequest(f);\n${bad}`).length, 0);
  assert.equal(checkWebSource(`const f = new FormData(); api("/x", { body: f });`).length, 0);
});

test("весь прогон: чисто — зелёный; внесли поломку — красный с именем файла", () => {
  const clean = run(repo({}));
  assert.equal(clean.status, 0, clean.stderr);

  const broken = run(
    repo({
      "apps/api/src/routes/videos.ts": `const v = guardedUpload({ name: "videoUpload", maxRequestBytes: 700 * 1024 * 1024 });\n`,
    })
  );
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /apps\/api\/src\/routes\/videos\.ts:1 {2}videoUpload/);

  const web = run(repo({ "apps/web/src/lib/send.ts": `const f = new FormData();\nconst x = new XMLHttpRequest();\n` }));
  assert.equal(web.status, 1);
  assert.match(web.stderr, /apps\/web\/src\/lib\/send\.ts:1/);
});
