// Документы сделок попадают в ночную копию и в недельную проверку восстановления
// (глубокая проверка 02.10.2026, G3; решение владельца 02.10 «да, по советам»).
// Docker и rclone подменены заглушками в PATH: проверяется, ЧТО ops/backup.sh
// кладёт в архив, о чём докладывает экрану «Резервные копии» и что уезжает
// офсайт; и что ops/restore-drill.sh разворачивает архив документов и
// тревожит, если тот битый или его нет.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ops");
const BACKUP = path.join(OPS, "backup.sh");
const DRILL = path.join(OPS, "restore-drill.sh");
// Та же дата, что `date +%F` в самом скрипте (местное время машины, не UTC).
const STAMP = process.platform === "win32" ? null : spawnSync("date", ["+%F"], { encoding: "utf8" }).stdout.trim();

function stub(bin, name, body) {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(p, 0o755);
}

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-backup-deal-docs-"));
  const bin = path.join(dir, "bin");
  const backups = path.join(dir, "backups");
  const app = path.join(dir, "app"); // то, что внутри контейнера api лежит в /app
  const log = path.join(dir, "calls.log");
  for (const d of [bin, backups, app]) mkdirSync(d, { recursive: true });
  for (const vol of ["uploads", "uploads-private", "uploads-private-video", "uploads-deal-docs"]) {
    mkdirSync(path.join(app, vol), { recursive: true });
  }
  writeFileSync(path.join(app, "uploads-deal-docs", "passport-deal-17.jpg"), "паспорт продавца");
  writeFileSync(path.join(app, "uploads-deal-docs", "contract-deal-17.pdf"), "договор купли-продажи");

  // docker: compose exec api tar — настоящий tar по папке-заменителю /app
  // (файл fail_<папка> роняет архив этой папки); compose exec api node — отчёт
  // экрану «Резервные копии», пишется в журнал; pg_dump — короткий текст;
  // docker exec … psql -tAc — ответы временной базы проверки восстановления.
  stub(bin, "docker", `
args="$*"
case "$args" in
  *" api node "*) echo "report $REPORT_JSON" >> "${log}"; exit 0;;
  *" api tar czf - -C /app "*)
    vol="\${@: -1}"
    [ -f "${dir}/fail_$vol" ] && exit 1
    tar czf - -C "${app}" "$vol"; exit $?;;
  *pg_dump*) echo "-- dump"; exit 0;;
  *pg_isready*) exit 0;;
  *information_schema*) echo 40; exit 0;;
  *_prisma_migrations*) echo 1; exit 0;;
  *EXTRACT*) echo 1; exit 0;;
  *"SELECT count"*) echo 5; exit 0;;
  "exec -i "*) cat > /dev/null; exit 0;;
esac
exit 0`);
  // rclone copy <откуда> <куда> --include <шаблон>: пишет в журнал, какие
  // файлы шаблон забрал бы офсайт.
  // rclone rcat <куда> (08.10.2026, видео потоком в R2): заглушка обязана
  // дочитать поток, иначе tar получает SIGPIPE (141), pipefail роняет шаг, и
  // ночная копия «падает» только в тесте — на Linux, где тест не пропускается.
  stub(bin, "rclone", `
if [ "$1" = "rcat" ]; then cat > /dev/null; echo "offsite-stream \${@: -1}" >> "${log}"; exit 0; fi
src="$2"; pat=""
while [ $# -gt 0 ]; do [ "$1" = "--include" ] && pat="$2"; shift; done
for f in "$src"/$pat; do [ -f "$f" ] && echo "offsite $(basename "$f")" >> "${log}"; done
exit 0`);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CRM_BACKUP_DIR: backups,
    WATCHDOG_ENV: path.join(dir, "no-watchdog.env"),
    BACKUP_REPORT_API_KEY: "k",
  };
  const run = (script) => spawnSync("bash", [script], { encoding: "utf8", env });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const reports = () => calls().filter((c) => c.startsWith("report ")).map((c) => JSON.parse(c.slice(7)));
  return { dir, app, backups, run, calls, reports, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const linuxOnly = (t) => {
  if (process.platform !== "win32") return false;
  t.skip("копии снимаются на Linux-сервере");
  return true;
};

test("ночная копия архивирует документы сделок, докладывает DEAL_DOCS и увозит архив офсайт", (t) => {
  if (linuxOnly(t)) return;
  const s = setup();
  try {
    const r = s.run(BACKUP);
    assert.equal(r.status, 0, r.stderr + r.stdout);

    const archive = path.join(s.backups, `crm-deal-docs-${STAMP}.tar.gz`);
    assert.ok(existsSync(archive), `нет ${archive}; есть: ${readdirSync(s.backups).join(", ")}`);
    const listing = spawnSync("tar", ["tzf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /uploads-deal-docs\/passport-deal-17\.jpg/);
    assert.match(listing.stdout, /uploads-deal-docs\/contract-deal-17\.pdf/);

    const dealDocs = s.reports().filter((x) => x.kind === "DEAL_DOCS");
    assert.equal(dealDocs.length, 1, JSON.stringify(s.reports()));
    assert.equal(dealDocs[0].success, true);
    assert.ok(dealDocs[0].sizeLabel, "размер архива виден на экране");

    assert.ok(s.calls().includes(`offsite crm-deal-docs-${STAMP}.tar.gz`), s.calls().join("\n"));
  } finally {
    s.done();
  }
});

test("сбой архива документов — тревога DEAL_DOCS, недописанный архив удалён, база цела", (t) => {
  if (linuxOnly(t)) return;
  const s = setup();
  try {
    writeFileSync(path.join(s.dir, "fail_uploads-deal-docs"), "");
    const r = s.run(BACKUP);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /deal docs archive failed/);

    const failed = s.reports().filter((x) => x.kind === "DEAL_DOCS");
    assert.equal(failed.length, 1, JSON.stringify(s.reports()));
    assert.equal(failed[0].success, false);

    assert.ok(!existsSync(path.join(s.backups, `crm-deal-docs-${STAMP}.tar.gz`)), "недописанный архив не остаётся");
    assert.ok(existsSync(path.join(s.backups, `crm-db-${STAMP}.sql.gz`)), "снятый дамп базы не удаляется");
  } finally {
    s.done();
  }
});

test("проверка восстановления разворачивает архив документов сделок", (t) => {
  if (linuxOnly(t)) return;
  const s = setup();
  try {
    assert.equal(s.run(BACKUP).status, 0);
    const r = s.run(DRILL);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /документы сделок: OK \(2 файл/);
    const drill = s.reports().filter((x) => x.kind === "RESTORE_DRILL");
    assert.equal(drill.length, 1);
    assert.equal(drill[0].success, true);
    assert.match(drill[0].detail, /документов сделок=2/);
  } finally {
    s.done();
  }
});

test("битый архив документов сделок — проверка восстановления красная", (t) => {
  if (linuxOnly(t)) return;
  const s = setup();
  try {
    assert.equal(s.run(BACKUP).status, 0);
    writeFileSync(path.join(s.backups, `crm-deal-docs-${STAMP}.tar.gz`), "не архив");
    const r = s.run(DRILL);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /документ.*сделок/);
    const drill = s.reports().filter((x) => x.kind === "RESTORE_DRILL");
    assert.equal(drill.at(-1).success, false);
  } finally {
    s.done();
  }
});

test("архива документов сделок нет вовсе — проверка восстановления красная", (t) => {
  if (linuxOnly(t)) return;
  const s = setup();
  try {
    assert.equal(s.run(BACKUP).status, 0);
    rmSync(path.join(s.backups, `crm-deal-docs-${STAMP}.tar.gz`), { force: true });
    const r = s.run(DRILL);
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /crm-deal-docs/);
  } finally {
    s.done();
  }
});
