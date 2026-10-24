#!/usr/bin/env node
// node --test scripts/agent-stand-links.test.mjs
//
// ЗАЩИТА НАПРАВЛЕНИЯ ССЫЛОК @royal-home/shared (п.3 tooling-reliability-17-09).
//
// Встроенный `node:test`, а не vitest: файл лежит в корне репозитория рядом со
// скриптом, а не в apps/api или apps/web, где уже настроен vitest. Заводить
// отдельный конфиг vitest ради одного файла в scripts/ — лишняя сущность;
// `node --test` не требует конфигурации вовсе.
//
// Junction на Windows создаём через `fs.symlinkSync(target, path, "junction")`
// (mklink /J из cmd тут не нужен — тестам не нужна отдельная копия node_modules,
// только пустые каталоги).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as stand from "./agent-stand.mjs";

import { linkTargetRealpath, expectedSharedTarget, checkLinkDirections, linkSharedOverride } from "./agent-stand.mjs";

test("stand resolves dependencies from its own Git primary checkout, including worktrees with spaces", () => {
  const temp = mkdtempSync(path.join(tmpdir(), "crm public stand "));
  const main = path.join(temp, "public source");
  const worktree = path.join(temp, "audit worktree");
  mkdirSync(main);
  const git = (args) => execFileSync("git", args, { cwd: main, stdio: "pipe" });
  try {
    git(["init", "--initial-branch=main"]);
    git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "core.hooksPath=" + path.join(temp, "hooks"), "commit", "--allow-empty", "-m", "test"]);
    git(["worktree", "add", "-b", "audit", worktree]);
    assert.equal(typeof stand.resolveMainTree, "function", "stand must resolve the active repository instead of the archived hardcoded D:/CRM");
    assert.equal(stand.resolveMainTree(main), main);
    assert.equal(stand.resolveMainTree(worktree), main);
    assert.throws(() => stand.resolveMainTree(temp), /git|repository|репозитори/i, "no fallback to a foreign archive when outside Git");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), "rh-stand-link-test-"));
  mkdirSync(path.join(root, "packages", "shared"), { recursive: true });
  for (const app of ["web", "api"]) {
    mkdirSync(path.join(root, "apps", app, "node_modules", "@royal-home"), { recursive: true });
  }
  return root;
}

test("linkTargetRealpath: настоящий каталог — не ссылка, возвращает null", () => {
  const root = makeTree();
  try {
    assert.equal(linkTargetRealpath(path.join(root, "packages", "shared")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkTargetRealpath: junction — возвращает разрешённый путь цели", () => {
  const root = makeTree();
  try {
    const link = path.join(root, "apps", "web", "node_modules", "@royal-home", "shared");
    const target = path.join(root, "packages", "shared");
    symlinkSync(target, link, "junction");
    const resolved = linkTargetRealpath(link);
    assert.equal(path.resolve(resolved), path.resolve(target));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("checkLinkDirections: на реальном дереве, где запущен тест, возвращает массив без брошенных исключений", () => {
  // Не подделываем ROOT/MAIN_TREE (они читаются один раз при импорте модуля из
  // process.argv/import.meta.url) — просто проверяем, что функция вообще
  // отрабатывает и отдаёт список, а не падает. Само отсутствие проблем на
  // текущем дереве проверяется вручную командой `node scripts/agent-stand.mjs
  // check` (см. отчёт задания) — она использует эту же функцию.
  const problems = checkLinkDirections();
  assert.ok(Array.isArray(problems));
});

test("linkSharedOverride: ссылка, указывающая на ЧУЖОЕ дерево — отказ, не переписывание", () => {
  const root = makeTree();
  const otherRoot = makeTree(); // имитация packages/shared другого worktree
  try {
    const link = path.join(root, "apps", "web", "node_modules", "@royal-home", "shared");
    // Ссылка уже существует и указывает НЕ на root/packages/shared, а на чужой каталог —
    // ровно ловушка 15.09 (главное дерево получило ссылку на packages/shared чужого worktree).
    symlinkSync(path.join(otherRoot, "packages", "shared"), link, "junction");

    assert.throws(
      () => linkSharedOverride(link, root),
      /уже указывает на/,
      "должен отказаться и НЕ переписать чужую ссылку молча"
    );

    // Проверяем, что она действительно НЕ переписана (осталась указывать на чужое дерево).
    const stillPointsElsewhere = linkTargetRealpath(link);
    assert.equal(path.resolve(stillPointsElsewhere), path.resolve(expectedSharedTarget(otherRoot)));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("linkSharedOverride: ссылки ещё нет — создаёт и указывает на своё дерево", () => {
  const root = makeTree();
  try {
    const link = path.join(root, "apps", "api", "node_modules", "@royal-home", "shared");
    const result = linkSharedOverride(link, root);
    assert.equal(result, "создана");
    const resolved = linkTargetRealpath(link);
    assert.equal(path.resolve(resolved), path.resolve(expectedSharedTarget(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linkSharedOverride: повторный вызов на верной ссылке — no-op, не бросает", () => {
  const root = makeTree();
  try {
    const link = path.join(root, "apps", "api", "node_modules", "@royal-home", "shared");
    linkSharedOverride(link, root);
    const second = linkSharedOverride(link, root);
    assert.equal(second, "уже есть, указывает верно");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
