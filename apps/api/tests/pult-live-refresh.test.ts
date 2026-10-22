import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Шина подменена: проверяем, ЧТО и КАК ЧАСТО публикуется, без базы.
const published: Array<{ type: string; roles?: string[] }> = [];
vi.mock("../src/lib/eventBus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/eventBus.js")>()),
  publish: vi.fn(async (input: { type: string; roles?: string[] }) => {
    published.push(input);
  }),
  liveEventsEnabled: () => true,
}));

import { cachedSection } from "../src/lib/missionControlCache.js";
import {
  PULT_SNAPSHOT_MIN_GAP_MS,
  __resetPultSnapshotThrottleForTests,
  publishClientUpdated,
  publishPultSnapshot,
} from "../src/lib/livePublish.js";
import { requestPultSnapshot } from "../src/lib/pultCacheHook.js";

/**
 * Живое обновление пульта (пачка B, 23.10.2026):
 *  - событие сбрасывает кэш секций — перезапрос по событию не получает старый снимок;
 *  - publishPultSnapshot не чаще раза в 5 с, последнее изменение не теряется;
 *  - сброс кэша не публикует событие повторно (цикла нет).
 */
const snapshots = () => published.filter((e) => e.type === "pult.snapshot");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T10:00:00Z"));
  published.length = 0;
  __resetPultSnapshotThrottleForTests();
});
afterEach(() => {
  __resetPultSnapshotThrottleForTests();
  vi.useRealTimers();
});

describe("сброс кэша секций по событию", () => {
  it("client.updated сбрасывает и живые секции, и зоны", async () => {
    const live = vi.fn(async () => "live-1");
    const zone = vi.fn(async () => "zone-1");
    await cachedSection("t-live", 15_000, live);
    await cachedSection("t-zone", 60_000, zone);

    publishClientUpdated({ clientId: "c1" });
    await cachedSection("t-live", 15_000, live);
    await cachedSection("t-zone", 60_000, zone);
    expect(live).toHaveBeenCalledTimes(2);
    expect(zone).toHaveBeenCalledTimes(2);
  });

  it("pult.snapshot сбрасывает только живые секции, зоны остаются", async () => {
    const live = vi.fn(async () => "l");
    const zone = vi.fn(async () => "z");
    await cachedSection("t2-live", 15_000, live);
    await cachedSection("t2-zone", 60_000, zone);

    publishPultSnapshot();
    await cachedSection("t2-live", 15_000, live);
    await cachedSection("t2-zone", 60_000, zone);
    expect(live).toHaveBeenCalledTimes(2);
    expect(zone).toHaveBeenCalledTimes(1);
  });

  it("расчёт, начатый до события, не кладёт старое в кэш", async () => {
    let release!: (v: string) => void;
    const slow = vi.fn(() => new Promise<string>((r) => (release = r)));
    const first = cachedSection("t3", 15_000, slow);
    await vi.advanceTimersByTimeAsync(0); // fn стартует микрозадачей
    publishClientUpdated({ clientId: "c1" });
    release("stale");
    await first;
    const fresh = vi.fn(async () => "fresh");
    expect(await cachedSection("t3", 15_000, fresh)).toBe("fresh");
  });
});

describe("publishPultSnapshot: троттл", () => {
  it("первый вызов уходит сразу, адресат — надзор", () => {
    publishPultSnapshot();
    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0].roles).toContain("DIRECTOR");
  });

  it("серия вызовов в окне даёт один отложенный выстрел в конце окна", async () => {
    publishPultSnapshot();
    for (let i = 0; i < 10; i++) requestPultSnapshot();
    expect(snapshots()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PULT_SNAPSHOT_MIN_GAP_MS - 100);
    expect(snapshots()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshots()).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(PULT_SNAPSHOT_MIN_GAP_MS * 2);
    expect(snapshots()).toHaveLength(2); // без новых вызовов лишнего нет
  });

  it("после паузы дольше окна снова уходит сразу", async () => {
    publishPultSnapshot();
    await vi.advanceTimersByTimeAsync(PULT_SNAPSHOT_MIN_GAP_MS + 1);
    publishPultSnapshot();
    expect(snapshots()).toHaveLength(2);
  });
});
