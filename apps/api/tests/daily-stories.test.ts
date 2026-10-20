import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ЕЖЕДНЕВНАЯ ПОДБОРКА СТОРИС (28.09.2026) — lib/dailyStories.ts::runDailyStoriesTick.
 * publishPropertyCardStory подменена (сеть Graph API и рендер картинки не
 * нужны для этого теста — они уже покрыты instagram-price-drop-story.test.ts
 * и facebook-stories.test.ts). На реальной БД стенда — проверяем то, что
 * решает наш код: выбор объектов по правилам, «сегодня уже запускали» не
 * даёт второй прогон, выключенный тумблер и не тот час ничего не делают.
 */

const { publishPropertyCardStory } = vi.hoisted(() => ({
  publishPropertyCardStory: vi.fn(async () => ({ attempted: true, publishedParts: 1, totalParts: 1 })),
}));
vi.mock("../src/lib/instagramStories.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/instagramStories.js")>()),
  publishPropertyCardStory,
}));

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { runDailyStoriesTick, rankDailyStoryCandidates } = await import("../src/lib/dailyStories.js");

const runId = Date.now();
let districtId: string;
let savedSettings: {
  dailyStoriesEnabled: boolean;
  dailyStoriesCount: number;
  dailyStoriesHourDushanbe: number;
  dailyStoriesLastRunAt: Date | null;
};
const propertyIds: string[] = [];

/** 11:00 Душанбе (UTC+5) = 06:00 UTC — фиксированный момент, чтобы тест не
 *  зависел от реального времени запуска. */
const NOON_DUSHANBE = new Date("2026-09-28T06:00:00.000Z");

async function makeProperty(opts: { withPhoto?: boolean; offSite?: boolean; status?: "AVAILABLE" | "SOLD"; postApprovedAt?: Date }) {
  const { withPhoto = true, offSite = false, status = "AVAILABLE", postApprovedAt } = opts;
  const property = await prisma.property.create({
    data: {
      title: `Тест-подборка-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 100000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 3",
      condition: "GOOD",
      status,
      offSite,
      postApprovedAt: postApprovedAt ?? new Date(),
    },
  });
  propertyIds.push(property.id);
  if (withPhoto) {
    await prisma.propertyPhoto.create({ data: { propertyId: property.id, url: "/uploads/test.jpg", thumbUrl: "/uploads/test.jpg", order: 0 } });
  }
  return property;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-подборка-${runId}` } })).id;
  const current = await prisma.settings.upsert({ where: { id: "singleton" }, update: {}, create: { id: "singleton" } });
  savedSettings = {
    dailyStoriesEnabled: current.dailyStoriesEnabled,
    dailyStoriesCount: current.dailyStoriesCount,
    dailyStoriesHourDushanbe: current.dailyStoriesHourDushanbe,
    dailyStoriesLastRunAt: current.dailyStoriesLastRunAt,
  };
});

beforeEach(async () => {
  publishPropertyCardStory.mockClear();
  publishPropertyCardStory.mockResolvedValue({ attempted: true, publishedParts: 1, totalParts: 1 });
  await prisma.settings.update({
    where: { id: "singleton" },
    data: { dailyStoriesEnabled: false, dailyStoriesCount: 3, dailyStoriesHourDushanbe: 11, dailyStoriesLastRunAt: null },
  });
});

afterEach(async () => {
  vi.clearAllMocks();
  for (const id of propertyIds.splice(0)) {
    await prisma.propertyStoryPost.deleteMany({ where: { propertyId: id } });
    await prisma.property.delete({ where: { id } }).catch(() => {});
  }
});

afterAll(async () => {
  await prisma.district.delete({ where: { id: districtId } }).catch(() => {});
  await prisma.settings.update({ where: { id: "singleton" }, data: savedSettings });
  await prisma.$disconnect();
});

/**
 * Порядок подборки — чистая функция, проверяется на выдуманных данных, не на
 * БД стенда (которая несёт сид других сценариев и не даёт проверить точный
 * порядок/число кандидатов — см. комментарий у DB-тестов ниже).
 */
describe("rankDailyStoryCandidates", () => {
  it("никогда не публиковавшиеся — раньше тех, у кого история уже была", () => {
    const never = { id: "never", lastStoryAt: null, postApprovedAt: new Date("2026-01-01") };
    const hadOne = { id: "had", lastStoryAt: new Date("2026-09-20"), postApprovedAt: new Date("2026-09-01") };
    expect(rankDailyStoryCandidates([hadOne, never]).map((c) => c.id)).toEqual(["never", "had"]);
  });

  it("обе никогда не публиковались — более новый объект (postApprovedAt) раньше", () => {
    const older = { id: "older", lastStoryAt: null, postApprovedAt: new Date("2026-09-01") };
    const newer = { id: "newer", lastStoryAt: null, postApprovedAt: new Date("2026-09-20") };
    expect(rankDailyStoryCandidates([older, newer]).map((c) => c.id)).toEqual(["newer", "older"]);
  });

  it("обе публиковались — та, у кого сторис не было дольше, раньше", () => {
    const longAgo = { id: "long-ago", lastStoryAt: new Date("2026-09-01"), postApprovedAt: new Date("2026-01-01") };
    const recent = { id: "recent", lastStoryAt: new Date("2026-09-25"), postApprovedAt: new Date("2026-01-01") };
    expect(rankDailyStoryCandidates([recent, longAgo]).map((c) => c.id)).toEqual(["long-ago", "recent"]);
  });

  it("смешанный набор — полный порядок: null-группа (новые вперёд), затем группа с историей (давние вперёд)", () => {
    const a = { id: "a-had-8d-ago", lastStoryAt: new Date("2026-09-20"), postApprovedAt: new Date("2025-01-01") };
    const b = { id: "b-never-recent-approve", lastStoryAt: null, postApprovedAt: new Date("2026-09-27") };
    const c = { id: "c-never-older-approve", lastStoryAt: null, postApprovedAt: new Date("2026-09-22") };
    expect(rankDailyStoryCandidates([a, b, c]).map((x) => x.id)).toEqual([b.id, c.id, a.id]);
  });

  it("не мутирует переданный массив", () => {
    const input = [
      { id: "x", lastStoryAt: null, postApprovedAt: new Date("2026-09-01") },
      { id: "y", lastStoryAt: null, postApprovedAt: new Date("2026-09-20") },
    ];
    const copy = [...input];
    rankDailyStoryCandidates(input);
    expect(input).toEqual(copy);
  });
});

describe("runDailyStoriesTick", () => {
  it("рубильник выключен — не запускается, кандидаты не считаются", async () => {
    await makeProperty({});
    const result = await runDailyStoriesTick(NOON_DUSHANBE);
    expect(result).toEqual({ ran: false, reason: "выключено" });
    expect(publishPropertyCardStory).not.toHaveBeenCalled();
  });

  it("рубильник включён, но не свой час — не запускается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { dailyStoriesEnabled: true, dailyStoriesHourDushanbe: 9 } });
    await makeProperty({});
    const result = await runDailyStoriesTick(NOON_DUSHANBE);
    expect(result).toEqual({ ran: false, reason: "не тот час" });
    expect(publishPropertyCardStory).not.toHaveBeenCalled();
  });

  it("свой час, но сегодня уже запускали — второй прогон не идёт", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { dailyStoriesEnabled: true, dailyStoriesHourDushanbe: 11, dailyStoriesLastRunAt: new Date(NOON_DUSHANBE.getTime() - 60 * 60 * 1000) },
    });
    await makeProperty({});
    const result = await runDailyStoriesTick(NOON_DUSHANBE);
    expect(result).toEqual({ ran: false, reason: "сегодня уже запускали" });
    expect(publishPropertyCardStory).not.toHaveBeenCalled();
  });

  it("свой час, вчерашний запуск — не блокирует сегодняшний", async () => {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { dailyStoriesEnabled: true, dailyStoriesHourDushanbe: 11, dailyStoriesCount: 1, dailyStoriesLastRunAt: new Date(NOON_DUSHANBE.getTime() - 25 * 60 * 60 * 1000) },
    });
    await makeProperty({});
    const result = await runDailyStoriesTick(NOON_DUSHANBE);
    expect(result.ran).toBe(true);
    expect(publishPropertyCardStory).toHaveBeenCalledTimes(1);
  });

  // БД стенда несёт и другой сид (учётные объекты сценариев других тестов) —
  // ниже НЕ сравниваем candidateCount/список вызовов «ровно N», а проверяем
  // включение/исключение конкретных объектов: dailyStoriesCount ставим
  // заведомо большим (весь пул кандидатов), чтобы «наш» объект гарантированно
  // попал в выборку, если ему положено, и не попал, если не положено —
  // независимо от того, сколько ещё объектов лежит в базе стенда.
  it("выбирает только AVAILABLE, не offSite, с хотя бы одной фотографией", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { dailyStoriesEnabled: true, dailyStoriesHourDushanbe: 11, dailyStoriesCount: 1000 } });
    const ok = await makeProperty({});
    const noPhoto = await makeProperty({ withPhoto: false });
    const offSite = await makeProperty({ offSite: true });
    const sold = await makeProperty({ status: "SOLD" });

    const result = await runDailyStoriesTick(NOON_DUSHANBE);

    expect(result.ran).toBe(true);
    const called = publishPropertyCardStory.mock.calls.map((call) => call[0]);
    expect(called).toContain(ok.id);
    expect(called).not.toContain(noPhoto.id);
    expect(called).not.toContain(offSite.id);
    expect(called).not.toContain(sold.id);
  });

  it("объект с историей за последние 7 дней (любым каналом) — не кандидат", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { dailyStoriesEnabled: true, dailyStoriesHourDushanbe: 11, dailyStoriesCount: 1000 } });
    const recent = await makeProperty({});
    await prisma.propertyStoryPost.create({
      data: { propertyId: recent.id, channel: "INSTAGRAM", mediaId: "m1", partIndex: 0, kind: "PRICE_DROP", publishedAt: new Date(NOON_DUSHANBE.getTime() - 60 * 60 * 1000) },
    });
    const eligible = await makeProperty({});

    await runDailyStoriesTick(NOON_DUSHANBE);

    const called = publishPropertyCardStory.mock.calls.map((call) => call[0]);
    expect(called).toContain(eligible.id);
    expect(called).not.toContain(recent.id);
  });

  it("publishPropertyCardStory упала — считается неудачей, не роняет прогон целиком", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { dailyStoriesEnabled: true, dailyStoriesHourDushanbe: 11, dailyStoriesCount: 1 } });
    publishPropertyCardStory.mockRejectedValueOnce(new Error("Graph API недоступен"));
    await makeProperty({});

    const result = await runDailyStoriesTick(NOON_DUSHANBE);

    expect(result.ran).toBe(true);
    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);
  });
});
