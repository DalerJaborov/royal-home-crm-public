import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { reminderLeadText } from "./reminderLeadText";

/**
 * Подпись о напоминании говорит правду (владелец 24.11.2026). Сервер шлёт о показе
 * ОДНО напоминание за 2 часа (apps/api/src/lib/meetingReminders.ts, stagesFor;
 * сторож сервера — apps/api/tests/showing-reminders.test.ts), а окна обещали ещё
 * «за 40 минут» и «за день».
 */
describe("reminderLeadText", () => {
  it("показ и встреча — за 2 часа", () => {
    expect(reminderLeadText("SHOWING")).toBe("за 2 часа");
    expect(reminderLeadText("MEETING")).toBe("за 2 часа");
  });
  it("прочие записи — за час", () => {
    expect(reminderLeadText("CALL")).toBe("за час");
  });
});

/** Класс ошибки: экран обещает ступени напоминаний, которых сервер не шлёт. */
const SRC = path.join(__dirname, "..");
const FORBIDDEN = [/за\s+40\s+минут/i, /за\s+день,\s+за\s+2\s+часа/i, /за\s+2\s+часа\s+и\s+(?:за\s+)?40/i];

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
    return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("экраны не обещают снятые напоминания «за день» и «за 40 минут»", () => {
  it("ни в одном файле apps/web/src", () => {
    const hits: string[] = [];
    for (const f of sources(SRC)) {
      const code = fs
        .readFileSync(f, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\s+/g, " ");
      for (const re of FORBIDDEN) if (re.test(code)) hits.push(`${path.relative(SRC, f)}: ${re}`);
    }
    expect(hits).toEqual([]);
  });
});
