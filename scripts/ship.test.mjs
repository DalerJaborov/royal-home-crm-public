#!/usr/bin/env node
// node --test scripts/ship.test.mjs   (он же npm run test:scripts)
//
// Проверка команды выката `npm run ship` (scripts/ship.mjs) без GitHub и без
// базы: чистые функции — напрямую, сухой прогон — в одноразовом репозитории
// с локальным «origin», как у настоящего клона.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  shipRuntimeProblem,
  needsFullApiRun,
  badModes,
  newMigrations,
  parseRepo,
  requireFullApiRunPassed,
  requireCloudRunPassed,
  cloudBranch,
  statusDescription,
  shipTrailer,
  snapshotState,
  stateDrift,
  github,
  networkErrorCode,
} from "./ship.mjs";

const SHIP = path.join(path.dirname(fileURLToPath(import.meta.url)), "ship.mjs");

test("известная авария Windows Node 24.0–24.15 блокирует выкат до тестов", () => {
  for (const version of ["v24.0.0", "v24.15.0", "v24.15.1"]) {
    assert.match(shipRuntimeProblem("win32", version), /24\.16\+/);
  }
  for (const version of ["v24.16.0", "v24.19.0", "v25.9.0"]) {
    assert.equal(shipRuntimeProblem("win32", version), null);
  }
  assert.equal(shipRuntimeProblem("linux", "v24.15.0"), null);
  assert.equal(shipRuntimeProblem("darwin", "v24.15.0"), null);
  const source = readFileSync(SHIP, "utf8");
  assert.ok(source.indexOf("if (runtimeProblem) blockers.push(runtimeProblem)") < source.indexOf("stage(4,"));
});

test("ключи разбираются, незнакомый — ошибка, а не молчаливый пропуск", () => {
  assert.deepEqual(parseArgs(["--dry-run", "--no-merge", "--pr=42"]), {
    dryRun: true,
    noMerge: true,
    full: false,
    cleanDb: false,
    localTests: false,
    pr: 42,
    help: false,
  });
  assert.equal(parseArgs(["--local-tests"]).localTests, true);
  assert.throws(() => parseArgs(["--skip-tests"]), /незнакомый ключ/);
  assert.throws(() => parseArgs(["--pr=abc"]), /номер правки/);
});

test("правило пачки: только сайт или только *.test.ts — без полного прогона сервера", () => {
  assert.equal(needsFullApiRun(["apps/web/src/pages/Home.tsx", "docs/journal/x.md"]).full, false);
  assert.equal(needsFullApiRun(["apps/api/tests/lead-carousel.test.ts"]).full, false);
  assert.equal(needsFullApiRun(["scripts/ship.mjs"]).full, false);
});

test("правило пачки: сервер, общая часть, обвязка тестов, зависимости — полный прогон", () => {
  for (const f of [
    "apps/api/src/lib/leads.ts",
    "apps/api/prisma/schema.prisma",
    "apps/api/tests/helpers/waitFor.ts", // обвязка — задевает все тесты
    "apps/api/tests/runParallel.ts",
    "apps/api/vitest.config.ts",
    "packages/shared/src/money.ts",
    "package-lock.json",
    "package.json",
  ]) {
    assert.equal(needsFullApiRun(["apps/web/src/a.tsx", f]).full, true, f);
  }
});

test("ссылки (120000) и вложенные репозитории (160000) ловятся, обычные файлы — нет", () => {
  const raw = [
    ":000000 100644 0000000 1111111 A\tapps/web/src/a.tsx",
    ":100644 120000 2222222 3333333 T\tapps/api/node_modules",
    ":000000 160000 0000000 4444444 A\t.claude/worktrees/agent-1",
    ":120000 100644 5555555 6666666 T\twas-link-now-file.txt",
  ].join("\n");
  assert.deepEqual(badModes(raw), [
    { path: "apps/api/node_modules", kind: "ссылка (120000)" },
    { path: ".claude/worktrees/agent-1", kind: "вложенный репозиторий (160000)" },
  ]);
});

test("миграции — только migration.sql в своей папке", () => {
  assert.deepEqual(
    newMigrations([
      "apps/api/prisma/migrations/20260924_x/migration.sql",
      "apps/api/prisma/schema.prisma",
      "apps/api/prisma/migrations/migration_lock.toml",
    ]),
    ["apps/api/prisma/migrations/20260924_x/migration.sql"],
  );
});

test("owner/repo из любого вида адреса origin", () => {
  const want = { owner: "jabarovdaler", repo: "royal-home-crm" };
  assert.deepEqual(parseRepo("https://github.com/jabarovdaler/royal-home-crm"), want);
  assert.deepEqual(parseRepo("https://github.com/jabarovdaler/royal-home-crm.git"), want);
  assert.deepEqual(parseRepo("git@github.com:jabarovdaler/royal-home-crm.git"), want);
  assert.deepEqual(parseRepo("http://127.0.0.1:35685/git/jabarovdaler/royal-home-crm"), want);
  // Локальный путь Windows с обратными слэшами (раннер daler-laptop).
  assert.deepEqual(parseRepo("C:\\Users\\x\\jabarovdaler\\royal-home-crm.git"), want);
});

test("описание отметки называет прогон и main и влезает в 140 символов", () => {
  const d = statusDescription({ mainSha: "08cb965c3ebc065406a082aa731884edee1d0c1c", apiTests: 6083, full: true });
  assert.match(d, /6083 тестов, 0 падений/);
  assert.match(d, /main 08cb965c3/);
  assert.ok(d.length <= 140);
  assert.match(statusDescription({ mainSha: "abc", apiTests: 0, full: false }), /правилу пачки/);
});

test("строка-отметка в коммите несёт дерево, main и число тестов одной строкой", () => {
  const t = shipTrailer({ tree: "a".repeat(40), mainSha: "b".repeat(40), apiTests: 6680, full: true });
  assert.equal(t, `Ship-Verified: tree=${"a".repeat(40)} main=${"b".repeat(40)} api-tests=6680 failed=0`);
  assert.match(shipTrailer({ tree: "t", mainSha: "m", apiTests: 0, full: false }), /api-tests=batch failed=0$/);
  assert.ok(!t.includes("\n"));
});

const greenApiReport = () => ({ success: true, numTotalTests: 9, numFailedTests: 0, numFailedTestSuites: 0 });

test("полный ship: принимает только зелёный процесс и зелёный итог runner", () => {
  assert.equal(requireFullApiRunPassed(0, greenApiReport()), 9);
  for (const code of [1, null, undefined]) {
    assert.throws(() => requireFullApiRunPassed(code, greenApiReport()), /запусти полный ship заново/);
  }
  assert.throws(() => requireFullApiRunPassed(0, { ...greenApiReport(), success: false }), /полный прогон.*красный/);
});

test("полный ship: обычные падения и assertions вместе с аварией не обходятся зелёным alone", () => {
  for (const code of [0, 1]) {
    const red = { ...greenApiReport(), success: false, numFailedTests: 1, numFailedTestSuites: 1,
      testResults: [
        { name: "tests/assertion.test.ts", status: "failed", assertionResults: [{ status: "failed" }] },
        { name: "tests/crashed.test.ts", status: "passed", assertionResults: [{ status: "pending" }] },
      ] };
    // Даже если упавший assertion-файл отдельно проходит, исходный итог остаётся red.
    assert.equal(requireFullApiRunPassed(0, greenApiReport()), 9);
    assert.throws(() => requireFullApiRunPassed(code, red), /только диагностикой/);
  }
  for (const patch of [{ numFailedTests: 1 }, { numFailedTestSuites: 1 }]) {
    assert.throws(() => requireFullApiRunPassed(0, { ...greenApiReport(), ...patch }), /красный/);
  }
});

test("полный ship: отсутствующий, пустой и некорректный отчёт не даёт отметку", () => {
  for (const rep of [null, undefined, [], {}, { ...greenApiReport(), numTotalTests: 0 },
    { ...greenApiReport(), numTotalTests: "9" }, { ...greenApiReport(), numTotalTests: NaN },
    { ...greenApiReport(), numFailedTests: undefined }, { ...greenApiReport(), success: "true" }]) {
    assert.throws(() => requireFullApiRunPassed(0, rep), /отчёт некорректен/);
  }
});

test("полный ship: production boundary стоит перед отправкой, без автоматических alone retries", () => {
  const body = readFileSync(SHIP, "utf8");
  const stage6 = body.indexOf("stage(6, cloud ?");
  const gate = body.indexOf("apiTests = requireFullApiRunPassed(r.code, rep)", stage6);
  const cloudGate = body.indexOf("apiTests = await waitCloudTests(", stage6);
  const stage7 = body.indexOf("stage(7,", stage6);
  assert.ok(stage6 > 0 && gate > stage6 && stage7 > gate);
  assert.ok(cloudGate > stage6 && stage7 > cloudGate, "облачный вердикт — тоже до отправки");
  // waitCloudTests кончается тем же requireFullApiRunPassed — через requireCloudRunPassed.
  assert.match(body, /return requireCloudRunPassed\(\{ run: runInfo, reportSha, report, sha \}\);/);
  assert.doesNotMatch(body.slice(stage6, stage7), /failedTestFiles|stillRed|\["vitest", "run"/);
});

test("облако: зелёный прогон своего sha с зелёным отчётом — число тестов", () => {
  const sha = "a".repeat(40);
  const run = { status: "completed", conclusion: "success", head_sha: sha, html_url: "u" };
  assert.equal(requireCloudRunPassed({ run, reportSha: sha + "\n", report: { ...greenApiReport(), sourceChecks: {sha, result: "success"} }, sha }), 9);
  assert.equal(cloudBranch(sha), `ship-tests/${sha}`);
});

test("облако: чужой sha, недоделанный, красный или без отчёта — отметки нет", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const ok = { status: "completed", conclusion: "success", head_sha: sha, html_url: "u" };
  const cases = [
    [{ run: { ...ok, status: "in_progress" }, reportSha: sha, report: greenApiReport() }, /не завершён/],
    [{ run: { ...ok, head_sha: other }, reportSha: sha, report: greenApiReport() }, /проверял bbbbbbbbb/],
    [{ run: ok, reportSha: other, report: greenApiReport() }, /отчёт облачного прогона про bbbbbbbbb/],
    [{ run: ok, reportSha: null, report: greenApiReport() }, /отчёт облачного прогона/],
    [{ run: { ...ok, conclusion: "failure" }, reportSha: sha, report: greenApiReport() }, /failure/],
    [{ run: { ...ok, conclusion: "startup_failure" }, reportSha: sha, report: greenApiReport() }, /--local-tests/],
    [{ run: ok, reportSha: sha, report: null }, /отчёт некорректен/],
    [{ run: ok, reportSha: sha, report: { ...greenApiReport(), success: false } }, /красный/],
    [{ run: null, reportSha: sha, report: greenApiReport() }, /не завершён/],
  ];
  for (const [input, re] of cases) assert.throws(() => requireCloudRunPassed({ ...input, sha }), re);
});

test("cloud release requires source checks for the exact tested commit", () => {
  const sha = "a".repeat(40);
  const run = {status:"completed", conclusion:"success", head_sha:sha};
  for (const sourceChecks of [undefined, {sha:"b".repeat(40),result:"success"}, {sha,result:"failure"}]) {
    assert.throws(() => requireCloudRunPassed({run,reportSha:sha,report:{...greenApiReport(),sourceChecks},sha}), /проверки исходников/);
  }
});

// ── сухой прогон в одноразовом репозитории ──────────────────────────────────

function sh(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-ship-test-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  sh(dir, "init", "--bare", "-b", "main", origin);
  sh(dir, "clone", "-q", origin, work);
  sh(work, "config", "user.email", "t@t");
  sh(work, "config", "user.name", "t");
  sh(work, "checkout", "-q", "-b", "main");
  mkdirSync(path.join(work, "apps", "web", "src"), { recursive: true });
  writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "export const a = 1;\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-q", "-m", "init");
  sh(work, "push", "-q", "origin", "main");
  sh(work, "checkout", "-q", "-b", "feature");
  return { dir, work };
}

function dryRun(cwd, extra = []) {
  return spawnSync(process.execPath, [SHIP, "--dry-run", ...extra], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GH_TOKEN: "test-token-not-used", NO_COLOR: "1" },
  });
}

test("сухой прогон: правка сайта — план без полного прогона сервера, код 0, ничего не пушит", () => {
  const { dir, work } = makeRepo();
  try {
    writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "export const a = 2;\n");
    sh(work, "commit", "-q", "-am", "сайт");
    const r = dryRun(work);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /полный прогон тестов сервера: нет/);
    assert.match(r.stdout, /сухой прогон: ничего не менялось/);
    assert.equal(sh(work, "ls-remote", "origin", "refs/heads/feature"), "", "сухой прогон не должен пушить");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("сухой прогон: правка сервера — полный прогон; с миграцией — migrate deploy", () => {
  const { dir, work } = makeRepo();
  try {
    const mig = path.join(work, "apps", "api", "prisma", "migrations", "20260924_x");
    mkdirSync(mig, { recursive: true });
    writeFileSync(path.join(mig, "migration.sql"), "SELECT 1;\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "миграция");
    const r = dryRun(work);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /полный прогон тестов сервера: да, в облаке GitHub/);
    assert.match(r.stdout, /migrate deploy — на базах машин GitHub \(своих миграций в правке: 1\)/);
    assert.match(r.stdout, /полный прогон в облаке GitHub \(ship-tests\.yml/);
    const local = dryRun(work, ["--local-tests"]);
    assert.equal(local.status, 0, local.stdout + local.stderr);
    assert.match(local.stdout, /полный прогон тестов сервера: да, здесь/);
    assert.match(local.stdout, /migrate deploy на тестовую базу \(своих миграций в правке: 1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("сухой прогон: ссылка в правке — остановка с кодом 1 и названием файла", (t) => {
  const { dir, work } = makeRepo();
  try {
    try {
      symlinkSync("a.tsx", path.join(work, "apps", "web", "src", "link.tsx"));
    } catch (err) {
      // Windows без режима разработчика не даёт создать ссылку — проверять нечего.
      if (err.code === "EPERM") return t.skip("ссылки недоступны в этой системе");
      throw err;
    }
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "ссылка");
    const r = dryRun(work);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ссылка \(120000\): apps\/web\/src\/link\.tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("сухой прогон: с main и с незакоммиченным — остановка, оба названы", () => {
  const { dir, work } = makeRepo();
  try {
    sh(work, "checkout", "-q", "main");
    writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "грязь\n");
    const r = dryRun(work);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ветка «main»/);
    assert.match(r.stderr, /незакоммиченные правки/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("защита main: только правкой, squash, без исключений; обязательного статуса нет — его сторожит сервер", async () => {
  const { protectionPayload } = await import("./protect-main.mjs");
  const p = protectionPayload();
  // Облачные сессии не могут ставить статусы GitHub — обязательная проверка закрыла бы им main.
  assert.equal(p.required_status_checks, null);
  assert.equal(p.enforce_admins, true);
  assert.equal(p.required_linear_history, true);
  assert.equal(p.allow_force_pushes, false);
  assert.equal(p.allow_deletions, false);
  assert.equal(p.required_pull_request_reviews.required_approving_review_count, 0);
});

// ── сторож на сервере выката (ops/auto-deploy.sh, crm_ship_verified) ──────────
// Выбор Dan 24.09: отметку «проверено» проверяет сервер. Сторож — функция bash;
// на Windows `bash` без пути — заглушка WSL (CLAUDE.md), там проверка не идёт.
const AUTO_DEPLOY = path.join(path.dirname(SHIP), "..", "ops", "auto-deploy.sh");

function shipVerified(cwd, rev) {
  return spawnSync(
    "bash",
    ["-c", `CRM_AUTODEPLOY_SOURCE_ONLY=1 . "${AUTO_DEPLOY}" && crm_ship_verified "${rev}"`],
    { cwd, encoding: "utf8" },
  ).status;
}

test("сервер выката пускает только вершину со строкой Ship-Verified своего дерева", (t) => {
  if (process.platform === "win32") return t.skip("bash-сторож проверяется на Linux (сервер выката — Linux)");
  const { dir, work } = makeRepo();
  try {
    const tree = () => sh(work, "rev-parse", "HEAD^{tree}");
    // Влито мимо команды — строки нет.
    writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "export const a = 3;\n");
    sh(work, "commit", "-q", "-am", "влито кнопкой");
    assert.notEqual(shipVerified(work, "HEAD"), 0, "без строки — не выкатывать");

    // Влито командой: строка с деревом этого же коммита.
    writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "export const a = 4;\n");
    sh(work, "add", "-A");
    const treeNext = sh(work, "write-tree");
    sh(work, "commit", "-q", "-m", `правка (#1)\n\n${shipTrailer({ tree: treeNext, mainSha: "m".repeat(40), apiTests: 5, full: true })}`);
    assert.equal(tree(), treeNext);
    assert.equal(shipVerified(work, "HEAD"), 0, "строка с верным деревом — выкатывать");

    // Строка переехала на другое содержимое (подделка или правка поверх) — не выкатывать.
    writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "export const a = 5;\n");
    sh(work, "commit", "-q", "-am", `поверх\n\nShip-Verified: tree=${treeNext} main=x api-tests=5 failed=0`);
    assert.notEqual(shipVerified(work, "HEAD"), 0, "дерево не совпало — не выкатывать");

    // Строка не с начала — не считается.
    sh(work, "commit", "-q", "--allow-empty", "-m", `цитата\n\nсм. Ship-Verified: tree=${tree()}`);
    assert.notEqual(shipVerified(work, "HEAD"), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── OPS10: проверенное и отправляемое — одно и то же ─────────────────────────

test("OPS10: параллельный коммит B поверх проверяемого A после снимка — отправка запрещена", () => {
  const { dir, work } = makeRepo();
  try {
    writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "export const a = 2;\n");
    sh(work, "commit", "-q", "-am", "A: проверяемая правка");
    const git = (...args) => sh(work, ...args);

    const verified = snapshotState(git);
    assert.deepEqual(stateDrift(verified, snapshotState(git)), [], "ничего не менялось — расхождения нет");

    // Пока идёт полный прогон, в тот же checkout коммитит другая сессия.
    writeFileSync(path.join(work, "apps", "web", "src", "b.tsx"), "export const b = 1;\n");
    sh(work, "add", "-A");
    sh(work, "commit", "-q", "-m", "B: чужой коммит");

    const problems = stateDrift(verified, snapshotState(git));
    assert.ok(problems.some((p) => /HEAD сдвинулся/.test(p)), problems.join("\n"));
    assert.ok(problems.some((p) => /дерево изменилось/.test(p)), problems.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OPS10: правка отслеживаемого файла во время проверки — расхождение; неотслеживаемый артефакт сборки — нет", () => {
  const { dir, work } = makeRepo();
  try {
    const git = (...args) => sh(work, ...args);
    const verified = snapshotState(git);

    writeFileSync(path.join(work, "dist-artifact.log"), "мусор сборки\n");
    assert.deepEqual(stateDrift(verified, snapshotState(git)), [], "неотслеживаемое не считается");

    writeFileSync(path.join(work, "apps", "web", "src", "a.tsx"), "правили руками посреди прогона\n");
    const problems = stateDrift(verified, snapshotState(git));
    assert.equal(problems.length, 1, problems.join("\n"));
    assert.match(problems[0], /отслеживаемые файлы правили во время проверки[\s\S]*a\.tsx/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("OPS10: ship пушит и подписывает записанную вершину и дерево, а не «HEAD сейчас»", () => {
  const body = readFileSync(SHIP, "utf8");
  const snap = body.indexOf("const verified = snapshotState(git)");
  const migrations = body.indexOf('stage(4, "клиент Prisma и миграции тестовой базы")');
  const tests = body.indexOf('stage(6, "тесты сервера, полный прогон")');
  const drift = body.indexOf("stateDrift(verified, snapshotState(git))");
  const push = body.indexOf('["push", "origin", `${headSha}:refs/heads/${branch}`]');
  assert.ok(snap > 0 && snap < migrations, "снимок до всех проверок");
  assert.ok(drift > tests, "сверка после тестов");
  assert.ok(push > drift, "отправка только после сверки");
  assert.doesNotMatch(body, /const headSha = git\("rev-parse", "HEAD"\)/, "вершина не читается заново после тестов");
  assert.match(body, /shipTrailer\(\{ tree: verified\.tree,/);
  assert.doesNotMatch(body, /HEAD:refs\/heads/);
});

// ── повтор сетевых отказов (07.10.2026) ────────────────────────────────────────
// Девять остановок ship подряд, две из них — `fetch failed ECONNABORTED` на первом
// запросе к GitHub ПОСЛЕ зелёного полного прогона: соединение keep-alive за 35 минут
// умерло. Повтора не было, и каждый такой обрыв стоил часа.

/** Отказ связи в том виде, в каком его отдаёт встроенный fetch Node. */
function netError(code) {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const httpErr = (status, message) => ({ ok: false, status, text: async () => JSON.stringify({ message }) });
const quiet = { sleep: async () => {}, log: () => {} };

test("код отказа связи виден на любой глубине cause, ответ сервера за него не считается", () => {
  assert.equal(networkErrorCode(netError("ECONNABORTED")), "ECONNABORTED");
  assert.equal(networkErrorCode(new Error("просто ошибка")), null);
  assert.equal(networkErrorCode({ cause: { cause: { code: "UND_ERR_SOCKET" } } }), "UND_ERR_SOCKET");
  assert.equal(networkErrorCode(netError("ENOENT")), null, "чужой код не выдавать за обрыв связи");
});

test("чтение: обрыв связи повторяется и проходит со второй попытки", async () => {
  const calls = [];
  const gh = github("t", { owner: "o", repo: "r" }, {
    ...quiet,
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) throw netError("ECONNABORTED");
      return ok({ head: { sha: "abc" } });
    },
  });
  assert.deepEqual(await gh.call("GET", "/{repo}/pulls/7"), { head: { sha: "abc" } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0], "https://api.github.com/repos/o/r/pulls/7");
});

test("чтение: обрывы не кончаются — остановка с кодом связи и пометкой network", async () => {
  const gh = github("t", { owner: "o", repo: "r" }, {
    ...quiet,
    fetchImpl: async () => {
      throw netError("UND_ERR_SOCKET");
    },
  });
  await assert.rejects(() => gh.call("GET", "/{repo}/pulls/7"), (err) => {
    assert.match(err.message, /связь оборвалась \(UND_ERR_SOCKET\)/);
    assert.equal(err.network, "UND_ERR_SOCKET");
    return true;
  });
});

test("чтение: 502 повторяется, 404 — нет (ответ сервера, а не обрыв)", async () => {
  let n = 0;
  const flaky = github("t", { owner: "o", repo: "r" }, {
    ...quiet,
    fetchImpl: async () => (++n === 1 ? httpErr(502, "Bad gateway") : ok({ ok: 1 })),
  });
  assert.deepEqual(await flaky.call("GET", "/{repo}/pulls/7"), { ok: 1 });
  assert.equal(n, 2);

  let m = 0;
  const missing = github("t", { owner: "o", repo: "r" }, {
    ...quiet,
    fetchImpl: async () => {
      m += 1;
      return httpErr(404, "Not Found");
    },
  });
  await assert.rejects(() => missing.call("GET", "/{repo}/pulls/7"), /404: Not Found/);
  assert.equal(m, 1, "ответ сервера не повторяется — иначе ship молча ходит по кругу");
});

test("вливание не повторяется само: второй PUT мог бы соврать «не влито» после влитого", async () => {
  const methods = [];
  const gh = github("t", { owner: "o", repo: "r" }, {
    ...quiet,
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      throw netError("ECONNABORTED");
    },
  });
  await assert.rejects(() => gh.call("PUT", "/{repo}/pulls/7/merge", { sha: "abc" }), (err) => {
    assert.equal(err.network, "ECONNABORTED");
    return true;
  });
  assert.deepEqual(methods, ["PUT"], "ровно одна попытка вливания");
});
