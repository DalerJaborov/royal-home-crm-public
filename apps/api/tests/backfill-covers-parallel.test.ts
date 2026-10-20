import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Добор обложек параллельно (владелец 30.09.2026: «быстрее, а не 3 часа»): по
 * `--parallel` объектов одновременно, каждый ровно один раз, итог честный.
 */
let active = 0;
let peak = 0;
const seen: string[] = [];
const calls: { id: string; options: { force?: boolean; provider?: string } }[] = [];
/** Объекты, у которых «ChatGPT снова не вышел»: возвращают запасную обложку. */
const stillFallback = new Set<string>();
vi.mock("../src/lib/video/coverOpenAi.js", () => ({
  FALLBACK_COVER_HASH_PREFIX: "fallback-template:",
  loadCoverRuntimeSettings: async () => ({ coverProvider: "TEMPLATE" }),
  makePropertyCover: async (id: string, options: { force?: boolean; provider?: string }) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    seen.push(id);
    calls.push({ id, options });
    return { squareUrl: "/s.jpg", storyUrl: "/t.jpg", cached: false, ...(stillFallback.has(id) ? { fallback: true } : {}) };
  },
}));

const { prisma } = await import("../src/db.js");
const { main } = await import("../src/lib/backfillPropertyCovers.js");

const runId = Date.now().toString(36);
const ids: string[] = [];

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: ids } } });
  await prisma.property.deleteMany({ where: { id: { in: ids } } });
});

describe("добор обложек: --parallel", () => {
  it("рисует по N одновременно и каждый объект ровно один раз", async () => {
    for (let i = 0; i < 6; i++) {
      const p = await prisma.property.create({
        data: { title: `Добор-параллель-${runId}-${i}`, type: "APARTMENT", rooms: 2, areaSqm: 50, floor: 3, totalFloors: 9, price: 100000, currency: "TJS", address: "Тест", condition: "GOOD", publishedOnSite: true },
      });
      ids.push(p.id);
      await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: `/uploads/x-${runId}-${i}.jpg`, thumbUrl: `/uploads/x-${runId}-${i}.jpg`, order: 0 } });
    }
    const argv = process.argv;
    process.argv = ["node", "backfill", "--apply", "--force", "--limit", "2000", "--parallel", "3"];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await main();
    } finally {
      process.argv = argv;
      log.mockRestore();
    }
    const mine = seen.filter((id) => ids.includes(id));
    expect(mine.sort()).toEqual([...ids].sort());
    expect(peak).toBe(3);
  });
});

describe("добор обложек: --only-fallback (02.10.2026)", () => {
  it("берёт только объекты с запасной обложкой шаблона, перерисовывает ChatGPT-ом с force; оставшиеся запасными считает неудачей", async () => {
    const make = async (name: string, hash: string | null) => {
      const p = await prisma.property.create({
        data: { title: `Добор-запасные-${runId}-${name}`, type: "APARTMENT", rooms: 2, areaSqm: 50, floor: 3, totalFloors: 9, price: 100000, currency: "TJS", address: "Тест", condition: "GOOD", socialCoverInputHash: hash, socialCoverSquareUrl: hash ? "/uploads/covers/x.jpg" : null, socialCoverStoryUrl: hash ? "/uploads/covers/y.jpg" : null },
      });
      ids.push(p.id);
      await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: `/uploads/x-${runId}-${name}.jpg`, thumbUrl: `/uploads/x-${runId}-${name}.jpg`, order: 0 } });
      return p.id;
    };
    const fbA = await make("a", "fallback-template:aaa");
    const fbB = await make("b", "fallback-template:bbb");
    const chatGpt = await make("c", "deadbeef");
    const manual = await make("d", "manual:123");
    stillFallback.add(fbB);
    calls.length = 0;
    const argv = process.argv;
    process.argv = ["node", "backfill", "--apply", "--only-fallback", "--limit", "2000"];
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    try {
      await main();
    } finally {
      process.argv = argv;
      log.mockRestore();
    }
    const mine = calls.filter((c) => ids.includes(c.id));
    expect(mine.map((c) => c.id).sort()).toEqual([fbA, fbB].sort());
    expect(mine.every((c) => c.options.force === true && c.options.provider === "OPENAI")).toBe(true);
    expect(mine.map((c) => c.id)).not.toContain(chatGpt);
    expect(mine.map((c) => c.id)).not.toContain(manual);
    // fbB снова вышла запасной — это не успешная замена.
    expect(lines.some((l) => l.includes(fbB) && l.includes("запасная обложка осталась"))).toBe(true);
    expect(lines.some((l) => l.includes(fbA) && l.includes("✓"))).toBe(true);
  });
});
