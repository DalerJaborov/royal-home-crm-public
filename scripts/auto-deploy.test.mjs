// Выкат не рвёт живой разговор робота (ops/auto-deploy.sh, аудит фона 02.10.2026, №2).
// Функции сторожа берутся из скрипта с CRM_AUTODEPLOY_SOURCE_ONLY=1 — git, flock и
// сам выкат не запускаются; docker подменён заглушкой в PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops", "auto-deploy.sh");

// На Windows `bash` без пути — заглушка WSL (CLAUDE.md); сервер выката — Linux.
const skipOnWindows = (t) => (process.platform === "win32" ? (t.skip("bash-сторож проверяется на Linux"), true) : false);

function gate(target, raw, rc, env = {}) {
  return spawnSync(
    "bash",
    ["-c", `CRM_AUTODEPLOY_SOURCE_ONLY=1 . "${SCRIPT}" && crm_live_call_gate "$1" "$2" "$3"`, "gate", target, raw, String(rc)],
    { encoding: "utf8", env: { ...process.env, ...env } },
  );
}

test("идёт разговор робота — тик выката пропускается и говорит почему", (t) => {
  if (skipOnWindows(t)) return;
  for (const target of ["api", "all"]) {
    const r = gate(target, " 1\n", 0);
    assert.equal(r.status, 1, target);
    assert.match(r.stdout, /идёт разговор робота \(живых сессий: 1/);
  }
});

test("разговоров нет — выкатываем молча", (t) => {
  if (skipOnWindows(t)) return;
  const r = gate("api", "0", 0);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

test("запрос не удался — выкатываем как раньше, причина в журнале", (t) => {
  if (skipOnWindows(t)) return;
  for (const [raw, rc] of [
    ["service \"postgres\" is not running", 1],
    ["", 0],
    ["psql: error: connection refused", 0],
    ["", 124],
  ]) {
    const r = gate("all", raw, rc);
    assert.equal(r.status, 0, `${raw} / ${rc}`);
    assert.match(r.stdout, /не удалась — выкатываем как обычно/);
  }
});

test("цель web api не пересоздаёт — разговор её не держит; рубильник снимает сторож", (t) => {
  if (skipOnWindows(t)) return;
  assert.equal(gate("web", "2", 0).status, 0);
  assert.equal(gate("api", "2", 0, { CRM_AUTODEPLOY_LIVE_CALL_GATE: "0" }).status, 0);
});

test("запрос идёт в базу через compose: незакрытые сессии моложе 16 минут", (t) => {
  if (skipOnWindows(t)) return;
  const dir = mkdtempSync(path.join(tmpdir(), "rh-auto-deploy-"));
  try {
    const log = path.join(dir, "docker.log");
    const docker = path.join(dir, "docker");
    writeFileSync(docker, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${log}"\necho " 2"\n`);
    chmodSync(docker, 0o755);
    const r = spawnSync("bash", ["-c", `CRM_AUTODEPLOY_SOURCE_ONLY=1 . "${SCRIPT}" && crm_live_voice_calls_query`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "2");
    const args = readFileSync(log, "utf8");
    assert.match(args, /^compose$/m);
    assert.match(args, /^exec$/m);
    assert.match(args, /^postgres$/m);
    assert.match(args, /"LiveVoiceSession" WHERE "endedAt" IS NULL AND "startedAt" > now\(\) - interval '16 minutes'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("сторож стоит в тике ДО ops/deploy.sh", () => {
  const text = readFileSync(SCRIPT, "utf8");
  const gateAt = text.indexOf('if ! crm_live_call_gate "$TARGET"');
  const deployAt = text.indexOf('"$REPO_DIR/ops/deploy.sh" "$TARGET"');
  assert.ok(gateAt > 0, "вызов сторожа в теле тика");
  assert.ok(deployAt > gateAt, "сторож раньше выката");
});

// ── понятное сообщение о падении и повтор с паузой (08.10.2026) ─────────────
function fn(body, args = [], env = {}) {
  return spawnSync("bash", ["-c", `CRM_AUTODEPLOY_SOURCE_ONLY=1 . "${SCRIPT}" && ${body}`, "fn", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("причина падения называется словами по выводу deploy.sh", (t) => {
  if (skipOnWindows(t)) return;
  const dir = mkdtempSync(path.join(tmpdir(), "rh-reason-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cases = [
    ["FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory", /не хватило памяти/],
    ["write /var/lib/docker/x: no space left on device", /место на диске/],
    ["[deploy][ОШИБКА] миграции не применились — контейнеры не тронуты", /миграция/],
    ["[deploy][ОШИБКА] health не ответил 200 за 60с", /не запустилась/],
    ["[deploy][ОШИБКА] сборка образа не удалась — прод не тронут", /не собралась/],
    ["что-то совсем другое", /не распознана/],
  ];
  for (const [line, want] of cases) {
    const log = path.join(dir, "log");
    writeFileSync(log, `шум\n${line}\n`);
    const r = fn('crm_deploy_failure_reason "$1"', [log]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, want, line);
  }
});

test("повтор идёт с растущей паузой, после последней попытки — честный отказ", (t) => {
  if (skipOnWindows(t)) return;
  assert.equal(fn('crm_retry_wait_seconds 1').stdout.trim(), "600");
  assert.equal(fn('crm_retry_wait_seconds 3').stdout.trim(), "7200");
  assert.equal(fn('crm_retry_wait_seconds 4').stdout.trim(), "");
  const first = fn('crm_deploy_failure_message 1 4 "серверу не хватило памяти" "Правка X"').stdout;
  assert.match(first, /Сайт НЕ обновился: серверу не хватило памяти\. Работает прежняя версия/);
  assert.match(first, /через 10 минут/);
  assert.match(fn('crm_deploy_failure_message 4 4 "x" "y"').stdout, /больше сам не пробую/);
});

test("тик ждёт паузу между попытками и пишет время падения", () => {
  const src = readFileSync(SCRIPT, "utf8");
  assert.match(src, /crm_retry_wait_seconds "\$TRIES"/);
  assert.match(src, /date \+%s > "\$FAILED_AT_FILE"/);
  assert.match(src, /DEPLOY_RC="\$\{PIPESTATUS\[0\]\}"/);
});
