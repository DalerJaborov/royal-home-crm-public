#!/usr/bin/env node
// node --test scripts/audit-fetch-timeout.test.mjs   (входит в npm run test:scripts)
//
// Сторож «fetch без таймаута» (scripts/audit-fetch-timeout.mjs, охота 14.11.2026, №12):
// разбор текста чистыми функциями и поведение целиком в одноразовом «репозитории»:
// внесли вызов без signal, сторож обязан покраснеть; добавили signal или пометку, позеленеть.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findUnguardedFetches, maskComments } from "./audit-fetch-timeout.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-fetch-timeout-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const name of ["audit-fetch-timeout.mjs", "audit-vi-mock.mjs"]) copyFileSync(path.join(SCRIPTS, name), path.join(dir, "scripts", name));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [path.join(dir, "scripts", "audit-fetch-timeout.mjs")], { encoding: "utf8" });

test("вызов с signal проходит, без него ловится", () => {
  assert.deepEqual(findUnguardedFetches("await fetch(url, { signal: AbortSignal.timeout(5000) });"), []);
  assert.deepEqual(findUnguardedFetches("await fetch(url, { ...init, signal });"), []);
  const bad = findUnguardedFetches("const a = 1;\nawait fetch(url, { method: 'POST' });");
  assert.equal(bad.length, 1);
  assert.equal(bad[0].line, 2);
});

test("fetcher( и aws.fetch( ловятся так же; .fetch( у чужого объекта и имена с fetch внутри не трогаем", () => {
  assert.equal(findUnguardedFetches("await fetcher(url, {});").length, 1);
  assert.equal(findUnguardedFetches("await aws.fetch(url, {});").length, 1);
  assert.equal(findUnguardedFetches("await fetchFacebookPublish(url, { method: 'POST' });").length, 1);
  assert.deepEqual(findUnguardedFetches("await client.fetch(url, {});"), []);
  assert.deepEqual(findUnguardedFetches("await fetchWithRetry(url, {});"), []);
  assert.deepEqual(findUnguardedFetches("export async function fetchFacebookPublish(url, init) {}"), []);
});

test("fetch() в комментарии и в строке не вызов; пометка-исключение работает", () => {
  assert.deepEqual(findUnguardedFetches("// браузерный fetch() прячет заголовки\nconst x = 1;"), []);
  assert.deepEqual(findUnguardedFetches("/* fetch(url) */ const x = 1;"), []);
  assert.deepEqual(findUnguardedFetches('const s = "fetch(url)";'), []);
  assert.deepEqual(findUnguardedFetches("// fetch-timeout: allow signal задан в request выше\nawait fetch(url, request);"), []);
  assert.deepEqual(findUnguardedFetches("await fetch(url, request); // fetch-timeout: allow signal в request"), []);
});

test("maskComments сохраняет позиции", () => {
  const src = "a // b\nc /* d\ne */ f";
  assert.equal(maskComments(src).length, src.length);
  assert.equal(maskComments(src).split("\n").length, src.split("\n").length);
});

test("в одноразовом репозитории: внесли вызов без таймаута, красный; с signal, зелёный", () => {
  const dir = repo({ "apps/api/src/lib/ok.ts": "await fetch(u, { signal: AbortSignal.timeout(1000) });\n" });
  try {
    assert.equal(run(dir).status, 0);
    writeFileSync(path.join(dir, "apps/api/src/lib/broken.ts"), "export const go = () => fetch(u, { method: 'GET' });\n");
    const red = run(dir);
    assert.equal(red.status, 1);
    assert.match(red.stderr, /broken\.ts:1/);
    writeFileSync(path.join(dir, "apps/api/src/lib/broken.ts"), "export const go = () => fetch(u, { method: 'GET', signal: AbortSignal.timeout(1000) });\n");
    assert.equal(run(dir).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("настоящий apps/api/src чист (иначе сторож в precheck красный)", () => {
  const real = spawnSync(process.execPath, [path.join(SCRIPTS, "audit-fetch-timeout.mjs")], { encoding: "utf8" });
  assert.equal(real.status, 0, real.stderr);
});
