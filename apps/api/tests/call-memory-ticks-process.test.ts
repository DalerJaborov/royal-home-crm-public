import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { API_PROCESS_TICKS } from "../src/lib/apiProcessTicks.js";

/**
 * E2, E3 глубокой проверки 02.10.2026: тики, которые читают или пишут карту
 * живых звонков, обязаны жить в процессе api, рядом с событиями станции.
 *
 * `callback-connect` из worker клал обратный звонок в память worker: у звонка
 * не было итога и записи, а оператор до выката считался занятым.
 * `stuck-call-stubs` из worker не видел живой канал и помечал идущий разговор
 * «потерянным».
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const NAMES = ["stuck-call-stubs", "callback-connect"] as const;

describe("тики карты живых звонков — только в процессе api", () => {
  it("cron.ts (worker) их не ставит", () => {
    const cronSrc = readFileSync(join(SRC, "cron.ts"), "utf8");
    for (const name of NAMES) expect(cronSrc).not.toMatch(new RegExp(`scheduleTracked\\(\\s*"${name}"`));
  });

  it("сторож пульса ждёт их по списку тиков api, с тем же расписанием", async () => {
    vi.resetModules();
    const seen = new Map<string, string>();
    vi.doMock("../src/lib/cronHeartbeat.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/cronHeartbeat.js")>()),
      scheduleTracked: (name: string, expr: string) => {
        seen.set(name, expr);
        return { stop() {} };
      },
    }));
    const { startCallMemoryTicks, CALL_MEMORY_TICKS } = await import("../src/lib/telephony/callMemoryTicks.js");
    startCallMemoryTicks();
    vi.doUnmock("../src/lib/cronHeartbeat.js");
    expect([...seen.keys()].sort()).toEqual([...CALL_MEMORY_TICKS].sort());
    expect([...CALL_MEMORY_TICKS].sort()).toEqual([...NAMES].sort());
    for (const [name, expr] of seen) {
      expect((API_PROCESS_TICKS as Record<string, string>)[name]).toBe(expr);
    }
  });

  it("index.ts запускает их рядом с подпиской на события станции", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(index).toContain("startCallMemoryTicks();");
  });
});
