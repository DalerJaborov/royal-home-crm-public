import { describe, expect, it } from "vitest";
import { channelVolumeVerdict, isChannelWatchHour } from "../src/lib/channelVolumeWatch.js";

/** Живой случай 22.11.2026: Instagram 10–18 новых диалогов в день, в тот день — 2; Facebook 5–8, в тот день — 0. */
describe("channelVolumeVerdict", () => {
  it("канал замолчал совсем при обычном потоке — тревога", () => {
    expect(channelVolumeVerdict(0, 7 * 4).alert).toBe(true);
  });

  it("резкое падение крупного канала (в четыре раза) — тревога", () => {
    expect(channelVolumeVerdict(2, 7 * 10).alert).toBe(true);
  });

  it("обычный поток — тихо", () => {
    expect(channelVolumeVerdict(9, 7 * 10).alert).toBe(false);
  });

  it("мелкий канал, где и обычно почти пусто, не тревожит", () => {
    expect(channelVolumeVerdict(0, 7 * 1).alert).toBe(false);
    expect(channelVolumeVerdict(0, 7 * 2).alert).toBe(false);
  });

  it("средний канал: 5 из обычных 10 — ещё не тревога", () => {
    expect(channelVolumeVerdict(5, 7 * 10).alert).toBe(false);
  });

  it("возвращает среднее за сутки", () => {
    expect(channelVolumeVerdict(0, 21).average).toBe(3);
  });
});

describe("isChannelWatchHour — только днём по Душанбе", () => {
  it("полдень по Душанбе (07:00 UTC) — смотрим", () => {
    expect(isChannelWatchHour(new Date("2026-11-24T07:00:00Z"))).toBe(true);
  });

  it("ночь по Душанбе (22:00 UTC = 03:00) — молчим", () => {
    expect(isChannelWatchHour(new Date("2026-11-23T22:00:00Z"))).toBe(false);
  });

  it("граница 22:00 по Душанбе (17:00 UTC) — уже не смотрим", () => {
    expect(isChannelWatchHour(new Date("2026-11-24T17:00:00Z"))).toBe(false);
  });
});

describe("runChannelVolumeWatchTick — на базе", () => {
  const prefix = `cvw-${Date.now()}`;
  const at = new Date("2026-11-24T07:00:00Z"); // полдень по Душанбе

  it("канал с обычным потоком замолчал — одна тревога руководству, повтор в тот же день не дублирует", async () => {
    const { prisma } = await import("../src/db.js");
    const { runChannelVolumeWatchTick } = await import("../src/lib/channelVolumeWatch.js");
    // Три диалога в каждом из 7 прошлых дней, в окне «последние 8 часов» тех суток.
    const rows = [];
    for (let day = 1; day <= 7; day += 1) {
      for (let i = 0; i < 3; i += 1) {
        rows.push({
          channel: "INSTAGRAM",
          subscriberId: `${prefix}-${day}-${i}`,
          createdAt: new Date(at.getTime() - day * 86400000 - (i + 1) * 3600000),
        });
      }
    }
    await prisma.botConversation.createMany({ data: rows });
    try {
      const first = await runChannelVolumeWatchTick(at);
      expect(first.alerted).toContain("INSTAGRAM");
      const second = await runChannelVolumeWatchTick(at);
      expect(second.alerted).not.toContain("INSTAGRAM");
    } finally {
      await prisma.botConversation.deleteMany({ where: { subscriberId: { startsWith: prefix } } });
      await prisma.pendingDirectorAlert.deleteMany({ where: { tag: "channel-volume-INSTAGRAM-2026-11-24" } });
    }
  });

  it("ночью по Душанбе тихо", async () => {
    const { runChannelVolumeWatchTick } = await import("../src/lib/channelVolumeWatch.js");
    expect((await runChannelVolumeWatchTick(new Date("2026-11-23T22:00:00Z"))).alerted).toEqual([]);
  });
});
