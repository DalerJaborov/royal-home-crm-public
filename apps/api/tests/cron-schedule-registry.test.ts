import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * РАСПИСАНИЕ ЦЕЛИКОМ — ОДИН ВЫЗОВ, И ДО 25.09.2026 ЕГО НЕ ЗВАЛ НИКТО.
 *
 * `cron.ts` в списке файлов сервера, до которых не дотягивается ни один тест
 * (CLAUDE.md, замер 22.09.2026). Два соседних теста читают его ИСХОДНИК как
 * текст (`cron-timezone.test.ts`, `cron-ticks-batching.test.ts`), то есть
 * сторожат написанное, а не выполненное. Здесь `startCronJobs()` вызывается
 * по-настоящему: подменены только `node-cron.schedule` (иначе восемьдесят с
 * лишним задач правда встанут на таймеры прямо в прогоне и начнут ходить в
 * тестовую базу) и `scheduleTracked` — обёрткой, которая записывает аргументы
 * и зовёт настоящую. Настоящая нужна не для красоты: её защита от дубля имени
 * (`throw` при повторе) — часть проверок ниже.
 *
 * Цена ошибки здесь выше обычной: ЛЮБОЕ падение внутри `startCronJobs()` —
 * брошенный дубль имени, невалидное выражение — валит запуск worker-процесса
 * целиком, то есть гасит РАЗОМ всё расписание, а не одну задачу. Узнают об
 * этом по последствиям через сутки.
 */

type Task = {
  name: string;
  expr: string;
  timezone?: string;
  module?: string;
  timeoutMs?: number;
};

const tasks: Task[] = [];

/** Никаких настоящих таймеров: тик, запущенный vitest-ом, пошёл бы в базу прогона. */
vi.mock("node-cron", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-cron")>();
  const real = (actual as unknown as { default?: Record<string, unknown> }).default ?? actual;
  const stub = { start() {}, stop() {}, destroy() {}, getNextRun: () => null };
  const schedule = () => stub;
  return { ...actual, default: { ...real, schedule }, schedule };
});

/** Обёртка вокруг НАСТОЯЩЕЙ scheduleTracked: запоминает аргументы, поведение не меняет. */
vi.mock("../src/lib/cronHeartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/cronHeartbeat.js")>();
  const scheduleTracked: typeof actual.scheduleTracked = (name, expr, fn, options, tracked, trackedOptions) => {
    tasks.push({
      name,
      expr,
      timezone: options?.timezone,
      module: tracked?.module,
      timeoutMs: trackedOptions?.timeoutMs,
    });
    return actual.scheduleTracked(name, expr, fn, options, tracked, trackedOptions);
  };
  return { ...actual, scheduleTracked };
});

const cron = (await vi.importActual<{ default: typeof import("node-cron") }>("node-cron")).default;
const { cronIntervalMs, nextCronRun } = await import("../src/lib/cronHeartbeat.js");
const { startCronJobs } = await import("../src/cron.js");

/**
 * Единственный вызов на файл: реестр `scheduleTracked` живёт в модуле, второй
 * заход упал бы на собственной защите от дубля.
 */
startCronJobs();

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(apiRoot, rel), "utf8");

/**
 * Комментарии выбрасываются перед разбором исходника: закомментированный вызов
 * — это НЕ вызов, а текстовая проверка читала бы его как живой (тот же приём и
 * по той же причине, что в `telephony-hooks-registered.test.ts`).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("startCronJobs — расписание встаёт целиком", () => {
  it("регистрирует все задачи (пустой список значил бы, что подмена не сработала)", () => {
    expect(tasks.length).toBeGreaterThan(50);
  });

  it("имена задач уникальны", () => {
    // Дубль имени бросает ещё внутри startCronJobs (и роняет worker при старте),
    // поэтому сюда мы доходим только с уникальными. Проверка называет правило
    // вслух и ловит случай, если защиту из cronHeartbeat однажды снимут.
    const seen = new Map<string, number>();
    for (const t of tasks) seen.set(t.name, (seen.get(t.name) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([name]) => name)).toEqual([]);
  });

  it("имя задачи — стабильный ключ латиницей (оно же ключ в базе пульса и текст алерта)", () => {
    expect(tasks.filter((t) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(t.name)).map((t) => t.name)).toEqual([]);
  });

  it("каждое cron-выражение разбирается node-cron", () => {
    expect(tasks.filter((t) => !cron.validate(t.expr)).map((t) => `${t.name} ("${t.expr}")`)).toEqual([]);
  });

  it("каждое расписание когда-нибудь наступает", () => {
    // «0 9 30 2 *» валидно для node-cron и не наступает никогда: 30 февраля нет.
    // Сторож пульса на таком выражении не находит следующего запуска и бросает.
    const now = new Date("2026-09-25T00:00:00Z");
    const YEAR_MS = 366 * 24 * 3_600_000;
    const never: string[] = [];
    for (const t of tasks) {
      let next: Date | null = null;
      try {
        next = nextCronRun(t.expr, now, t.timezone);
      } catch {
        next = null;
      }
      if (!next || next.getTime() - now.getTime() > YEAR_MS) never.push(`${t.name} ("${t.expr}")`);
    }
    expect(never).toEqual([]);
  });

  it("задача с привязкой к часу объявляет пояс Душанбе, а не просто «какой-нибудь»", () => {
    // Контейнер живёт в UTC, Душанбе — UTC+5: «0 8 * * *» без пояса уезжает на
    // 13:00. Текстовый сосед (`cron-timezone.test.ts`) проверяет, что в вызове
    // ЕСТЬ слово timezone; здесь — что пришло именно «Asia/Dushanbe».
    const boundToHour = (expr: string) => !(expr.trim().split(/\s+/)[1] ?? "*").includes("*");
    const wrong = tasks
      .filter((t) => boundToHour(t.expr) && t.timezone !== "Asia/Dushanbe")
      .map((t) => `${t.name} ("${t.expr}", пояс: ${t.timezone ?? "не задан"})`);
    expect(wrong).toEqual([]);
  });

  it("объявленный таймаут тика не длиннее суток и положителен", () => {
    const bad = tasks
      .filter((t) => t.timeoutMs !== undefined && !(t.timeoutMs > 0 && t.timeoutMs <= 24 * 3_600_000))
      .map((t) => `${t.name}: ${t.timeoutMs}`);
    expect(bad).toEqual([]);
  });

  it("интервал расписания считается для каждой задачи (по нему сторож решает, что тик молчит)", () => {
    expect(tasks.filter((t) => !Number.isFinite(cronIntervalMs(t.expr)) || cronIntervalMs(t.expr) <= 0)).toEqual([]);
  });
});

describe("startCronJobs — зовётся ровно из одного процесса", () => {
  /**
   * Расписание поднимает ТОЛЬКО worker. Второй вызов из index.ts не упал бы и
   * ничего бы не сообщил: api-процесс просто начал бы делать ту же работу
   * параллельно — двойные пуши агентам, двойные алерты директору, двойная
   * раздача лидов. Тот же класс, что у крючков телефонии (#971): список живёт
   * в нескольких файлах и расходится молча.
   */
  it("worker.ts поднимает расписание, index.ts — нет", () => {
    const worker = stripComments(read("src/worker.ts"));
    const index = stripComments(read("src/index.ts"));
    expect(/import \{[^}]*\bstartCronJobs\b[^}]*\} from "\.\/cron\.js"/.test(worker)).toBe(true);
    expect(worker.split("startCronJobs(").length - 1).toBe(1);
    expect(index.includes("startCronJobs")).toBe(false);
  });
});
