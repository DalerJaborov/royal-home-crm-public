import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { API_PROCESS_TICKS } from "../src/lib/apiProcessTicks.js";

/**
 * ЗАДАЧА С ПРИВЯЗКОЙ К ЧАСУ ИЛИ ДНЮ ОБЯЗАНА ОБЪЯВЛЯТЬ ЧАСОВОЙ ПОЯС ДУШАНБЕ.
 *
 * Контейнер живёт в UTC, Душанбе — UTC+5 (правило CLAUDE.md). `node-cron` без
 * опции `timezone` берёт время процесса, поэтому «0 8 * * *» без пояса — это
 * 13:00 по Душанбе, а не 08:00. Ошибка ничего не ломает и ничем не пахнет:
 * задача исправно работает, просто в другое время суток, и заметить это можно
 * только сверив расписание с намерением в комментарии.
 *
 * Поймано 19.09.2026 на `duplicate-fuzzy-scan`: комментарий обещал «08:00 по
 * Душанбе — до начала рабочего дня», а скан шёл в разгар дня.
 *
 * Ужесточено 01.10.2026 (ночная проверка, №170). Прежняя версия искала слово
 * `timezone:` где угодно в тексте вызова, то есть засчитывала даже комментарий
 * «// timezone: не нужен»; значение пояса не проверяла; считала непривязанной
 * задачу с шагом по часам (шаг отсчитывается от полуночи — это тоже привязка);
 * и читала один `cron.ts`, хотя `scheduleTracked` зовётся ещё в `index.ts` и
 * `lib/telephony/liveVoiceScenarioTicks.ts`. Теперь разбирается дерево
 * разбора КАЖДОГО файла `src`: комментарии в счёт не идут по построению,
 * значение пояса сверяется буквально, привязка — любое поле, кроме минут, не «*».
 */
const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const DUSHANBE = "Asia/Dushanbe";

export interface ScheduledCall {
  file: string;
  /** Имя задачи (для scheduleTracked) или «cron.schedule». */
  name: string;
  /** Выражение расписания, если оно записано строкой; иначе null. */
  expr: string | null;
  /** Значение `timezone` из объекта опций, если оно записано строкой; иначе null. */
  timezone: string | null;
}

const stringValue = (node: ts.Node | undefined): string | null =>
  node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;

/**
 * Расписание тиков процесса api записано не строкой, а ссылкой в общий список
 * (`API_PROCESS_TICKS["имя"]`, lib/apiProcessTicks.ts) — оттуда же его ждёт
 * сторож пульса. Ссылка раскрывается в саму строку из модуля, так что пояс
 * проверяется по настоящему расписанию, а не пропускается как «не строкой».
 */
function scheduleValue(node: ts.Node | undefined): string | null {
  const literal = stringValue(node);
  if (literal !== null || !node || !ts.isElementAccessExpression(node)) return literal;
  if (node.expression.getText() !== "API_PROCESS_TICKS") return null;
  const key = stringValue(node.argumentExpression);
  return key !== null && Object.hasOwn(API_PROCESS_TICKS, key) ? API_PROCESS_TICKS[key as keyof typeof API_PROCESS_TICKS] : null;
}

function timezoneOf(options: ts.Node | undefined): string | null {
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const prop of options.properties) {
    if (ts.isPropertyAssignment(prop) && prop.name.getText() === "timezone") return stringValue(prop.initializer);
  }
  return null;
}

/** Все вызовы `scheduleTracked(...)` и `cron.schedule(...)` в тексте одного файла. */
export function findScheduledCalls(file: string, source: string): ScheduledCall[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: ScheduledCall[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "scheduleTracked") {
        found.push({ file, name: stringValue(node.arguments[0]) ?? "?", expr: scheduleValue(node.arguments[1]), timezone: timezoneOf(node.arguments[3]) });
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "schedule" && callee.expression.getText() === "cron") {
        found.push({ file, name: "cron.schedule", expr: scheduleValue(node.arguments[0]), timezone: timezoneOf(node.arguments[2]) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Привязка к часам суток или календарю: любое поле, кроме минут, не «*» (шаг по часам тоже привязка). */
export function isBoundToClock(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  const calendar = fields.slice(-4); // час, день месяца, месяц, день недели
  return calendar.some((f) => f !== "*");
}

/** Что не так с вызовом; пустой список — всё в порядке. */
export function problemsOf(call: ScheduledCall): string[] {
  const label = `${call.file}: ${call.name}${call.expr ? ` ("${call.expr}")` : ""}`;
  if (call.timezone !== null && call.timezone !== DUSHANBE) return [`${label} — пояс "${call.timezone}", должен быть "${DUSHANBE}"`];
  if (call.expr === null) return call.timezone === null ? [`${label} — расписание не строкой, проверить нельзя`] : [];
  if (isBoundToClock(call.expr) && call.timezone !== DUSHANBE) return [`${label} — привязка к часу/дню без пояса "${DUSHANBE}"`];
  return [];
}

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "generated" ? [] : listSourceFiles(full);
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** Единственное место, где `cron.schedule` получает расписание и опции параметрами, а не литералами. */
const WRAPPER_FILE = "lib/cronHeartbeat.ts";

function allCalls(): ScheduledCall[] {
  return listSourceFiles(SRC_DIR).flatMap((f) => {
    const rel = path.relative(SRC_DIR, f).split(path.sep).join("/");
    return findScheduledCalls(rel, fs.readFileSync(f, "utf8"));
  });
}

describe("разбор расписания (сам сторож не слепой)", () => {
  const parse = (code: string) => findScheduledCalls("x.ts", code);

  it("слово timezone в комментарии поясом не считается", () => {
    const [c] = parse(`scheduleTracked("a", "0 8 * * *", async () => {} /* timezone: "Asia/Dushanbe" */); // timezone: не нужен`);
    expect(c.timezone).toBeNull();
    expect(problemsOf(c)).toHaveLength(1);
  });

  it("«0 */6 * * *» и «30 */2 * * *» — это привязка к часу, а «*/5 * * * *» и «25 * * * *» — нет", () => {
    expect(isBoundToClock("0 */6 * * *")).toBe(true);
    expect(isBoundToClock("30 */2 * * *")).toBe(true);
    expect(isBoundToClock("0 9 * * 1")).toBe(true);
    expect(isBoundToClock("*/5 * * * *")).toBe(false);
    expect(isBoundToClock("25 * * * *")).toBe(false);
  });

  it("значение пояса сверяется буквально", () => {
    const [utc] = parse(`scheduleTracked("a", "*/5 * * * *", async () => {}, { timezone: "UTC" });`);
    expect(problemsOf(utc)).toHaveLength(1);
    const [ok] = parse(`scheduleTracked("a", "0 8 * * *", async () => {}, { timezone: "${DUSHANBE}" });`);
    expect(problemsOf(ok)).toEqual([]);
  });

  it("находит и cron.schedule, и вызов без пояса с привязкой к дню", () => {
    const [c] = parse(`cron.schedule("0 * * * 1", () => {});`);
    expect(c.name).toBe("cron.schedule");
    expect(problemsOf(c)).toHaveLength(1);
  });

  it("расписание из общего списка тиков api раскрывается в строку; чужая или неизвестная ссылка — нет", () => {
    const [known] = parse(`scheduleTracked("live-calls-sweep", API_PROCESS_TICKS["live-calls-sweep"], async () => {});`);
    expect(known.expr).toBe(API_PROCESS_TICKS["live-calls-sweep"]);
    expect(problemsOf(known)).toEqual([]);
    const [unknown] = parse(`scheduleTracked("a", API_PROCESS_TICKS["нет-такого"], async () => {});`);
    expect(unknown.expr).toBeNull();
    expect(problemsOf(unknown)).toHaveLength(1);
    const [other] = parse(`scheduleTracked("a", OTHER["live-calls-sweep"], async () => {});`);
    expect(other.expr).toBeNull();
  });
});

describe("расписание задач во всех файлах src", () => {
  const calls = allCalls();

  it("находит все задачи (список не пуст и охватывает не только cron.ts)", () => {
    expect(calls.filter((c) => c.file === "cron.ts").length).toBeGreaterThan(80);
    expect(calls.some((c) => c.file === "index.ts")).toBe(true);
    expect(calls.some((c) => c.file === "lib/telephony/liveVoiceScenarioTicks.ts")).toBe(true);
  });

  it("каждая задача: расписание строкой; привязка к часу/дню — только с поясом Душанбе; чужой пояс не допускается", () => {
    const problems = calls.filter((c) => !(c.file === WRAPPER_FILE && c.expr === null)).flatMap(problemsOf);
    expect(problems).toEqual([]);
  });
});
