import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";
import {
  collectInstagramOnlineFollowers,
  parseOnlineFollowersHours,
} from "../src/lib/instagramInsights.js";
import { instagramOnlineDaysCollected, loadHeatmapCells } from "../src/lib/audienceHeatmap.js";
import { loadPublishScheduleRules } from "../src/lib/publishScheduleRules.js";
import { INSTAGRAM_ONLINE_MIN_DAYS } from "../src/lib/publishSchedule.js";

/**
 * ПОДПИСЧИКИ INSTAGRAM В СЕТИ — В ТЕПЛОВУЮ КАРТУ И В РАСПИСАНИЕ (23.09.2026,
 * владелец: «доработай тепловую карту полностью»).
 *
 * Проверяется то, что ломается молча:
 *  - час ставится во времени от границы суток `end_time`, а не от угаданного
 *    пояса: ошибка здесь сдвинула бы всю карту на 12 часов, и совет
 *    «публиковать в 19:00» стал бы «в 07:00», выглядя правдоподобно;
 *  - повторный сбор того же часа перезаписывает число, а не удваивает его;
 *  - на карте — среднее по клетке, а не сумма (сумма рисовала бы длину истории);
 *  - расписание верит Instagram только с недели сбора.
 */

const IG_USER = `ig-online-test-${Date.now()}`;

// Источник часов и опережение — константы с 01.11.2026 (lib/settingsConstants.ts,
// на проде карта выключена); тест включает их подменой константы, а не полем Settings.
const tuning = vi.hoisted(() => ({
  priorityWindows: [720, 840, 1140, 1260], heatmapDays: 90, leadHours: 1, useHeatmap: true, useInstagramOnline: true,
}));
vi.mock("../src/lib/settingsConstants.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/settingsConstants.js")>()),
  PUBLISH_SCHEDULE_TUNING: tuning,
}));

/** Ответ Meta: одна точка на сутки, граница суток — полночь по Душанбе (19:00 UTC). */
function metaBody(days: { endTime: string; value: Record<string, number> }[]) {
  return {
    data: [
      {
        name: "online_followers",
        period: "lifetime",
        values: days.map((d) => ({ end_time: d.endTime, value: d.value })),
      },
    ],
  };
}

/** Подменяем сеть: /me отдаёт наш тестовый аккаунт, insights — заданное тело. */
function stubMeta(insights: (url: string) => { status: number; body: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/me?fields=")) {
        return new Response(JSON.stringify({ id: IG_USER, user_id: IG_USER, username: "royal_test" }), { status: 200 });
      }
      if (url.includes("online_followers")) {
        const r = insights(url);
        return new Response(JSON.stringify(r.body), { status: r.status });
      }
      return new Response("{}", { status: 404 });
    })
  );
}

beforeAll(async () => {
  await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.instagramOnlineFollowersHour.deleteMany({ where: { igUserId: IG_USER } });
});

describe("Разбор часов Instagram по границе суток", () => {
  it("час считается от end_time: полночь по Калифорнии и полночь по Душанбе дают разные моменты", () => {
    // Граница 07:00 UTC — полночь по Калифорнии летом: час «13» — это 20:00 UTC.
    const california = parseOnlineFollowersHours(
      metaBody([{ endTime: "2026-09-22T07:00:00+0000", value: { "0": 5, "13": 40 } }])
    );
    expect(california.map((p) => p.at.toISOString())).toEqual([
      "2026-09-21T07:00:00.000Z",
      "2026-09-21T20:00:00.000Z",
    ]);
    // Граница 19:00 UTC — полночь по Душанбе: тот же час «13» — это 08:00 UTC.
    const dushanbe = parseOnlineFollowersHours(
      metaBody([{ endTime: "2026-09-22T19:00:00+0000", value: { "13": 40 } }])
    );
    expect(dushanbe[0].at.toISOString()).toBe("2026-09-22T08:00:00.000Z");
  });

  it("точка без end_time и мусорные часы отбрасываются, а не кладутся в полночь 1970 года", () => {
    const body = {
      data: [{ values: [{ value: { "13": 10 } }, { end_time: "2026-09-22T19:00:00+0000", value: { "24": 1, x: 2, "5": -3, "6": 7 } }] }],
    };
    const points = parseOnlineFollowersHours(body);
    expect(points).toHaveLength(1);
    expect(points[0].count).toBe(7);
  });

  it("пустой или чужой ответ — пусто, а не падение", () => {
    expect(parseOnlineFollowersHours(null)).toEqual([]);
    expect(parseOnlineFollowersHours({ data: [] })).toEqual([]);
  });
});

describe("Суточный сбор", () => {
  it("без маркера ничего не просит у Meta и честно говорит почему", async () => {
    const result = await collectInstagramOnlineFollowers({ token: null });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Маркер Instagram не сохранён/);
  });

  it("складывает часы в базу, а повторный сбор перезаписывает, не удваивая", async () => {
    stubMeta(() => ({
      status: 200,
      body: metaBody([{ endTime: "2026-09-10T19:00:00+0000", value: { "14": 100, "15": 120 } }]),
    }));
    const first = await collectInstagramOnlineFollowers({ token: "t", now: new Date("2026-09-11T10:00:00Z") });
    expect(first).toEqual({ ok: true, stored: 2, error: null });

    stubMeta(() => ({
      status: 200,
      body: metaBody([{ endTime: "2026-09-10T19:00:00+0000", value: { "14": 110, "15": 120 } }]),
    }));
    await collectInstagramOnlineFollowers({ token: "t", now: new Date("2026-09-11T10:00:00Z") });

    const rows = await prisma.instagramOnlineFollowersHour.findMany({
      where: { igUserId: IG_USER },
      orderBy: { at: "asc" },
    });
    expect(rows.map((r) => [r.at.toISOString(), r.count])).toEqual([
      ["2026-09-10T09:00:00.000Z", 110],
      ["2026-09-10T10:00:00.000Z", 120],
    ]);
    await prisma.instagramOnlineFollowersHour.deleteMany({ where: { igUserId: IG_USER } });
  });

  it("если месяц одним запросом Meta не отдаёт — берёт то, что отдаётся без диапазона", async () => {
    const urls: string[] = [];
    stubMeta((url) => {
      urls.push(url);
      return url.includes("since=")
        ? { status: 400, body: { error: { message: "since/until not supported" } } }
        : { status: 200, body: metaBody([{ endTime: "2026-09-10T19:00:00+0000", value: { "14": 50 } }]) };
    });
    const result = await collectInstagramOnlineFollowers({ token: "t", now: new Date("2026-09-11T10:00:00Z") });
    expect(result.ok).toBe(true);
    expect(result.stored).toBe(1);
    expect(urls).toHaveLength(2);
    await prisma.instagramOnlineFollowersHour.deleteMany({ where: { igUserId: IG_USER } });
  });

  it("отказ Meta не пишет ничего и возвращает её слова", async () => {
    stubMeta(() => ({ status: 403, body: { error: { message: "no permission" } } }));
    const result = await collectInstagramOnlineFollowers({ token: "t" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/403/);
    expect(await prisma.instagramOnlineFollowersHour.count({ where: { igUserId: IG_USER } })).toBe(0);
  });
});

describe("Срез «Подписчики Instagram» и расписание", () => {
  /** N последних суток, в каждые — 40 человек в 18:00 по Душанбе и 10 в 09:00. */
  async function seedDays(n: number) {
    const now = Date.now();
    const data = [];
    for (let d = 1; d <= n; d++) {
      const dayStartUtc = Math.floor((now - d * 86_400_000) / 3_600_000) * 3_600_000;
      // Час по Душанбе H ⇔ UTC H − 5.
      const at = (dushanbeHour: number) => {
        const base = new Date(dayStartUtc);
        base.setUTCHours(dushanbeHour - 5, 0, 0, 0);
        return base;
      };
      data.push({ igUserId: IG_USER, at: at(18), count: 40 });
      data.push({ igUserId: IG_USER, at: at(9), count: 10 });
    }
    await prisma.instagramOnlineFollowersHour.createMany({ data, skipDuplicates: true });
  }

  it("на карте — среднее по клетке, в часах Душанбе", async () => {
    await seedDays(14);
    const cells = await loadHeatmapCells({ signal: "followers", channel: "ALL", days: 90 });
    const at18 = cells.filter((c) => c.hour === 18);
    expect(at18.length).toBe(7);
    // Две недели сбора — по две точки на день недели, но в клетке 40, а не 80.
    expect(at18.every((c) => c.count === 40)).toBe(true);
    expect(cells.filter((c) => c.hour === 9).every((c) => c.count === 10)).toBe(true);
    // У среза нет каналов — любой, кроме «все», даёт пустую карту без запроса.
    expect(await loadHeatmapCells({ signal: "followers", channel: "PHONE", days: 90 })).toEqual([]);
    await prisma.instagramOnlineFollowersHour.deleteMany({ where: { igUserId: IG_USER } });
  });

  it("меньше недели сбора — расписание Instagram не верит", async () => {
    Object.assign(tuning, { useHeatmap: true, useInstagramOnline: true, leadHours: 1 });
    await seedDays(INSTAGRAM_ONLINE_MIN_DAYS - 2);
    expect(await instagramOnlineDaysCollected(90)).toBeLessThan(INSTAGRAM_ONLINE_MIN_DAYS);
    const loaded = await loadPublishScheduleRules();
    expect(loaded.rules.prioritySource).not.toBe("instagram");
    expect(loaded.instagramOnlineEnabled).toBe(true);
    await prisma.instagramOnlineFollowersHour.deleteMany({ where: { igUserId: IG_USER } });
  });

  it("с недели сбора часы выхода берутся из Instagram — за час до пика", async () => {
    Object.assign(tuning, { useHeatmap: true, useInstagramOnline: true, leadHours: 1 });
    await seedDays(10);
    const loaded = await loadPublishScheduleRules();
    expect(loaded.rules.prioritySource).toBe("instagram");
    expect(loaded.instagramOnlineDays).toBeGreaterThanOrEqual(INSTAGRAM_ONLINE_MIN_DAYS);
    // Пики 18:00 и 09:00 → публиковать в 17:00 и 08:00.
    expect(loaded.priorityHours).toEqual([8, 17]);

    // Выключили тумблер — снова по обращениям, как до правки.
    tuning.useInstagramOnline = false;
    const off = await loadPublishScheduleRules();
    expect(off.rules.prioritySource).not.toBe("instagram");
    expect(off.instagramOnlineEnabled).toBe(false);
    await prisma.instagramOnlineFollowersHour.deleteMany({ where: { igUserId: IG_USER } });
  });
});
