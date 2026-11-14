#!/usr/bin/env node
// node --test scripts/audit-function-registry.test.mjs   (входит в npm run test:scripts)
//
// Сторож реестра функций (scripts/audit-function-registry.mjs): новая переменная-рубильник
// без записи в реестре — красная сборка; запись про исчезнувшую переменную — тоже.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findProblems, findSwitchReads, registryEnvNames, stripComments } from "./audit-function-registry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = `
export const FUNCTION_REGISTRY = [
  { key: "a", env: ["FOO_LIVE", "BAR_MODE"] },
  { key: "b", env: ["CRM_NARRATION_EXECUTION_MODE"] },
  { key: "c" },
];`;

test("читает process.env.X, env.X, process.env[\"X\"] и вызов mediaExecutionMode", () => {
  const text = `
    if (process.env.FOO_LIVE === "1") {}
    const m = env.BAR_MODE;
    const z = process.env["BAZ_ENABLED"];
    mediaExecutionMode("OWNER_REPORT");
    const model = process.env.GEMINI_MODEL; // не рубильник
    const key = process.env.SOME_API_KEY;   // не рубильник
  `;
  assert.deepEqual([...findSwitchReads(text)].sort(), ["BAR_MODE", "BAZ_ENABLED", "CRM_OWNER_REPORT_EXECUTION_MODE", "FOO_LIVE"]);
});

test("комментарий с именем переменной чтением не считается", () => {
  const text = `// см. process.env.GHOST_LIVE\n/* env.OTHER_MODE */\nconst a = 1;`;
  assert.equal(stripComments(text).includes("GHOST_LIVE"), false);
  assert.equal(findSwitchReads(text).size, 0);
});

test("разбирает env из записей реестра", () => {
  assert.deepEqual([...registryEnvNames(REGISTRY)].sort(), ["BAR_MODE", "CRM_NARRATION_EXECUTION_MODE", "FOO_LIVE"]);
});

test("новая переменная без записи — проблема, учтённая — нет", () => {
  const files = {
    "apps/api/src/a.ts": `if (process.env.FOO_LIVE) {} const x = env.BAR_MODE; mediaExecutionMode("NARRATION");`,
    "apps/api/src/b.ts": `if (process.env.NEW_THING_LIVE === "1") {}`,
  };
  const { missing, stale } = findProblems(files, REGISTRY);
  assert.deepEqual(missing, [{ name: "NEW_THING_LIVE", file: "apps/api/src/b.ts" }]);
  assert.deepEqual(stale, []);
});

test("запись реестра про исчезнувшую переменную — проблема", () => {
  const { missing, stale } = findProblems({ "apps/api/src/a.ts": `if (process.env.FOO_LIVE) {}` }, REGISTRY);
  assert.deepEqual(missing, []);
  assert.deepEqual(stale.sort(), ["BAR_MODE", "CRM_NARRATION_EXECUTION_MODE"]);
});

test("настоящий репозиторий: сторож зелёный", () => {
  const r = spawnSync(process.execPath, [path.join(HERE, "audit-function-registry.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readFileSync(path.join(HERE, "..", "packages", "shared", "src", "functionStatus.ts"), "utf8").includes("FUNCTION_REGISTRY"));
});
