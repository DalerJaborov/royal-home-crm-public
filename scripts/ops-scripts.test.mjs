// node --test scripts/ops-scripts.test.mjs   (он же npm run test:scripts)
//
// Скрипты выката, бэкапа, восстановления (ops/*.sh) — аудит Codex, второй проход
// 04.10.2026, пакет H (OPS-01, OPS02, OPS03, OPS04). Настоящий хост, docker, ssh и
// сеть не задействованы: скрипты копируются во временный репозиторий, а docker,
// curl, psql, rclone подменены заглушками в PATH, которые пишут свои вызовы в журнал.
//
// На Windows `bash` без пути может оказаться заглушкой WSL (CLAUDE.md), поэтому
// запускающие bash проверки там пропускаются, а CRM_TEST_BASH=1 (Git Bash) включает их.
// Проверки текста файла (readFileSync) идут везде.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OPS = path.join(ROOT, "ops");
const text = (name) => readFileSync(path.join(OPS, name), "utf8");

const skipNoBash = (t) =>
  process.platform === "win32" && process.env.CRM_TEST_BASH !== "1" ? (t.skip("bash-скрипты проверяются на Linux"), true) : false;

const posix = (p) => p.replaceAll("\\", "/");
const tmp = () => posix(mkdtempSync(path.join(tmpdir(), "rh-ops-")));
const write = (file, body, mode) => {
  writeFileSync(file, body);
  if (mode) chmodSync(file, mode);
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
};
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// ── OPS-01 · deploy.sh выкатывает ровно ту вершину, которую проверил тик ──────────

/** Рабочий клон с ops/deploy.sh и «origin», в котором main уехал на два коммита вперёд. */
function deployFixture() {
  const dir = tmp();
  const bin = `${dir}/bin`;
  const state = `${dir}/state`;
  mkdirSync(bin);
  mkdirSync(state);
  const dockerLog = `${dir}/docker.log`;
  write(`${bin}/docker`, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${dockerLog}"\nexit 0\n`, 0o755);
  write(`${bin}/curl`, `#!/usr/bin/env bash\nprintf 200\n`, 0o755);

  const origin = `${dir}/origin.git`;
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  const work = `${dir}/work`;
  git(dir, "clone", "-q", origin, work);
  mkdirSync(`${work}/ops`);
  copyFileSync(path.join(OPS, "deploy.sh"), `${work}/ops/deploy.sh`);
  chmodSync(`${work}/ops/deploy.sh`, 0o755);
  writeFileSync(`${work}/f.txt`, "r1\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "r1");
  git(work, "push", "-q", "origin", "HEAD:main");
  const r1 = git(work, "rev-parse", "HEAD");
  writeFileSync(`${work}/f.txt`, "r2\n");
  git(work, "commit", "-qam", "r2");
  const r2 = git(work, "rev-parse", "HEAD");
  writeFileSync(`${work}/f.txt`, "r3\n");
  git(work, "commit", "-qam", "r3");
  const r3 = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", "HEAD:main");
  return { dir, bin, state, dockerLog, work, r1, r2, r3 };
}

function runDeploy(fx, args, extraEnv = {}) {
  return spawnSync("bash", [`${fx.work}/ops/deploy.sh`, ...args], {
    encoding: "utf8",
    cwd: fx.work,
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      CRM_DEPLOY_LOCK_HELD: "1",
      CRM_AUTODEPLOY_STATE_DIR: `${fx.state}`,
      CRM_DEPLOY_LOGS_DIR: `${fx.dir}/deploy-logs`,
      CRM_HEALTH_URL: "http://127.0.0.1:1/api/v1/health",
      ...extraEnv,
    },
  });
}

const dockerCalls = (fx) => (existsSync(fx.dockerLog) ? readFileSync(fx.dockerLog, "utf8") : "");

test("OPS-01: deploy.sh --sha= приводит дерево ровно к проверенной вершине, а не к свежему main", (t) => {
  if (skipNoBash(t)) return;
  const fx = deployFixture();
  try {
    // Дерево отстало на r1, проверен r2, а в origin уже лежит r3 (его никто не проверял).
    git(fx.work, "reset", "-q", "--hard", fx.r1);
    const r = runDeploy(fx, ["api", `--sha=${fx.r2}`]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(fx.work, "rev-parse", "HEAD"), fx.r2, "собрано должно быть r2, а не r3");
    assert.equal(readFileSync(`${fx.state}/deployed-sha`, "utf8").trim(), fx.r2);
    assert.match(dockerCalls(fx), /\bbuild api\b/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS-01: дерево уже уехало дальше проверенной вершины — выкат не идёт, код 3, сборки нет", (t) => {
  if (skipNoBash(t)) return;
  const fx = deployFixture();
  try {
    // HEAD уже на r3 (другой путь выката успел подтянуть main): собирать r3 по проверке r2 нельзя.
    const r = runDeploy(fx, ["api", `--sha=${fx.r2}`]);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.doesNotMatch(dockerCalls(fx), /\bbuild\b/);
    assert.equal(existsSync(`${fx.state}/deployed-sha`), false, "deployed-sha трогать нельзя");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS-01: --sha= принимает только полный хеш коммита; без ключа поведение прежнее (git pull)", (t) => {
  if (skipNoBash(t)) return;
  const fx = deployFixture();
  try {
    git(fx.work, "reset", "-q", "--hard", fx.r1);
    const bad = runDeploy(fx, ["api", "--sha=main; rm -rf /"]);
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.doesNotMatch(dockerCalls(fx), /\bbuild\b/);
    // Прежний путь (Actions, ручной запуск): без --sha тянем свежий main.
    const plain = runDeploy(fx, ["api"]);
    assert.equal(plain.status, 0, plain.stdout + plain.stderr);
    assert.equal(git(fx.work, "rev-parse", "HEAD"), fx.r3);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS-01: тик auto-deploy.sh передаёт выкату проверенную вершину и сам больше не тянет main", () => {
  const body = text("auto-deploy.sh");
  assert.match(body, /ops\/deploy\.sh" "\$TARGET" --sha="\$REMOTE"/, "выкат получает SHA, который проверяли");
  assert.doesNotMatch(body, /^\s*git pull\b/m, "ветка «только документация» тоже не тянет свежий main");
  assert.match(body, /merge --ff-only --quiet "\$REMOTE"/, "docs-only ветка подтягивает именно REMOTE");
  assert.match(body, /\$DEPLOY_RC" = "3"/, "код 3 (дерево уехало дальше) — не авария выката");
});

// ── OPS-04 · сеть royalhome-shared создаётся, а не предполагается ────────────────

test("OPS-04: deploy.sh создаёт royalhome-shared, только если её нет", (t) => {
  if (skipNoBash(t)) return;
  const fx = deployFixture();
  try {
    // inspect → 1: сети нет.
    write(
      `${fx.bin}/docker`,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${fx.dockerLog}"\n[ "$1 $2" = "network inspect" ] && exit 1\nexit 0\n`,
      0o755,
    );
    let r = runDeploy(fx, ["web", "--no-pull"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(dockerCalls(fx), /^network create royalhome-shared$/m);

    // inspect → 0: сеть есть, create не зовём.
    rmSync(fx.dockerLog, { force: true });
    write(`${fx.bin}/docker`, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${fx.dockerLog}"\nexit 0\n`, 0o755);
    r = runDeploy(fx, ["web", "--no-pull"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(dockerCalls(fx), /^network inspect royalhome-shared$/m);
    assert.doesNotMatch(dockerCalls(fx), /network create/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS-04: bootstrap.sh создаёт royalhome-shared раньше шага с postgres и выкатом", () => {
  const body = text("bootstrap.sh");
  const net = body.indexOf("docker network create royalhome-shared");
  assert.ok(net > 0, "в bootstrap есть docker network create royalhome-shared");
  assert.match(body, /docker network inspect royalhome-shared[^\n]*\n\s*\|\| docker network create royalhome-shared/, "идемпотентно: сначала inspect");
  assert.ok(net < body.indexOf("up -d postgres"), "до подъёма postgres");
  assert.ok(net < body.indexOf('"$REPO_DIR/ops/deploy.sh"'), "до выката");
});

// ── OPS03 · повторный бэкап за день не уничтожает уже готовую копию ───────────────

function backupFixture() {
  const dir = tmp();
  const bin = `${dir}/bin`;
  mkdirSync(bin);
  mkdirSync(`${dir}/repo/ops`, { recursive: true });
  copyFileSync(path.join(OPS, "backup.sh"), `${dir}/repo/ops/backup.sh`);
  copyFileSync(path.join(OPS, "lib.sh"), `${dir}/repo/ops/lib.sh`);
  write(`${dir}/repo/.env.production`, "POSTGRES_USER=royalhome\n");
  // Заглушка docker compose exec: pg_dump и tar печатают метку запуска, отказ — по флагам окружения.
  write(
    `${bin}/docker`,
    `#!/usr/bin/env bash
case "$*" in
  *pg_dump*) [ "\${FAKE_FAIL_DUMP:-0}" = "1" ] && exit 1; printf 'SQL-%s' "\${FAKE_TAG:-x}" ;;
  *"tar czf"*) [ "\${FAKE_FAIL_TAR:-0}" = "1" ] && exit 1; printf 'TAR-%s' "\${FAKE_TAG:-x}" ;;
esac
exit 0
`,
    0o755,
  );
  // rcat читает архив со stdin: заглушка, не дочитавшая поток, роняет tar в
  // SIGPIPE (141), и бэкап падает на шаге видео, которого тест не касается.
  write(`${bin}/rclone`, '#!/usr/bin/env bash\n[ "$1" = "rcat" ] && cat > /dev/null\nexit 0\n', 0o755);
  return { dir, bin, backups: `${dir}/backups` };
}

function runBackup(fx, env) {
  return spawnSync("bash", [`${fx.dir}/repo/ops/backup.sh`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      CRM_BACKUP_DIR: fx.backups,
      WATCHDOG_ENV: `${fx.dir}/нет-такого-файла`,
      ...env,
    },
  });
}

const gunzipText = (file) => {
  const r = spawnSync("bash", ["-c", `gunzip -c "${file}"`], { encoding: "utf8" });
  return r.stdout;
};

test("видео объектов уходит потоком прямо в R2 и не ложится на диск сервера (08.10.2026)", (t) => {
  if (skipNoBash(t)) return;
  const fx = backupFixture();
  try {
    write(
      `${fx.bin}/rclone`,
      `#!/usr/bin/env bash
if [ "$1" = "rcat" ]; then printf '%s\\n' "$*" >> "${fx.dir}/rcat.args"; cat >> "${fx.dir}/rcat.body"; fi
exit 0
`,
      0o755,
    );
    const r = runBackup(fx, { FAKE_TAG: "v" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const local = spawnSync("bash", ["-c", `ls "${fx.backups}" | grep -c property-video || true`], { encoding: "utf8" });
    assert.equal(local.stdout.trim(), "0", "локальной копии видео нет");
    assert.match(readFileSync(`${fx.dir}/rcat.args`, "utf8"), /crm\/crm-property-video-\d{4}-\d{2}-\d{2}\.tar\.gz/);
    assert.equal(readFileSync(`${fx.dir}/rcat.body`, "utf8"), "TAR-v", "в бакет ушёл сам архив");

    // Отдушина: CRM_BACKUP_VIDEO_LOCAL=1 возвращает прежнюю запись на диск.
    assert.equal(runBackup(fx, { FAKE_TAG: "w", CRM_BACKUP_VIDEO_LOCAL: "1" }).status, 0);
    const again = spawnSync("bash", ["-c", `ls "${fx.backups}" | grep -c property-video || true`], { encoding: "utf8" });
    assert.equal(again.stdout.trim(), "1");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS03: неудачный повтор бэкапа в тот же день оставляет прежний дамп базы целым", (t) => {
  if (skipNoBash(t)) return;
  const fx = backupFixture();
  try {
    const first = runBackup(fx, { FAKE_TAG: "first" });
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const dump = spawnSync("bash", ["-c", `ls "${fx.backups}"/crm-db-*.sql.gz`], { encoding: "utf8" }).stdout.trim();
    assert.match(gunzipText(dump), /SQL-first/);

    const second = runBackup(fx, { FAKE_TAG: "second", FAKE_FAIL_DUMP: "1" });
    assert.equal(second.status, 1, "упавший pg_dump — ошибка скрипта");
    assert.ok(existsSync(dump), "дамп дня остался");
    assert.match(gunzipText(dump), /SQL-first/, "и содержимое прежнее, а не обнулённое");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS03: то же для архивов томов; успешный повтор заменяет файл новым, мусора рядом нет", (t) => {
  if (skipNoBash(t)) return;
  const fx = backupFixture();
  try {
    assert.equal(runBackup(fx, { FAKE_TAG: "first" }).status, 0);
    const priv = spawnSync("bash", ["-c", `ls "${fx.backups}"/crm-private-uploads-*.tar.gz`], { encoding: "utf8" }).stdout.trim();
    const read = (f) => readFileSync(f, "utf8");

    // pg_dump проходит, архив приватных вложений падает.
    const bad = runBackup(fx, { FAKE_TAG: "second", FAKE_FAIL_TAR: "1" });
    assert.equal(bad.status, 1);
    assert.equal(read(priv), "TAR-first", "прежний архив не обнулён и не удалён");

    // Успешный повтор — файл заменён целиком новым содержимым.
    assert.equal(runBackup(fx, { FAKE_TAG: "third" }).status, 0);
    assert.equal(read(priv), "TAR-third");
    const leftovers = spawnSync("bash", ["-c", `ls -A "${fx.backups}" | grep -c 'tmp' || true`], { encoding: "utf8" }).stdout.trim();
    assert.equal(leftovers, "0", "временные файлы не остаются");
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS03: backup.sh не пишет `>` прямо в итоговый артефакт дня", () => {
  const body = text("backup.sh");
  assert.doesNotMatch(body, /gzip > "\$BACKUP_DIR\/crm-db-\$STAMP/, "дамп базы не пишется в итоговое имя напрямую");
  assert.doesNotMatch(body, /^\s*> "\$BACKUP_DIR\/crm-[a-z-]+-\$STAMP\.tar\.gz"/m, "архивы томов тоже");
});

// ── OPS02 · восстановление: ошибка SQL — это ошибка, непустую базу не накатываем ───

/** psql-заглушка: печатает ERROR и (как настоящий psql без ON_ERROR_STOP) выходит 0. */
function restoreFixture(psqlBody) {
  const dir = tmp();
  const bin = `${dir}/bin`;
  mkdirSync(bin);
  mkdirSync(`${dir}/repo/ops`, { recursive: true });
  copyFileSync(path.join(OPS, "restore-drill.sh"), `${dir}/repo/ops/restore-drill.sh`);
  copyFileSync(path.join(OPS, "lib.sh"), `${dir}/repo/ops/lib.sh`);
  write(`${dir}/repo/.env.production`, "POSTGRES_USER=royalhome\n");
  write(`${dir}/dump.sql`, "CREATE TABLE a(i int);\n");
  spawnSync("bash", ["-c", `gzip -k -f "${dir}/dump.sql"`]);
  // docker compose … exec -T postgres psql …  → заглушка разбирает, что именно просят.
  write(
    `${bin}/docker`,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/docker.log"
case "$*" in
  *pg_isready*) exit 0 ;;
  *psql*) ${psqlBody} ;;
esac
exit 0
`,
    0o755,
  );
  return { dir, bin, dump: `${dir}/dump.sql.gz`, log: `${dir}/docker.log` };
}

function runRestore(fx, env = {}) {
  return spawnSync("bash", [`${fx.dir}/repo/ops/restore-drill.sh`, "--into-prod", fx.dump], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fx.bin}${path.delimiter}${process.env.PATH}`,
      CONFIRM: "yes",
      WATCHDOG_ENV: `${fx.dir}/нет-такого-файла`,
      ...env,
    },
  });
}

// Заглушка psql: -c-запрос количества таблиц отвечает $TABLES, накат дампа (stdin) печатает ERROR и выходит 0,
// пока в аргументах нет ON_ERROR_STOP — тогда ведёт себя как настоящий psql (код 3).
const PSQL_STUB = `
  if printf '%s' "$*" | grep -q -- '-tAc'; then printf '%s\\n' "\${FAKE_TABLES:-0}"; exit 0; fi
  cat >/dev/null
  echo 'ERROR: relation "a" already exists'
  if printf '%s' "$*" | grep -q 'ON_ERROR_STOP=1'; then exit 3; fi
  exit 0`;

test("OPS02: ошибка SQL при накате в прод — провал, а не «выполнено»", (t) => {
  if (skipNoBash(t)) return;
  const fx = restoreFixture(PSQL_STUB);
  try {
    const r = runRestore(fx, { FAKE_TABLES: "0" });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /восстановление в прод-базу выполнено/);
    const calls = readFileSync(fx.log, "utf8");
    assert.match(calls, /ON_ERROR_STOP=1/);
    assert.match(calls, /--single-transaction/);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS02: непустая база без CRM_RESTORE_WIPE=yes отвергается до накатки", (t) => {
  if (skipNoBash(t)) return;
  const fx = restoreFixture(PSQL_STUB);
  try {
    const r = runRestore(fx, { FAKE_TABLES: "42" });
    assert.notEqual(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /CRM_RESTORE_WIPE=yes/);
    assert.doesNotMatch(readFileSync(fx.log, "utf8"), /DROP SCHEMA/);
    // Накат (psql со stdin) не стартовал вовсе: единственный psql-вызов — подсчёт таблиц.
    assert.equal((readFileSync(fx.log, "utf8").match(/\bpsql\b/g) ?? []).length, 1);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test("OPS02: пустая база принимает копию; CRM_RESTORE_WIPE=yes сносит схему в той же транзакции", (t) => {
  if (skipNoBash(t)) return;
  const ok = restoreFixture(`
  if printf '%s' "$*" | grep -q -- '-tAc'; then printf '%s\\n' "\${FAKE_TABLES:-0}"; exit 0; fi
  cat >> "${"$"}{FAKE_STDIN:-/dev/null}"; exit 0`);
  try {
    const stdin = `${ok.dir}/stdin.sql`;
    let r = runRestore(ok, { FAKE_TABLES: "0", FAKE_STDIN: stdin });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /восстановление в прод-базу выполнено/);
    assert.doesNotMatch(readFileSync(stdin, "utf8"), /DROP SCHEMA/, "в пустую базу ничего не сносим");

    const stdin2 = `${ok.dir}/stdin2.sql`;
    r = runRestore(ok, { FAKE_TABLES: "42", CRM_RESTORE_WIPE: "yes", FAKE_STDIN: stdin2 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const sql = readFileSync(stdin2, "utf8");
    assert.match(sql, /^DROP SCHEMA public CASCADE; CREATE SCHEMA public;/);
    assert.match(sql, /CREATE TABLE a/, "сброс схемы и накат идут одним потоком (одна транзакция)");
  } finally {
    rmSync(ok.dir, { recursive: true, force: true });
  }
});

test("OPS02: учебный прогон тоже строгий: ON_ERROR_STOP, одна транзакция, ERROR в логе — провал", () => {
  const body = text("restore-drill.sh");
  const drill = body.slice(body.indexOf("# 3. Накатить дамп."), body.indexOf("psql_q()"));
  assert.match(drill, /psql -v ON_ERROR_STOP=1 --single-transaction/);
  assert.match(drill, /grep -q '\^ERROR' \/tmp\/crm-restore-drill\.log/);
  assert.doesNotMatch(body, /сотрёт текущее содержимое/, "текст не должен обещать стирание, которого нет");
});
