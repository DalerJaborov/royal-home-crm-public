#!/usr/bin/env node
/**
 * СКЛЕЙКА ОТЧЁТОВ ОБЛАЧНОГО ПРОГОНА ТЕСТОВ СЕРВЕРА (20.10.2026).
 *
 *   node scripts/cloud-test-report.mjs --dir=<папка> --machines=18 --out=<файл>
 *
 * `.github/workflows/ship-tests.yml` гоняет `apps/api/tests` на M машинах; каждая
 * кладёт артефакт `machine-<m>` с двумя файлами: `api-tests.json` (склеенный отчёт
 * её процессов из `runParallel.ts`) и `exit-code` (код возврата `runParallel.ts`).
 * Здесь они сводятся в один отчёт, и вердикт ТОТ ЖЕ, что у локального прогона:
 * `mergeShardReports`/`shardVerdict` из `apps/api/tests/runParallelVerdict.ts`
 * (Node 24 читает этот .ts сам, без tsx). Своего второго правила «что считать
 * зелёным» здесь нет намеренно.
 *
 * Красно, если: нет артефакта хотя бы одной машины; код не 0 или его нет; отчёт
 * не читается; любой файл тестов не «passed»; один и тот же файл прошёл на двух
 * машинах (доли разъехались). Зелёный итог — ровно M зелёных машин.
 *
 * Тем же модулем пользуется `scripts/ship.mjs` (облачный режим): он скачивает
 * артефакт итога и проверяет его сам, а не верит слову «success» у прогона.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function verdictModule() {
  return import(pathToFileURL(path.join(ROOT, "apps", "api", "tests", "runParallelVerdict.ts")).href);
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readCode(file) {
  if (!existsSync(file)) return 1;
  const text = readFileSync(file, "utf8").trim();
  return /^\d+$/.test(text) ? Number(text) : 1;
}

/**
 * Свести отчёты машин. `dir` — папка, куда download-artifact разложил артефакты
 * по одному подкаталогу `machine-<m>`. Возвращает склеенный отчёт и списки
 * машин без отчёта и красных.
 */
export async function mergeMachineReports(dir, machines) {
  if (!Number.isSafeInteger(machines) || machines < 1) throw new Error(`--machines ждёт число ≥ 1, а пришло «${machines}»`);
  const { mergeShardReports, shardVerdict } = await verdictModule();
  const reports = [];
  const codes = [];
  const missing = [];
  const red = [];
  for (let m = 1; m <= machines; m++) {
    const base = path.join(dir, `machine-${m}`);
    const rep = readJson(path.join(base, "api-tests.json"));
    const code = readCode(path.join(base, "exit-code"));
    if (rep === null) missing.push(m);
    else if (shardVerdict(code, rep) !== "green") red.push(m);
    reports.push(rep);
    codes.push(code);
  }
  const merged = mergeShardReports(reports, codes);
  return { merged, missing, red };
}

/** Короткая сводка: имена упавших файлов и тестов — то, что нужно прочесть первым. */
export function failureLines(merged, limit = 60) {
  const out = [];
  for (const file of Array.isArray(merged.testResults) ? merged.testResults : []) {
    if (file?.status === "passed") continue;
    out.push(`✘ ${String(file?.name ?? "?").replace(/^.*?apps[\\/]api[\\/]/, "apps/api/")}`);
    for (const a of Array.isArray(file?.assertionResults) ? file.assertionResults : []) {
      if (a?.status === "failed") out.push(`    – ${a.fullName ?? a.title ?? "?"}`);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

function arg(argv, name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main(argv) {
  const dir = arg(argv, "dir");
  const machines = Number(arg(argv, "machines"));
  const out = arg(argv, "out");
  if (!dir || !out) throw new Error("нужны --dir=<папка артефактов> --machines=<M> --out=<файл>");
  const { merged, missing, red } = await mergeMachineReports(dir, machines);
  writeFileSync(out, JSON.stringify(merged));
  const lines = [
    `машин ${machines}: файлов ${merged.testResults.length}, тестов ${merged.numTotalTests ?? 0}, упало ${merged.numFailedTests ?? 0}`,
    ...(missing.length ? [`машины без отчёта (умерли или не стартовали): ${missing.join(", ")}`] : []),
    ...(red.length ? [`красные машины: ${red.join(", ")}`] : []),
    `итог: ${merged.success ? "ЗЕЛЁНЫЙ" : "КРАСНЫЙ"}`,
  ];
  const fails = failureLines(merged);
  console.log(lines.join("\n"));
  if (fails.length) console.log(fails.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = ["## Тесты сервера, облачный прогон", "", ...lines.map((l) => `- ${l}`)];
    if (fails.length) md.push("", "```", ...fails, "```");
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join("\n") + "\n");
  }
  return merged.success ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    },
  );
}
