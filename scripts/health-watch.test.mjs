// Сторож, который будит зависший сервер (ops/health-watch.sh; аудит 23.09, №77,
// просьба Dan 25.09). Сеть, Docker и замок выката подменены заглушками в PATH:
// проверяется, КОГО и КОГДА сторож перезапускает и о чём пишет в Telegram.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops", "health-watch.sh");

function stub(bin, name, body) {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-health-watch-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "state");
  const log = path.join(dir, "calls.log");
  spawnSync("mkdir", ["-p", bin, state]);
  // curl: глубокая проверка отдаёт тело и код из файлов; Telegram — «ok».
  stub(bin, "curl", `
for a in "$@"; do
  case "$a" in
    *api.telegram.org*) for b in "$@"; do case "$b" in text=*) echo "tg $b" >> "${log}";; esac; done; echo '{"ok":true}'; exit 0;;
  esac
done
body="$(cat "${dir}/deep_body" 2>/dev/null)"; code="$(cat "${dir}/deep_code")"
printf '%s\\n%s' "$body" "$code"`);
  // docker: restart пишется в журнал, inspect отдаёт здоровье api из файла.
  stub(bin, "docker", `
case "$1" in
  restart) echo "restart \${@: -1}" >> "${log}";;
  inspect) cat "${dir}/api_health" 2>/dev/null || echo unhealthy;;
esac`);
  // flock: замок самого сторожа (fd) свободен; замок выката — по файлу-флагу.
  stub(bin, "flock", `
[ "$2" = "9" ] && exit 0
[ -f "${dir}/deploy_running" ] && exit 1
exit 0`);
  const watchdogEnv = path.join(dir, "watchdog.env");
  writeFileSync(watchdogEnv, "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=1\n");
  const deployLock = path.join(dir, "deploy.lock");
  writeFileSync(deployLock, "");

  const run = () => {
    const r = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CRM_HEALTH_STATE_DIR: state,
        CRM_DEPLOY_LOCK: deployLock,
        CRM_DEPLOYED_SHA_FILE: path.join(dir, "deployed-sha"),
        WATCHDOG_ENV: watchdogEnv,
      },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return r.stdout;
  };
  const answer = (code, body = "") => {
    writeFileSync(path.join(dir, "deep_code"), String(code));
    writeFileSync(path.join(dir, "deep_body"), body);
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const restarts = () => calls().filter((c) => c.startsWith("restart"));
  const alerts = () => calls().filter((c) => c.startsWith("tg"));
  const age = (file, minutes) => {
    const t = (Date.now() - minutes * 60_000) / 1000;
    utimesSync(path.join(state, file), t, t);
  };
  return { dir, state, run, answer, calls, restarts, alerts, age, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const WORKER_DEAD = '{"ok":false,"db":true,"worker":false,"workerLastBeatSec":900}';
const DB_DEAD = '{"ok":false,"db":false,"worker":false,"workerLastBeatSec":null}';
const HEALTHY = '{"ok":true,"db":true,"worker":true,"workerLastBeatSec":30}';

test("здоровый сервер — никого не трогает и молчит", (t) => {
  if (process.platform === "win32") return t.skip("сторож живёт на Linux-сервере");
  const s = setup();
  try {
    s.answer(200, HEALTHY);
    for (let i = 0; i < 5; i++) s.run();
    assert.deepEqual(s.calls(), []);
  } finally {
    s.done();
  }
});

test("фоновый процесс молчит — перезапуск worker на третьей проверке подряд, одно сообщение", (t) => {
  if (process.platform === "win32") return t.skip("сторож живёт на Linux-сервере");
  const s = setup();
  try {
    s.answer(503, WORKER_DEAD);
    s.run();
    s.run();
    assert.deepEqual(s.restarts(), [], "две проверки — ещё не повод");
    s.run();
    assert.deepEqual(s.restarts(), ["restart royalhome-crm-worker-1"]);
    assert.equal(s.alerts().length, 1);
    assert.match(s.alerts()[0], /worker.*перезапущен/);

    // Сразу после перезапуска пульс законно старый — не копим сбои.
    for (let i = 0; i < 4; i++) s.run();
    assert.equal(s.restarts().length, 1, "в первые минуты после перезапуска не трогаем");

    // Прошло 10 минут, а worker всё молчит: второй раз не дёргаем, один алерт человеку.
    s.age("worker.restarted", 10);
    for (let i = 0; i < 6; i++) s.run();
    assert.equal(s.restarts().length, 1, "перезапуск по кругу каждую минуту не нужен");
    assert.equal(s.alerts().length, 2);
    assert.match(s.alerts()[1], /не ожил/);

    // Ожил — счётчики и штамп «сообщили» сняты.
    s.answer(200, HEALTHY);
    s.run();
    assert.equal(existsSync(path.join(s.state, "worker.fails")), false);
    assert.equal(existsSync(path.join(s.state, "worker.gaveup")), false);
  } finally {
    s.done();
  }
});

test("API не отвечает — перезапуск api; api внутри здоров — перезапуск web", (t) => {
  if (process.platform === "win32") return t.skip("сторож живёт на Linux-сервере");
  const s = setup();
  try {
    s.answer("000");
    writeFileSync(path.join(s.dir, "api_health"), "unhealthy");
    for (let i = 0; i < 3; i++) s.run();
    assert.deepEqual(s.restarts(), ["restart royalhome-crm-api-1"]);

    const t2 = setup();
    try {
      t2.answer(504);
      writeFileSync(path.join(t2.dir, "api_health"), "healthy");
      for (let i = 0; i < 3; i++) t2.run();
      assert.deepEqual(t2.restarts(), ["restart royalhome-crm-web-1"]);
    } finally {
      t2.done();
    }
  } finally {
    s.done();
  }
});

test("база не отвечает — только одно сообщение человеку, никаких перезапусков", (t) => {
  if (process.platform === "win32") return t.skip("сторож живёт на Linux-сервере");
  const s = setup();
  try {
    s.answer(503, DB_DEAD);
    for (let i = 0; i < 6; i++) s.run();
    assert.deepEqual(s.restarts(), []);
    assert.equal(s.alerts().length, 1);
    assert.match(s.alerts()[0], /база не отвечает/);
  } finally {
    s.done();
  }
});

test("во время выката и сразу после него — не проверяет и не копит сбои", (t) => {
  if (process.platform === "win32") return t.skip("сторож живёт на Linux-сервере");
  const s = setup();
  try {
    s.answer("000");
    writeFileSync(path.join(s.dir, "deploy_running"), "");
    for (let i = 0; i < 5; i++) s.run();
    assert.deepEqual(s.calls(), []);

    // Выкат закончился минуту назад — контейнеры ещё поднимаются.
    rmSync(path.join(s.dir, "deploy_running"));
    s.age("deploy.seen", 1);
    for (let i = 0; i < 5; i++) s.run();
    assert.deepEqual(s.calls(), []);
    assert.equal(existsSync(path.join(s.state, "api.fails")), false);
  } finally {
    s.done();
  }
});

test("старый API без глубокой проверки — судит по обычной и не трогает worker", (t) => {
  if (process.platform === "win32") return t.skip("сторож живёт на Linux-сервере");
  const s = setup();
  try {
    // До выката новой версии адреса /health/deep нет (404): это не «фон мёртв».
    s.answer(404);
    for (let i = 0; i < 5; i++) s.run();
    assert.equal(s.restarts().filter((r) => r.includes("worker")).length, 0);
  } finally {
    s.done();
  }
});
