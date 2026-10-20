#!/usr/bin/env node
// node --test scripts/audit-vi-mock.test.mjs   (входит в npm run test:scripts)
//
// Сторож подмен vi.mock без importOriginal (scripts/audit-vi-mock.mjs, №204):
// разбор текста — чистыми функциями, поведение целиком — в одноразовом
// «репозитории» во временной папке, куда копируется сам скрипт.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findMocks, matchParen, narrowMocks } from "./audit-vi-mock.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "audit-vi-mock.mjs");

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-vi-mock-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, path.join(dir, "scripts", "audit-vi-mock.mjs"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const run = (dir, ...args) =>
  spawnSync(process.execPath, [path.join(dir, "scripts", "audit-vi-mock.mjs"), ...args], { encoding: "utf8" });

const MODULE = `export const a = 1;\nexport async function b() {}\nexport type T = string;\nexport function c() {}\n`;
const NARROW = `import { vi } from "vitest";\nvi.mock("../src/mod.js", () => ({ a: 1, b: async () => {} }));\n`;
const WIDE = `import { vi } from "vitest";\nvi.mock("../src/mod.js", async (importOriginal) => ({\n  ...(await importOriginal<typeof import("../src/mod.js")>()),\n  a: 1,\n}));\n`;
const FULL = `import { vi } from "vitest";\nvi.mock("../src/mod.js", () => ({ a: 1, b: vi.fn(), c: vi.fn() }));\n`;

test("разбор скобок: строки, шаблоны и комментарии со скобками не сбивают счёт", () => {
  const s = `f("a)", \`x\${(1)})\`, /* ) */ { k: ")" }) tail`;
  assert.equal(s[matchParen(s, 1)], ")");
  assert.equal(s.slice(matchParen(s, 1) + 1), " tail");
});

test("findMocks: путь и текст фабрики; автоподмена — фабрика null", () => {
  const got = findMocks(`vi.mock("../src/a.js");\nvi.mock('../src/b.js', () => ({ x }));`);
  assert.deepEqual(got.map((g) => [g.path, g.factory === null]), [["../src/a.js", true], ["../src/b.js", false]]);
});

test("узкая подмена найдена и называет недостающие имена; типы не в счёт", () => {
  const dir = repo({ "apps/api/src/mod.ts": MODULE, "apps/api/tests/x.test.ts": NARROW });
  try {
    const got = narrowMocks(path.join(dir, "apps/api/tests/x.test.ts"), NARROW, dir);
    assert.equal(got.length, 1);
    assert.equal(got[0].key, "apps/api/tests/x.test.ts::apps/api/src/mod.ts");
    assert.deepEqual(got[0].missing, ["c"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("importOriginal, полная подмена и пакеты из node_modules не считаются узкими", () => {
  const dir = repo({ "apps/api/src/mod.ts": MODULE });
  try {
    const f = path.join(dir, "apps/api/tests/x.test.ts");
    assert.equal(narrowMocks(f, WIDE, dir).length, 0);
    assert.equal(narrowMocks(f, FULL, dir).length, 0);
    assert.equal(narrowMocks(f, `vi.mock("express", () => ({ x: 1 }));`, dir).length, 0);
    assert.equal(narrowMocks(f, `vi.mock("../src/mod.js");`, dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("сторож: новая узкая подмена валит, известная из базы — нет, --update принимает, правка лечит", () => {
  const dir = repo({
    "apps/api/src/mod.ts": MODULE,
    "apps/api/tests/old.test.ts": NARROW,
  });
  try {
    // базы нет — всё найденное «новое»
    let r = run(dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /old\.test\.ts::apps\/api\/src\/mod\.ts/);
    assert.match(r.stderr, /не отдаёт: c/);

    // --update записывает базу, после неё проверка зелёная
    r = run(dir, "--update");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".vi-mock-baseline.json"), "utf8")).legacy, [
      "apps/api/tests/old.test.ts::apps/api/src/mod.ts",
    ]);
    r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);

    // новая узкая подмена в другом файле — красная, старая не мешает
    writeFileSync(path.join(dir, "apps/api/tests/new.test.ts"), NARROW);
    r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /new\.test\.ts/);
    assert.doesNotMatch(r.stderr, /old\.test\.ts/);

    // тот же файл, но подмена исправлена: зелёно, а в базе запись «можно убрать»
    writeFileSync(path.join(dir, "apps/api/tests/new.test.ts"), WIDE);
    writeFileSync(path.join(dir, "apps/api/tests/old.test.ts"), WIDE);
    r = run(dir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /можно убрать/);
    run(dir, "--update");
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, ".vi-mock-baseline.json"), "utf8")).legacy, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("намеренная узкая подмена принимается только с причиной", () => {
  const dir = repo({ "apps/api/src/mod.ts": MODULE, "apps/api/tests/x.test.ts": NARROW });
  const key = "apps/api/tests/x.test.ts::apps/api/src/mod.ts";
  try {
    writeFileSync(path.join(dir, ".vi-mock-baseline.json"), JSON.stringify({ intentional: { [key]: "глушим модуль целиком: побочные эффекты" }, legacy: [] }));
    assert.equal(run(dir).status, 0);
    writeFileSync(path.join(dir, ".vi-mock-baseline.json"), JSON.stringify({ intentional: { [key]: "  " }, legacy: [] }));
    const r = run(dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /нет причины/);
    // --update не стирает намеренные записи
    writeFileSync(path.join(dir, ".vi-mock-baseline.json"), JSON.stringify({ intentional: { [key]: "причина" }, legacy: [] }));
    run(dir, "--update");
    assert.equal(JSON.parse(readFileSync(path.join(dir, ".vi-mock-baseline.json"), "utf8")).intentional[key], "причина");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
