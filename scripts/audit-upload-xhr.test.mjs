#!/usr/bin/env node
// node --test scripts/audit-upload-xhr.test.mjs   (входит в npm run test:scripts)
//
// Сторож «шестая загрузка» (scripts/audit-upload-xhr.mjs): каждое правило проверено
// внесением поломки — новый файл с XHR, рост числа, запись без причины, устаревшая база.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { check, countUploads, maskComments } from "./audit-upload-xhr.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "audit-upload-xhr.mjs");
const XHR = `const xhr = new XMLHttpRequest();\nxhr.upload.onprogress = () => {};\n`;
const REASON = "Очередь карточки объекта — существующая реализация";

function repo(files, baseline) {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-upload-xhr-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, path.join(dir, "scripts", "audit-upload-xhr.mjs"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  writeFileSync(path.join(dir, ".upload-xhr-baseline.json"), JSON.stringify(baseline));
  return dir;
}
const run = (dir) => spawnSync(process.execPath, [path.join(dir, "scripts", "audit-upload-xhr.mjs")], { encoding: "utf8" });

test("комментарий с XMLHttpRequest — не отправка", () => {
  assert.equal(countUploads(`// new XMLHttpRequest()\n/* xhr.upload.onprogress */\n`), 0);
  assert.equal(countUploads(XHR), 2);
  assert.equal(maskComments("a // b\nc").includes("b"), false);
});

test("правила сверки: новый файл, рост, нет причины, устаревшая база", () => {
  const base = { files: { "apps/web/src/lib/a.ts": { count: 2, reason: REASON } } };
  assert.deepEqual(check({ "apps/web/src/lib/a.ts": 2 }, base), []);
  assert.match(check({ "apps/web/src/lib/b.ts": 1 }, base).join("\n"), /Новых реализаций не заводим/);
  assert.match(check({ "apps/web/src/lib/a.ts": 3 }, base).join("\n"), /только убывает/);
  assert.match(check({ "apps/web/src/lib/a.ts": 1 }, base).join("\n"), /уменьшите базу/);
  assert.match(check({}, base).join("\n"), /уменьшите базу/);
  assert.match(check({ "apps/web/src/lib/a.ts": 2 }, { files: { "apps/web/src/lib/a.ts": { count: 2, reason: "" } } }).join("\n"), /нет причины/);
});

test("целиком: зелёный на базе, красный на новой реализации; lib/upload/ и тесты — можно", () => {
  const base = { files: { "apps/web/src/lib/uploadQueue.ts": { count: 2, reason: REASON } } };
  const ok = repo(
    {
      "apps/web/src/lib/uploadQueue.ts": XHR,
      "apps/web/src/lib/upload/xhr.ts": XHR,
      "apps/web/src/lib/__tests__/x.test.ts": XHR,
    },
    base
  );
  assert.equal(run(ok).status, 0, run(ok).stderr);

  const bad = repo({ "apps/web/src/lib/uploadQueue.ts": XHR, "apps/web/src/components/NewUpload.tsx": XHR }, base);
  const r = run(bad);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /NewUpload\.tsx/);
});
