// node --test scripts/script-env-order.test.mjs   (он же npm run test:scripts)
//
// Корневые разовые скрипты (scripts/*.ts|mjs, что тянут apps/api/src/db.js) грузят
// apps/api/.env ДО создания клиента Prisma (аудит Codex 04.10, OPS05).
//
// Импорты в ES-модулях вычисляются раньше тела файла, поэтому `loadEnv(...)` строкой
// между импортами выполнялся ПОСЛЕ db.js: тот на верхнем уровне делал
// `new PrismaClient({ adapter: makePrismaAdapter(process.env.DATABASE_URL) })` и уже
// держал адрес из корневого .env (или пустой). Лечит первый импорт с побочным
// эффектом: scripts/_env.cjs (так же устроен apps/api/src/loadEnv.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCRIPTS = [
  "scripts/backfill-contact-profiles.ts",
  "scripts/backfill-instagram-links.ts",
  "scripts/backfill-property-voice.mjs",
  "scripts/estimate-category-lead-kind-flips.ts",
  "scripts/dedupe-auto-tasks.ts",
  "scripts/ads-post-deploy-check.mjs",
  "scripts/audit-bot-chats-28-09.mjs",
  "scripts/audit-miscategorized-leads-23-09.mjs",
];

test("OPS05: каждый корневой скрипт с db.js первым импортом берёт scripts/_env.cjs, а loadEnv() в теле не зовёт", () => {
  for (const rel of SCRIPTS) {
    const body = readFileSync(path.join(ROOT, rel), "utf8");
    const envAt = body.search(/^import "\.\/_env\.cjs";$/m);
    const dbAt = body.search(/^import \{ prisma \} from "\.\.\/apps\/api\/src\/db\.js";$/m);
    assert.ok(envAt >= 0, `${rel}: нет import "./_env.cjs"`);
    assert.ok(dbAt > envAt, `${rel}: db.js должен идти ПОСЛЕ _env.cjs`);
    // Ни один другой статический импорт не стоит раньше _env.cjs: он мог бы потянуть db транзитивно.
    const before = body.slice(0, envAt).match(/^import .*$/gm) ?? [];
    assert.deepEqual(before, [], `${rel}: до _env.cjs стоят импорты ${before.join("; ")}`);
    assert.doesNotMatch(body, /loadEnv\(/, `${rel}: loadEnv() в теле скрипта запоздал бы`);
    assert.doesNotMatch(body, /from "dotenv"/, `${rel}: dotenv подключается только в _env.cjs`);
  }
});

test("OPS05: _env.cjs ставит apps/api/.env раньше корневого .env и не зависит от cwd; к моменту импорта db адрес верный", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-env-order-"));
  try {
    mkdirSync(path.join(dir, "scripts"));
    mkdirSync(path.join(dir, "apps", "api"), { recursive: true });
    mkdirSync(path.join(dir, "elsewhere"));
    copyFileSync(path.join(ROOT, "scripts", "_env.cjs"), path.join(dir, "scripts", "_env.cjs"));
    writeFileSync(path.join(dir, "apps", "api", ".env"), "DATABASE_URL=postgres://api-env\n");
    writeFileSync(path.join(dir, ".env"), "DATABASE_URL=postgres://root-env\nONLY_IN_ROOT=1\n");
    // «db.js»: фиксирует DATABASE_URL в момент вычисления модуля, как new PrismaClient({ adapter }).
    writeFileSync(path.join(dir, "scripts", "fake-db.mjs"), "export const urlAtCreate = process.env.DATABASE_URL;\n");
    writeFileSync(
      path.join(dir, "scripts", "entry.mjs"),
      'import "./_env.cjs";\nimport { urlAtCreate } from "./fake-db.mjs";\nconsole.log(JSON.stringify({ urlAtCreate, root: process.env.ONLY_IN_ROOT ?? null }));\n',
    );
    // cwd = корень проекта (документированный запуск) и cwd = посторонняя папка.
    for (const cwd of [dir, path.join(dir, "elsewhere")]) {
      const env = { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") };
      delete env.DATABASE_URL;
      const r = spawnSync(process.execPath, [path.join(dir, "scripts", "entry.mjs")], { cwd, encoding: "utf8", env });
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.urlAtCreate, "postgres://api-env", `cwd=${cwd}: к созданию клиента должен быть адрес из apps/api/.env`);
    }
    // Из корня виден и остальной корневой .env (прежнее поведение второго вызова loadEnv).
    const env = { ...process.env, NODE_PATH: path.join(ROOT, "node_modules") };
    delete env.DATABASE_URL;
    const fromRoot = spawnSync(process.execPath, [path.join(dir, "scripts", "entry.mjs")], { cwd: dir, encoding: "utf8", env });
    assert.equal(JSON.parse(fromRoot.stdout).root, "1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
