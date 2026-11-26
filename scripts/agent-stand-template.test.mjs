// node --test scripts/agent-stand-template.test.mjs   (он же npm run test:scripts)
//
// Эталонная база стенда (scripts/agent-stand.mjs) не принимает недособранную за
// готовую (аудит Codex 04.10, OPS09). Docker и Postgres не нужны: действия над
// общим контейнером подменены базой-реестром в памяти.
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import path from "node:path";

import { ensureTemplate, READY_MARK, standEnv, e2eHint, pidBelongsToStand, choosePgMode, externalConfig } from "./agent-stand.mjs";

/** Реестр баз: имя → { mark }. Ошибки миграции/сида включаются флагами. */
function fakeIo({ failMigrate = false, failSeed = false, legacy = null, onBuild = () => {} } = {}) {
  const dbs = new Map();
  if (legacy) dbs.set("seeded", { mark: false, complete: legacy === "complete" });
  const calls = [];
  const io = {
    dbExists: (db) => dbs.has(db),
    createDb: (db) => {
      calls.push(`create ${db}`);
      dbs.set(db, { mark: false, complete: false });
    },
    dropDb: (db) => {
      calls.push(`drop ${db}`);
      dbs.delete(db);
    },
    renameDb: (from, to) => {
      calls.push(`rename ${from}>${to}`);
      assert.ok(!dbs.has(to), "переименование поверх существующей базы");
      dbs.set(to, dbs.get(from));
      dbs.delete(from);
    },
    setMark: (db) => {
      calls.push(`mark ${db}`);
      dbs.get(db).mark = true;
    },
    hasMark: (db) => dbs.get(db)?.mark === true,
    looksComplete: (db) => dbs.get(db)?.complete === true,
    migrate: (db) => {
      calls.push(`migrate ${db}`);
      if (failMigrate) throw new Error("migrate упал");
      dbs.get(db).complete = false; // схема есть, сида ещё нет
    },
    seed: (db) => {
      calls.push(`seed ${db}`);
      if (failSeed) throw new Error("seed упал");
      dbs.get(db).complete = true;
      onBuild(dbs);
    },
  };
  return { io, dbs, calls };
}

test("OPS09: упавшая миграция не оставляет «готовый» эталон; повтор собирает заново, а не клонирует пустой", () => {
  const f = fakeIo({ failMigrate: true });
  assert.throws(() => ensureTemplate(f.io, { building: "seeded_building_1" }), /migrate упал/);
  assert.equal(f.dbs.has("seeded"), false, "эталон seeded не создан");
  assert.equal(f.dbs.has("seeded_building_1"), false, "временная база убрана");

  // Второй up (миграции уже работают): без исправления он принял бы пустую seeded за готовую.
  const ok = fakeIo();
  assert.equal(ensureTemplate(ok.io, { building: "seeded_building_1" }), "собран");
  assert.ok(ok.calls.includes("migrate seeded_building_1") && ok.calls.includes("seed seeded_building_1"));
  assert.equal(ok.dbs.get("seeded").mark, true, "готовый эталон помечен");
  assert.equal(ok.dbs.has("seeded_building_1"), false);
});

test("OPS09: упавший сид так же не оставляет эталона", () => {
  const f = fakeIo({ failSeed: true });
  assert.throws(() => ensureTemplate(f.io, { building: "seeded_building_1" }), /seed упал/);
  assert.equal(f.dbs.has("seeded"), false);
  assert.equal(f.dbs.has("seeded_building_1"), false);
});

test("OPS09: готовый помеченный эталон не пересобирается", () => {
  const f = fakeIo();
  ensureTemplate(f.io, { building: "b" });
  f.calls.length = 0;
  assert.equal(ensureTemplate(f.io, { building: "b" }), "готов");
  assert.deepEqual(f.calls, []);
});

test("OPS09: эталон, оставленный прежним кодом (метки нет, недонакачан), заменяется собранным заново", () => {
  const f = fakeIo({ legacy: "partial" });
  assert.equal(ensureTemplate(f.io, { building: "b" }), "собран");
  assert.ok(f.calls.includes("drop seeded") && f.calls.includes("rename b>seeded"));
  assert.equal(f.dbs.get("seeded").mark, true);
});

test("OPS09: прежний полный эталон без метки принимается и получает метку без пересборки", () => {
  const f = fakeIo({ legacy: "complete" });
  assert.equal(ensureTemplate(f.io, { building: "b" }), "готов");
  assert.deepEqual(f.calls, ["mark seeded"]);
});

test("OPS09: refresh (force) при падении сборки оставляет прежний рабочий эталон", () => {
  const f = fakeIo({ legacy: "complete", failSeed: true });
  assert.throws(() => ensureTemplate(f.io, { force: true, building: "b" }), /seed упал/);
  assert.equal(f.dbs.has("seeded"), true, "рабочий эталон не тронут");
  assert.equal(f.dbs.get("seeded").complete, true);
  assert.equal(f.dbs.has("b"), false);
});

test("OPS09: сосед успел собрать эталон, пока строили свой, — берём его, свой убираем", () => {
  const f = fakeIo({
    onBuild: (dbs) => {
      dbs.set("seeded", { mark: true, complete: true });
    },
  });
  assert.equal(ensureTemplate(f.io, { building: "seeded_building_2" }), "собрал сосед");
  assert.equal(f.dbs.has("seeded_building_2"), false);
  assert.equal(f.dbs.get("seeded").mark, true);
  assert.equal(READY_MARK, "rh-stand-ready");
});

// ОКРУЖЕНИЕ СТЕНДА (20.11.2026, Чат 3). Вход только по коду: без
// LOGIN_CODE_DEV_ECHO=1 стенд кода не отдаёт, и войти формой нельзя вовсе —
// так `serve` уронил e2e auth.setup 18.11. Список один на up и serve.
test("standEnv: стенд отдаёт код входа и не притворяется продом", () => {
  const env = standEnv("4799", "5299");
  assert.equal(env.LOGIN_CODE_DEV_ECHO, "1");
  assert.notEqual(env.NODE_ENV, "production", "в production сервер кода не отдаст и не стартует (env-check.ts)");
  assert.equal(env.DATABASE_URL, "postgresql://postgres:postgres@localhost:15500/agent_4799");
  assert.equal(env.PORT, "4799");
  assert.equal(env.VITE_API_PROXY, "http://localhost:4799");
  assert.equal(env.CORS_ORIGIN, "http://localhost:5299");
  assert.match(e2eHint("4799", "5299"), /E2E_BASE_URL=http:\/\/localhost:5299 E2E_API_URL=http:\/\/localhost:4799/);
});

test("up и serve берут окружение из standEnv, а не из своих копий списка", () => {
  const src = readFileSync(new URL("./agent-stand.mjs", import.meta.url), "utf8");
  // Прежние копии: литералы `$env:JWT_...` в serve и `JWT_ACCESS_SECRET=stand-` в up.
  assert.doesNotMatch(src, /\$env:JWT_ACCESS_SECRET/);
  assert.doesNotMatch(src, /`JWT_ACCESS_SECRET=stand-/);
  assert.equal((src.match(/Object\.entries\(standEnv\(\)\)/g) ?? []).length, 2, "и up, и serve зовут standEnv()");
});

// down по устаревшему файлу PID убивал чужой стенд (20.11.2026): номер
// процесса Windows выдаёт заново. Гасим только процесс со своим логом в строке.
test("pidBelongsToStand: свой процесс узнаётся по логу с портом, чужой — нет", () => {
  const own = String.raw`C:\WINDOWS\system32\cmd.exe /c npx tsx src/index.ts > "D:\CRM\.rh-stand\api-4799.log" 2>&1`;
  assert.equal(pidBelongsToStand(own, "api-4799.log"), true);
  assert.equal(pidBelongsToStand(own.replace("4799", "4796"), "api-4799.log"), false, "соседний стенд");
  assert.equal(pidBelongsToStand(String.raw`"node" D:\CRM-wt\x\tsx\dist\cli.mjs src/index.ts`, "api-4799.log"), false, "чужой API без нашего лога");
  assert.equal(pidBelongsToStand("", "api-4799.log"), false, "процесса нет");
});

// РЕЖИМ БЕЗ DOCKER (26.11.2026). Docker Desktop на ПК владельца иногда мёртв —
// тогда стенд обязан сам перейти на внешний Postgres, а при живом Docker
// поведение прежнее (регрессий нет).
test("choosePgMode: Docker жив — Docker, даже если внешний Postgres тоже доступен", () => {
  assert.equal(choosePgMode({ env: {}, dockerOk: true, externalUp: true }).mode, "docker");
});

test("choosePgMode: Docker мёртв и внешний Postgres доступен — внешний", () => {
  assert.equal(choosePgMode({ env: {}, dockerOk: false, externalUp: true }).mode, "external");
});

test("choosePgMode: Docker мёртв и внешнего нет — остаёмся на Docker (упадёт его честная ошибка, а не молчание)", () => {
  assert.equal(choosePgMode({ env: {}, dockerOk: false, externalUp: false }).mode, "docker");
});

test("choosePgMode: STAND_PG принудительно решает независимо от проб", () => {
  assert.equal(choosePgMode({ env: { STAND_PG: "external" }, dockerOk: true, externalUp: false }).mode, "external");
  assert.equal(choosePgMode({ env: { STAND_PG: "docker" }, dockerOk: false, externalUp: true }).mode, "docker");
  assert.equal(choosePgMode({ env: { STAND_PG: "EXTERNAL " }, dockerOk: true, externalUp: false }).mode, "external", "регистр и пробелы не важны");
  assert.equal(choosePgMode({ env: { STAND_PG: "мусор" }, dockerOk: false, externalUp: true }).mode, "docker", "непонятное значение не включает внешний молча");
});

test("externalConfig: умолчания — portable Postgres 127.0.0.1:15502, переменные STAND_PG_* переопределяют", () => {
  const d = externalConfig({});
  assert.deepEqual([d.host, d.port, d.user, d.password], ["127.0.0.1", "15502", "postgres", "postgres"]);
  assert.equal(path.win32.normalize(d.bin), path.win32.normalize("D:/PgPortable/pgsql/bin"));
  const bin = "C:/pg/bin";
  const o = externalConfig({ STAND_PG_HOST: "10.0.0.5", STAND_PG_PORT: "16000", STAND_PG_BIN: bin });
  assert.deepEqual([o.host, o.port, o.bin], ["10.0.0.5", "16000", bin]);
});

// Все обращения к базе идут через общие помощники: ни одного голого
// `docker exec` вне веток режима Docker, ни прежнего `psql(` с командной строкой.
test("agent-stand: к базе обращаются только через pgRun/psqlOut/dbExists, голых docker exec вне Docker-веток нет", () => {
  const src = readFileSync(new URL("./agent-stand.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /shLoud\(psql\(/, "прежний помощник psql() убран");
  const dockerExecs = src.split("\n").filter((l) => /docker exec/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l));
  assert.equal(dockerExecs.length, 4, "docker exec остался ровно в pgRun, ensureServer, psqlOut и dbExists (каждый в ветке режима Docker)");
});

// down сносит базу только по записи СВОЕГО up (чужой порт — чужая база).
test("agent-stand: down проверяет запись стенда и дерево-владельца", () => {
  const src = readFileSync(new URL("./agent-stand.mjs", import.meta.url), "utf8");
  assert.match(src, /readStandState\(\)/);
  assert.match(src, /sameTree\(st\.root, ROOT\)/);
  assert.match(src, /writeStandState\(\)/);
});
