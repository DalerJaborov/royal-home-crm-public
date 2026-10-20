import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { mergeMachineReports, failureLines } from "./cloud-test-report.mjs";

/** Зелёный отчёт одной машины: `files` файлов по одному прошедшему тесту. */
function machineReport(files) {
  return {
    success: true,
    numTotalTests: files.length,
    numPassedTests: files.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    numTotalTestSuites: files.length,
    numPassedTestSuites: files.length,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    testResults: files.map((name) => ({ name, status: "passed", assertionResults: [{ status: "passed" }] })),
  };
}

function lay(machines) {
  const dir = mkdtempSync(path.join(tmpdir(), "rh-cloud-report-"));
  for (const [m, { report, code }] of Object.entries(machines)) {
    const base = path.join(dir, `machine-${m}`);
    mkdirSync(base, { recursive: true });
    if (report !== undefined) writeFileSync(path.join(base, "api-tests.json"), typeof report === "string" ? report : JSON.stringify(report));
    if (code !== undefined) writeFileSync(path.join(base, "exit-code"), `${code}\n`);
  }
  return dir;
}

test("все машины зелёные — итог зелёный, числа сложены", async () => {
  const dir = lay({ 1: { report: machineReport(["a", "b"]), code: 0 }, 2: { report: machineReport(["c"]), code: 0 } });
  try {
    const { merged, missing, red } = await mergeMachineReports(dir, 2);
    assert.equal(merged.success, true);
    assert.equal(merged.numTotalTests, 3);
    assert.deepEqual([missing, red], [[], []]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("машины без отчёта, с ненулевым кодом, без кода, с битым отчётом — красно", async () => {
  const cases = [
    [{ 1: { report: machineReport(["a"]), code: 0 } }, "вторая машина не прислала ничего"],
    [{ 1: { report: machineReport(["a"]), code: 0 }, 2: { report: machineReport(["b"]), code: 1 } }, "код 1"],
    [{ 1: { report: machineReport(["a"]), code: 0 }, 2: { report: machineReport(["b"]) } }, "кода нет"],
    [{ 1: { report: machineReport(["a"]), code: 0 }, 2: { report: "{не json", code: 0 } }, "битый отчёт"],
    [{ 1: { report: machineReport(["a"]), code: 0 }, 2: { report: machineReport(["a"]), code: 0 } }, "файл прошёл дважды"],
  ];
  for (const [machines, why] of cases) {
    const dir = lay(machines);
    try {
      const { merged } = await mergeMachineReports(dir, 2);
      assert.equal(merged.success, false, why);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("число машин обязано быть числом ≥ 1", async () => {
  await assert.rejects(mergeMachineReports(".", 0), /--machines/);
  await assert.rejects(mergeMachineReports(".", NaN), /--machines/);
});

test("сводка называет упавший файл и тест", () => {
  const lines = failureLines({
    testResults: [
      { name: "/w/apps/api/tests/ok.test.ts", status: "passed", assertionResults: [] },
      { name: "/w/apps/api/tests/bad.test.ts", status: "failed", assertionResults: [{ status: "failed", fullName: "x > y" }] },
    ],
  });
  assert.deepEqual(lines, ["✘ apps/api/tests/bad.test.ts", "    – x > y"]);
});
