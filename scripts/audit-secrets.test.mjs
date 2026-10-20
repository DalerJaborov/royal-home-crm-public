#!/usr/bin/env node
// node --test scripts/audit-secrets.test.mjs   (входит в npm run test:scripts)
//
// Сторож секретов и номеров клиентов (scripts/audit-secrets.mjs, 20.10.2026).
// Правило CLAUDE.md: новый сторож проверяется ВНЕСЕНИЕМ той поломки, которую он
// обязан ловить, — поэтому здесь в одноразовый репозиторий кладутся настоящие по
// виду ключи и номер, и проверяется, что коммит НЕ проходит.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addedLines, findPhones, findSecrets, forbiddenFiles, maskPhones, scanLines } from "./audit-secrets.mjs";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "audit-secrets.mjs");
// Собираем «ключи» из кусков, чтобы сам этот файл не выглядел секретом для сторожа.
const FAKE_OPENAI = "sk-" + "proj-" + "A".repeat(10) + "b1C2d3E4f5G6h7I8j9K0lMnOpQrStUv";
const FAKE_TG = "123456789" + ":AA" + "x".repeat(33);
const FAKE_GOOGLE = "AIza" + "S".repeat(35);
const PHONE = "+992 93 0" + "00 10 43";

test("ловит ключи по виду в любом файле", () => {
  assert.deepEqual(findSecrets(`const k = "${FAKE_OPENAI}";`, "apps/api/src/x.ts"), ["ключ OpenAI"]);
  assert.deepEqual(findSecrets(`token: ${FAKE_TG}`, "docs/a.md"), ["токен Telegram-бота"]);
  assert.deepEqual(findSecrets(`GOOGLE=${FAKE_GOOGLE}`, "apps/api/tests/a.test.ts"), ["ключ Google"]);
  assert.deepEqual(findSecrets("-----BEGIN OPENSSH " + "PRIVATE KEY-----", "ops/x"), ["приватный ключ"]);
});

test("присваивание секрета: настоящее значение ловится, заглушки и тесты — нет", () => {
  assert.deepEqual(findSecrets('PAYOM_API_TOKEN="k9Fq2Lr8Zp1Wm4Ty7Bn3Vc6X"', "ops/deploy.sh"), ["значение PAYOM_API_TOKEN"]); // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
  assert.deepEqual(findSecrets('JWT_ACCESS_SECRET="change-me-access"', "apps/api/.env.example"), []);
  assert.deepEqual(findSecrets("JWT_ACCESS_SECRET=stand-4791-access-secret-0123456789", ".claude/launch.json"), []);
  assert.deepEqual(findSecrets("JWT_ACCESS_SECRET: ${{ secrets.JWT }}", ".github/workflows/x.yml"), []);
  assert.deepEqual(findSecrets('const SETTINGS_ENCRYPTION_KEY = "9957ce11aa22bb33cc44dd55ee66ff77"', "apps/api/tests/a.test.ts"), []); // gitleaks:allow -- reviewed synthetic test value or non-secret identifier
  assert.deepEqual(findSecrets("const BEARER_TOKEN = /Bearer\\s+[\\w.~+/=-]+/gi;", "apps/api/src/a.ts"), []);
  assert.deepEqual(findSecrets(`k = "${FAKE_OPENAI}" // secret-scan: allow — пример из документации`, "docs/a.md"), []);
});

test("картинка base64 в HTML — не ключ", () => {
  const img = '<img src="data:image/jpeg;base64,/9j/4AAQ+EAAC2z' + "q".repeat(80) + '">';
  assert.deepEqual(findSecrets(img, "docs/design/a.html"), []);
});

test("номера: настоящий ловится, вымышленные, хеши, цены и имена записей — нет", () => {
  assert.equal(findPhones(`клиент ${PHONE} писал`).length, 1);
  assert.equal(findPhones("звонил 930001043 вчера").length, 1);
  assert.equal(findPhones("логин `+992900000003`").length, 0);
  assert.equal(findPhones("городской 446501414").length, 0);
  assert.equal(findPhones("коммит 501232723 в main").length, 0);
  assert.equal(findPhones("цена «450000000»").length, 0);
  assert.equal(findPhones("файл out-930001001-1010-20261019.wav").length, 0);
});

test("маска оставляет последние четыре цифры", () => {
  assert.equal(maskPhones(`клиент ${PHONE}, ещё 930001043`), "клиент +992•••••1043, ещё +992•••••1043");
  assert.equal(maskPhones("логин +992900000000"), "логин +992900000000");
});

test("файлы .env и ключей запрещены, примеры — нет", () => {
  assert.deepEqual(
    forbiddenFiles([".env", "apps/api/.env.local", ".env.production", ".env.production.example", "apps/api/.env.example", "deploy/id_ed25519", "k.pem"]),
    [".env", "apps/api/.env.local", ".env.production", "deploy/id_ed25519", "k.pem"]
  );
});

test("разбор диффа: только добавленные строки, номера только в документах", () => {
  const diff = [
    "diff --git a/docs/a.md b/docs/a.md",
    "--- a/docs/a.md",
    "+++ b/docs/a.md",
    "@@ -1,0 +5,2 @@",
    `+клиент ${PHONE}`,
    "+обычная строка",
    "diff --git a/apps/api/tests/b.test.ts b/apps/api/tests/b.test.ts",
    "--- a/apps/api/tests/b.test.ts",
    "+++ b/apps/api/tests/b.test.ts",
    "@@ -3 +3 @@",
    "-старое",
    `+const phone = "${PHONE}";`,
  ].join("\n");
  const lines = addedLines(diff);
  assert.deepEqual(
    lines.map((l) => `${l.file}:${l.line}`),
    ["docs/a.md:5", "docs/a.md:6", "apps/api/tests/b.test.ts:3"]
  );
  assert.deepEqual(scanLines(lines), [{ file: "docs/a.md", line: 5, kind: "номер телефона в документе" }]);
});

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-secrets-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, path.join(dir, "scripts", "audit-secrets.mjs"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "core.hooksPath", ".no-hooks");
  git("add", ".");
  git("commit", "-qm", "init");
  return { dir, git };
}

test("--staged: коммит с ключом, с номером в документе и с .env не проходит, чистый — проходит", () => {
  const { dir, git } = repo();
  try {
    const run = () => spawnSync(process.execPath, ["scripts/audit-secrets.mjs", "--staged"], { cwd: dir, encoding: "utf8" });

    writeFileSync(path.join(dir, "ok.md"), "обычный текст\n");
    git("add", "ok.md");
    assert.equal(run().status, 0);

    writeFileSync(path.join(dir, "leak.ts"), `export const k = "${FAKE_OPENAI}";\n`);
    git("add", "leak.ts");
    const leak = run();
    assert.equal(leak.status, 1);
    assert.match(leak.stderr, /leak\.ts:1 — ключ OpenAI/);
    assert.ok(!leak.stderr.includes(FAKE_OPENAI), "сторож не печатает найденное значение");
    git("rm", "-q", "--cached", "leak.ts");

    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "razbor.md"), `клиент ${PHONE}\n`);
    git("add", "docs/razbor.md");
    assert.equal(run().status, 1);
    git("rm", "-q", "--cached", "docs/razbor.md");

    writeFileSync(path.join(dir, ".env"), "X=1\n");
    git("add", "-f", ".env");
    assert.match(run().stderr, /\.env — файл секретов/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
