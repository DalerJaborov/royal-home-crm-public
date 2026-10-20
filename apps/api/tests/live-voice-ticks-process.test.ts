import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * ЗВОНОК РОБОТА НАБИРАЕТСЯ ТАМ, ГДЕ ЖИВЁТ ЕГО ГОЛОС (28.09.2026).
 *
 * originateLiveVoiceScenarioCall кладёт задание разговора в память своего
 * процесса, а StasisStart слушает мост в HTTP-процессе (index.ts). Тики из
 * cron.ts идут в контейнере worker: задание оставалось там, станция соединяла
 * человека с консультантом по умолчанию — владелец получил звонок «чем могу
 * помочь» вместо приглашения на собеседование.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function relativeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^"'`;]*?from\s+["'](\.[^"']+)["']/g)) {
    const ts = join(dirname(file), m[1].replace(/\.js$/, ".ts"));
    if (existsSync(ts)) out.push(ts);
  }
  return out;
}

/** Всё, до чего cron.ts дотягивается импортами (без index.ts — он не импортируется). */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    for (const dep of relativeImports(file)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return seen;
}

describe("исходящие звонки живым голосом — только из процесса моста", () => {
  it("ни один модуль, доступный из cron.ts (worker), не набирает номер живым голосом", () => {
    const bridge = join(SRC, "lib/telephony/liveVoiceBridge.ts");
    const offenders = [...reachableFrom(join(SRC, "cron.ts"))]
      .filter((f) => f !== bridge)
      .filter((f) => /originateLiveVoice\w*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("index.ts запускает тики звонков рядом с мостом", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const listener = index.indexOf("startLiveVoiceListener();");
    const ticks = index.indexOf("startLiveVoiceScenarioTicks();");
    expect(listener).toBeGreaterThan(-1);
    expect(ticks).toBeGreaterThan(listener);
  });

  it("startLiveVoiceScenarioTicks ставит все три тика", async () => {
    vi.resetModules();
    const names: string[] = [];
    vi.doMock("../src/lib/cronHeartbeat.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/lib/cronHeartbeat.js")>()),
      scheduleTracked: (name: string) => {
        names.push(name);
        return { stop() {} };
      },
    }));
    const { startLiveVoiceScenarioTicks, LIVE_VOICE_SCENARIO_TICKS } = await import(
      "../src/lib/telephony/liveVoiceScenarioTicks.js"
    );
    startLiveVoiceScenarioTicks();
    expect(names.sort()).toEqual([...LIVE_VOICE_SCENARIO_TICKS].sort());
    vi.doUnmock("../src/lib/cronHeartbeat.js");
  });
});
