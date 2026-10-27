#!/usr/bin/env node
// node --test scripts/sync-main.test.mjs   (он же npm run test:scripts)
//
// Проверка свода `npm run sync:main` (scripts/sync-main.mjs) без сети и без
// настоящей карты: одноразовый репозиторий с локальным «origin», а `npm` в PATH
// подменён заглушкой, которая записывает вызовы в файл и отвечает нулём.
//
// Стережём то, из-за чего свод и написан: КАРТА ОБЯЗАНА ПЕРЕСОБРАТЬСЯ. Первый
// случай ловит регресс 25.09.2026 — выход по конфликту в коде стоял до
// безусловной пересборки, и после ручного разрешения карта не собиралась вовсе.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchOriginMain } from "./read-network-recovery.mjs";

test("fetch recovery repeats only the same remote read and preserves the final error", async () => {
  let time = 0, calls = 0;
  const commands = [];
  const failed = { status: 128, stderr: "Failed to connect to github.com:443 after 21093 ms: Could not connect to server" };
  const run = (command, args, options) => {
    commands.push([command, args]); assert.ok(options.timeout <= 120000 && options.timeout > 0);
    time += 21000; return ++calls < 3 ? failed : { status: 0 };
  };
  const result = await fetchOriginMain({ run, now: () => time, wait: async ms => { time += ms; }, log: () => {} });
  assert.equal(result.status, 0); assert.equal(calls, 3);
  assert.ok(commands.every(([cmd, args]) => cmd === "git" && JSON.stringify(args) === JSON.stringify(["fetch", "origin", "main"])));
  calls = 0; time = 0;
  const exhausted = await fetchOriginMain({ run: () => { calls++; time += 21000; return failed; },
    now: () => time, wait: async ms => { time += ms; }, log: () => {} });
  assert.equal(exhausted, failed); assert.ok(calls <= 5); assert.ok(time <= 120000);
});

test("fetch never retries access, certificate or local-ref failures", async () => {
  for (const stderr of ["remote: Permission denied", "SSL certificate problem: unable to get local issuer certificate", "cannot lock ref refs/remotes/origin/main"]) {
    let calls = 0;
    const result = await fetchOriginMain({ run: () => { calls++; return { status: 128, stderr }; },
      wait: async () => { throw Error("must not wait"); }, log: () => {} });
    assert.equal(result.status, 128); assert.equal(calls, 1);
  }
});
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { splitConflicts } from "./sync-main.mjs";

const SYNC = path.join(path.dirname(fileURLToPath(import.meta.url)), "sync-main.mjs");

test("конфликты делятся на собранные карты и всё остальное", () => {
  assert.deepEqual(splitConflicts(["docs/product-map.md", "apps/api/src/a.ts", "", "docs/product-flows.json"]), {
    generated: ["docs/product-map.md", "docs/product-flows.json"],
    foreign: ["apps/api/src/a.ts"],
  });
  // Повторы схлопываются, «похожий» путь вне docs/product- остаётся человеку.
  assert.deepEqual(splitConflicts(["docs/JOURNAL.md", "docs/JOURNAL.md", "apps/web/product-map.md"]).foreign, [
    "docs/JOURNAL.md",
    "apps/web/product-map.md",
  ]);
});

// ── свод в одноразовом репозитории ──────────────────────────────────────────

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Репозиторий, где main и ветка меняли ОДНУ строку файла вне docs/product-. */
function makeConflictingRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-sync-test-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  sh(dir, "init", "--bare", "-b", "main", origin);
  sh(dir, "clone", "-q", origin, work);
  sh(work, "config", "user.email", "t@t");
  sh(work, "config", "user.name", "t");
  sh(work, "checkout", "-q", "-b", "main");
  writeFileSync(path.join(work, "JOURNAL.md"), "общая строка\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "init");
  sh(work, "push", "-q", "origin", "main");

  sh(work, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(work, "JOURNAL.md"), "строка ветки\n");
  sh(work, "commit", "-q", "-am", "ветка");

  sh(work, "checkout", "-q", "main");
  writeFileSync(path.join(work, "JOURNAL.md"), "строка main\n");
  sh(work, "commit", "-q", "-am", "main");
  sh(work, "push", "-q", "origin", "main");
  sh(work, "checkout", "-q", "feature");

  // Заглушка npm: пишет свои аргументы в файл и выходит нулём. Настоящую карту
  // здесь собирать не из чего, а нам важно, ЗВАЛИ её или нет.
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const calls = path.join(dir, "npm-calls.txt");
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n`);
  chmodSync(path.join(bin, "npm"), 0o755);

  return { dir, work, calls, bin };
}

function runSync(repo, ...args) {
  return spawnSync(process.execPath, [SYNC, ...args], {
    cwd: repo.work,
    encoding: "utf8",
    env: { ...process.env, PATH: `${repo.bin}:${process.env.PATH}` },
  });
}

const canRunShellStub = process.platform !== "win32";

test("конфликт в коде: свод встаёт, называет файл и --continue, карту не трогает", { skip: !canRunShellStub }, () => {
  const repo = makeConflictingRepo();
  try {
    const r = runSync(repo);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /JOURNAL\.md/);
    assert.match(r.stderr, /--continue/);
    // Артефакты вне git устаревают от того же слияния — подсказка про них
    // стоит там же, где человек читает про конфликт.
    assert.match(r.stderr, /prisma generate/);
    // Слияние оставлено как есть — его разводит человек.
    assert.ok(existsSync(path.join(repo.work, ".git", "MERGE_HEAD")), "слияние должно остаться незакоммиченным");
    assert.equal(existsSync(repo.calls), false, "до разрешения конфликта карту собирать не из чего");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("--continue после ручного разрешения: карта пересобирается и сверяется", { skip: !canRunShellStub }, () => {
  const repo = makeConflictingRepo();
  try {
    assert.equal(runSync(repo).status, 1);

    // Человек развёл конфликт и закоммитил слияние.
    writeFileSync(path.join(repo.work, "JOURNAL.md"), "строка main\nстрока ветки\n");
    sh(repo.work, "add", "JOURNAL.md");
    sh(repo.work, "commit", "-q", "--no-edit");

    const r = runSync(repo, "--continue");
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = readFileSync(repo.calls, "utf8").trim().split("\n");
    assert.deepEqual(calls, ["run map", "run map:check"], "хвост свода — пересобрать карту и сверить");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});

test("--continue с неразведённым конфликтом не идёт дальше", { skip: !canRunShellStub }, () => {
  const repo = makeConflictingRepo();
  try {
    assert.equal(runSync(repo).status, 1);
    const r = runSync(repo, "--continue");
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /Доразведи конфликт/);
    assert.equal(existsSync(repo.calls), false, "карту по недоразведённому дереву собирать нельзя");
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
});
