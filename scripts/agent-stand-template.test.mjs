// node --test scripts/agent-stand-template.test.mjs   (он же npm run test:scripts)
//
// Эталонная база стенда (scripts/agent-stand.mjs) не принимает недособранную за
// готовую (аудит Codex 04.10, OPS09). Docker и Postgres не нужны: действия над
// общим контейнером подменены базой-реестром в памяти.
import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureTemplate, READY_MARK } from "./agent-stand.mjs";

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
