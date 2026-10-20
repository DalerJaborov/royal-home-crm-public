#!/usr/bin/env tsx
/**
 * ПРОГОН ТЕСТОВ API В НЕСКОЛЬКО ПРОЦЕССОВ, У КАЖДОГО СВОЯ БАЗА.
 *
 *   npm run test --workspace=apps/api                  # параллельно, N процессов
 *   npm run test --workspace=apps/api -- tests/x.test.ts   # один процесс, как раньше
 *   npm run test:seq --workspace=apps/api              # один процесс и общая база
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ РАННЕР, А НЕ `fileParallelism: true`. Внутренняя
 * параллельность vitest при `isolate: true` пересоздаёт процесс после КАЖДОГО
 * файла — 484 запуска Node вместо одного. Замер 12.09.2026: ≈7 с на файл
 * против 1,67 с у последовательного прогона, то есть четырёхкратная
 * параллельность дала ноль. Отключить изоляцию нельзя: файлы делят замоканные
 * модули (проверено 12.08.2026). Развёрнуто — в `dbPerWorker.ts`.
 *
 * Поэтому параллельность здесь: N независимых процессов vitest, каждому своя
 * доля файлов (`--shard=i/N`), внутри каждого файлы идут последовательно
 * в изолированных workers Vitest 4, и своя база.
 *
 * ОТЧЁТ СКЛЕИВАЕТСЯ В ОДИН. Шаг CI «API tests really ran» существует потому,
 * что 03.09.2026 воркер vitest упал после 12 файлов из 417, а код возврата
 * остался 0 — зелёный CI означал бы, что проверено 3%. Шардов теперь четыре, и
 * та же беда с любым из них была бы ещё незаметнее. Здесь склеенный отчёт
 * считается ЧЕСТНЫМ только если каждый шард вернул ноль и оставил свой файл
 * отчёта; иначе прогон объявляется неуспешным независимо от содержимого.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isCI, isParallelDbEnabled, parseShardOf, resolveWorkerPlan } from "./dbPerWorker.js";
import { dropWorkerDatabases, prepareWorkerDatabases } from "./prepareDatabases.js";

const require = createRequire(import.meta.url);
const VITEST_BIN = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
/** Шарды запускаются из корня apps/api — там лежит vitest.config.ts. */
const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** `--report <путь>` — куда положить склеенный JSON-отчёт (нужен CI). */
function takeReportPath(argv: string[]): { report?: string; rest: string[] } {
  const rest: string[] = [];
  let report: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") report = argv[++i];
    else if (a.startsWith("--report=")) report = a.slice("--report=".length);
    else rest.push(a);
  }
  return { report, rest };
}

const { report, rest: passthrough } = takeReportPath(process.argv.slice(2));

/**
 * Сколько процессов. Один — когда параллельность выключена или когда попросили
 * конкретные файлы: делить три файла на четыре шарда бессмысленно, а лишние
 * процессы съедят больше, чем сэкономят. «Попросили файлы» = есть позиционный
 * аргумент, то есть не начинающийся с дефиса. Отсюда единственное требование к
 * остальным флагам: значение писать через равенство (`--exclude=шаблон`), иначе
 * оно будет принято за имя файла и прогон честно сожмётся в один процесс.
 */
const hasFileFilter = passthrough.some((a) => !a.startsWith("-"));
const plan = !isParallelDbEnabled()
  ? { count: 1, reason: "параллельность выключена (VITEST_DB_PARALLEL)" }
  : hasFileFilter
    ? { count: 1, reason: "попросили конкретные файлы" }
    : resolveWorkerPlan();
const workers = plan.count;
// Число и причина — в вывод до старта: иначе «почему два, а не четыре» видно
// только по префиксам строк, а причина (память) не видна вовсе.
console.log(`[тесты] процессов: ${workers} — ${plan.reason}`);
const indices = Array.from({ length: workers }, (_, i) => i + 1);

/**
 * ОДНА МАШИНА ИЗ МНОГИХ (облачный прогон, `.github/workflows/ship-tests.yml`).
 * `VITEST_SHARD_OF=m/M` — эта машина m-я из M. Тогда процесс i здесь берёт
 * общую долю `(m-1)*workers+i` из `M*workers`: все машины делят ОДИН список
 * файлов, и каждый файл проходит ровно на одной из них. Без переменной — как
 * раньше, доли считаются только внутри этой машины.
 */
const shardOf = parseShardOf(process.env.VITEST_SHARD_OF);
const totalShards = workers * shardOf.machines;
const globalShard = (index: number) => (shardOf.machine - 1) * workers + index;
if (shardOf.machines > 1) {
  console.log(`[тесты] машина ${shardOf.machine} из ${shardOf.machines}: общие доли ${globalShard(1)}–${globalShard(workers)} из ${totalShards}`);
}

const tmp = mkdtempSync(path.join(tmpdir(), "rh-vitest-"));
const shardReport = (i: number) => path.join(tmp, `shard-${i}.json`);

/** Строки склеиваются из кусков: иначе префикс попадёт в середину строки. */
function prefixed(stream: NodeJS.ReadableStream, tag: string, out: NodeJS.WriteStream): void {
  if (!tag) {
    stream.pipe(out, { end: false });
    return;
  }
  let tail = "";
  stream.on("data", (chunk: Buffer) => {
    const lines = (tail + chunk.toString("utf8")).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) out.write(`${tag} ${line}\n`);
  });
  stream.on("end", () => {
    if (tail) out.write(`${tag} ${tail}\n`);
  });
}

function runShard(index: number): Promise<number> {
  const args = [
    VITEST_BIN,
    "run",
    ...(totalShards > 1 ? [`--shard=${globalShard(index)}/${totalShards}`] : []),
    "--reporter=default",
    "--reporter=json",
    `--outputFile=${shardReport(index)}`,
    // Репортёр повторов — только в CI, где включён `retry: 1`: без поимённого
    // списка повтор молча превращает плавающий тест в зелёный.
    ...(isCI ? ["--reporter=./tests/reporters/retriedTests.ts"] : []),
    ...passthrough,
  ];
  const child = spawn(process.execPath, args, {
    cwd: API_ROOT,
    env: {
      ...process.env,
      VITEST_DB_INDEX: String(index),
      VITEST_DB_WORKERS: String(workers),
      // Базы уже созданы здесь, до старта шардов: N одновременных
      // `CREATE DATABASE ... TEMPLATE` из одного шаблона — это гонка.
      VITEST_DB_READY: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = workers > 1 ? `[${index}/${workers}]` : "";
  prefixed(child.stdout, tag, process.stdout);
  prefixed(child.stderr, tag, process.stderr);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code: number) => {
      if (settled) return; // и 'error', и 'close' могут прийти оба — берём первый
      settled = true;
      resolve(code);
    };
    // БЕЗ ЭТОГО ОБРАБОТЧИКА: если сам spawn не смог стартовать процесс (ENOENT,
    // испорченный PATH, нет прав), ChildProcess эмитит 'error', на который никто
    // не подписан, — Node бросает это как необработанное исключение и роняет ВЕСЬ
    // runParallel.ts процессом же, минуя `main().catch()` (тот ловит только отказы
    // самого async main, а необработанный 'error' на EventEmitter — это отдельный,
    // синхронный throw). Итоговый код возврата в этом случае обычно ненулевой (узел
    // сам паникует), но без FAIL-строки и без привязки к конкретному шару — то самое
    // «код теряется», просто на этапе запуска, а не выполнения тестов.
    child.on("error", (err) => {
      console.error(`[тесты] шард ${index} не запустился:`, err instanceof Error ? err.message : err);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
}

import { mergeShardReports, shardVerdict, type ShardReportLike } from "./runParallelVerdict.js";

/**
 * Read reports once. Missing, malformed or unfinished reports cannot turn green
 * during merging; the pure helper uses the same verdict as the process gate.
 */
function mergeReports(codes: number[]) {
  const missing: number[] = [];
  const parts: (ShardReportLike | null)[] = [];
  for (const i of indices) {
    const file = shardReport(i);
    let part: ShardReportLike | null = null;
    try {
      if (existsSync(file)) {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) part = parsed as ShardReportLike;
      }
    } catch { /* Unreadable reports remain red; preserve the original file for diagnostics. */ }
    if (part === null) missing.push(i);
    parts.push(part);
  }
  return { merged: mergeShardReports(parts, codes), missing, parts };
}

async function main(): Promise<void> {
  const baseUrl = process.env.DATABASE_URL;
  if (isParallelDbEnabled()) {
    if (!baseUrl) throw new Error("DATABASE_URL не задан — базы для процессов создать не из чего");
    const ms = await prepareWorkerDatabases(baseUrl, indices);
    console.log(`[тесты] ${workers} баз готово копией «${new URL(baseUrl).pathname.slice(1)}» за ${(ms / 1000).toFixed(1)} с`);
  }

  const started = Date.now();
  const codes = await Promise.all(indices.map(runShard));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  const { merged, missing, parts } = mergeReports(codes);
  if (report) writeFileSync(report, JSON.stringify(merged));

  const verdicts = parts.map((part, k) => shardVerdict(codes[k], part));
  const failedShards = indices.filter((i, k) => verdicts[k] === "red");
  // Файлы и блоки describe — разные числа, и путать их дорого: `numTotalTestSuites`
  // это блоки (1601 на 12.09.2026), файлов же 484, и умерший шард видно именно
  // по файлам. Печатаем оба, каждое своим именем.
  console.log(
    `\n[тесты] ${workers} процессов, ${seconds} с: файлов ${merged.testResults?.length ?? 0}, ` +
      `блоков ${merged.numTotalTestSuites ?? 0}, тестов ${merged.numTotalTests ?? 0}, ` +
      `упало ${merged.numFailedTests ?? 0}`
  );
  if (missing.length) console.error(`[тесты] шарды без отчёта (умерли на полпути?): ${missing.join(", ")}`);
  if (failedShards.length) console.error(`[тесты] шарды красные (упавшие файлы или неполный отчёт): ${failedShards.join(", ")}`);

  if (isParallelDbEnabled() && process.env.VITEST_DB_KEEP === "0" && baseUrl) {
    await dropWorkerDatabases(baseUrl, indices);
  }
  const failed = missing.length > 0 || failedShards.length > 0 || merged.success !== true;
  if (failed) {
    console.error(`[тесты] отчёты шардов сохранены для разбора: ${tmp}`);
  } else {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Код возврата, а не `process.exit`: на Windows запись в канал асинхронна, и
  // мгновенный выход обрезал бы последние строки отчёта — ровно те, ради
  // которых всё и печаталось.
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error("[тесты]", err instanceof Error ? err.message : err);
  console.error(`[тесты] отчёты шардов сохранены для разбора: ${tmp}`);
  process.exitCode = 1;
});
