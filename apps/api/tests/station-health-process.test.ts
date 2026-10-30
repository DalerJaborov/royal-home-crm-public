import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_PROCESS_TICKS } from "../src/lib/apiProcessTicks.js";

describe("station health observes the API-owned ARI socket and pause state", () => {
  it("is not scheduled by the worker with an empty local socket state", () => {
    const cron = readFileSync(new URL("../src/cron.ts", import.meta.url), "utf8");
    expect(cron).not.toContain('scheduleTracked("telephony-station-health"');
    expect(cron).not.toContain('import { runStationHealthTick }');
  });

  it("runs beside the listener, and remains visible to the heartbeat watchdog", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).toContain('scheduleTracked("telephony-station-health", API_PROCESS_TICKS["telephony-station-health"]');
    expect(index.indexOf('scheduleTracked("telephony-station-health"')).toBeGreaterThan(index.indexOf("startLiveVoiceListener();"));
    expect((API_PROCESS_TICKS as Record<string, string>)["telephony-station-health"]).toBe("*/15 * * * *");
  });
});
