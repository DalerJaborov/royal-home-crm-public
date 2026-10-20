import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ПОДБОРКИ ОБЪЕКТОВ (28.09.2026, agent-brief.md reposts-digests).
 *
 * `pickDigest`/`digestCaption` — чистые от сети, читают только базу. Полный
 * прогон публикации (три канала) не тестируется здесь отдельно: каналы —
 * ровно те же функции, что уже покрыты photo-posts.test.ts и
 * social-reposts.test.ts (lib/photoPosts.ts переиспользуется без изменений).
 */

const { logSystemError } = vi.hoisted(() => ({ logSystemError: vi.fn(async () => {}) }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError,
}));

const { prisma } = await import("../src/db.js");
const { pickDigest, digestCaption, runSocialDigestsTick, DIGEST_KINDS } = await import("../src/lib/socialDigests.js");
const { dushanbeWallClock } = await import("../src/lib/dushanbeTime.js");

const runId = Date.now().toString(36);
let districtA: string;
let districtB: string;
const propertyIds: string[] = [];
let settingsBefore: Record<string, unknown> | null = null;

/** weekIndex(now) = floor(now / 7d) — конструируем `now` под нужный индекс
 *  недели, чтобы выбрать конкретный вид подборки детерминированно (см.
 *  lib/socialDigests.ts::weekIndex, DIGEST_KINDS[weekIndex % 3]). */
const WEEK_MS = 7 * 86_400_000;
function nowForWeekIndex(weekIndex: number): Date {
  // Полдень третьего дня недели — подальше от границ недели (округления).
  return new Date(weekIndex * WEEK_MS + 3 * 86_400_000 + 12 * 3_600_000);
}
function nowForKindIndex(kindIndex: number): Date {
  return nowForWeekIndex(kindIndex);
}
const DISTRICT_BUDGET_NOW = nowForKindIndex(DIGEST_KINDS.indexOf("DISTRICT_BUDGET"));
const NEW_THIS_WEEK_NOW = nowForKindIndex(DIGEST_KINDS.indexOf("NEW_THIS_WEEK"));
const ROOMS_NOW = nowForKindIndex(DIGEST_KINDS.indexOf("ROOMS"));
// Далёкая неделя того же вида (NEW_THIS_WEEK, индекс 1 по модулю 3), но за
// пределами окна «последние 7 дней» от любых дат, которые ставят другие тесты
// этого файла относительно NEW_THIS_WEEK_NOW — иначе их объекты просочились бы
// в выборку «меньше 3» ниже и сделали бы её недетерминированной.
const NEW_THIS_WEEK_FAR_NOW = nowForWeekIndex(1 + 3 * 50);

async function makeProperty(opts: {
  districtId: string;
  rooms?: number;
  price?: number;
  currency?: "USD" | "TJS";
  postApprovedAt?: Date | null;
}) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-подборка-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: opts.rooms ?? 2,
      areaSqm: 60,
      price: opts.price ?? 400_000,
      currency: opts.currency ?? "TJS",
      districtId: opts.districtId,
      address: "Тестовая, 12",
      condition: "GOOD",
      status: "AVAILABLE",
      offSite: false,
      publishedOnSite: true,
      postApprovedAt: opts.postApprovedAt ?? null,
    },
  });
  propertyIds.push(p.id);
  await prisma.propertyPhoto.create({ data: { propertyId: p.id, url: `/uploads/digest-${p.id}.webp`, thumbUrl: `/uploads/digest-${p.id}.webp`, order: 0 } });
  return p;
}

beforeAll(async () => {
  districtA = (await prisma.district.create({ data: { name: `Сино-тест-${runId}` } })).id;
  districtB = (await prisma.district.create({ data: { name: `Другой-район-${runId}` } })).id;
  settingsBefore = (await prisma.settings.findUnique({ where: { id: "singleton" } })) as unknown as Record<string, unknown>;
});

afterAll(async () => {
  await prisma.socialDigestPost.deleteMany({ where: { propertyIds: { hasSome: propertyIds } } });
  await prisma.propertyPhoto.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: { in: [districtA, districtB] } } });
  if (settingsBefore) {
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        digestsEnabled: settingsBefore.digestsEnabled as boolean,
        digestWeekday: settingsBefore.digestWeekday as number,
        digestHourDushanbe: settingsBefore.digestHourDushanbe as number,
        digestLastRunAt: settingsBefore.digestLastRunAt as Date | null,
      },
    });
  }
  await prisma.$disconnect();
});

beforeEach(() => {
  logSystemError.mockClear();
});

// ---------------------------------------------------------------------------

describe("pickDigest", () => {
  it("DISTRICT_BUDGET — район с наибольшим числом объектов, бюджет округлён вверх до 50 000, только объекты дешевле", async () => {
    // pickDigest берёт САМЫЙ населённый район по ВСЕЙ базе (стенд — копия
    // эталона с сидом) — чтобы тест не зависел от того, сколько объектов там
    // уже есть, сперва меряем текущий максимум и гарантированно перекрываем
    // его в districtA.
    const before = await prisma.property.groupBy({
      by: ["districtId"],
      where: { deletedAt: null, status: "AVAILABLE", offSite: false, publishedOnSite: true, districtId: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 1,
    });
    const currentMax = before[0]?._count._all ?? 0;
    // 4 низкие цены на каждую 1 высокую — медиана остаётся в низком кластере
    // независимо от того, сколько строк добавит цикл (currentMax может быть
    // любым), и «дешевле медианы» надёжно набирает ≥3 объекта.
    const prices = [100_000, 120_000, 140_000, 160_000, 5_000_000];
    for (let i = 0; i < currentMax + 3; i++) {
      await makeProperty({ districtId: districtA, price: prices[i % prices.length] });
    }
    await makeProperty({ districtId: districtB, price: 100_000 });

    const pick = await pickDigest(DISTRICT_BUDGET_NOW);
    expect(pick.kind).toBe("DISTRICT_BUDGET");
    if ("reason" in pick) throw new Error(`ожидали подборку, получили пропуск: ${pick.reason}`);
    expect(pick.title).toContain("Сино-тест");
    expect(pick.properties.length).toBeGreaterThanOrEqual(3);
    expect(pick.title).toMatch(/до [\d\s]+ сомони/);
  });

  it("NEW_THIS_WEEK — только объекты с postApprovedAt за последние 7 дней", async () => {
    const recent = new Date(NEW_THIS_WEEK_NOW.getTime() - 2 * 86_400_000);
    const old = new Date(NEW_THIS_WEEK_NOW.getTime() - 30 * 86_400_000);
    await makeProperty({ districtId: districtA, postApprovedAt: recent });
    await makeProperty({ districtId: districtA, postApprovedAt: recent });
    await makeProperty({ districtId: districtA, postApprovedAt: recent });
    await makeProperty({ districtId: districtA, postApprovedAt: old }); // не должен попасть

    const pick = await pickDigest(NEW_THIS_WEEK_NOW);
    expect(pick.kind).toBe("NEW_THIS_WEEK");
    if ("reason" in pick) throw new Error(`ожидали подборку, получили пропуск: ${pick.reason}`);
    expect(pick.title).toBe("Новое за неделю");
    expect(pick.properties.length).toBeGreaterThanOrEqual(3);
  });

  it("ROOMS — самая частая комбинация комнат/района", async () => {
    // Та же оговорка, что у DISTRICT_BUDGET выше: комбинация (район, комнаты)
    // берётся по всей базе — перекрываем текущий максимум с запасом,
    // используя заведомо необычное число комнат (7), которого в сиде нет.
    const before = await prisma.property.groupBy({
      by: ["districtId", "rooms"],
      where: { deletedAt: null, status: "AVAILABLE", offSite: false, publishedOnSite: true, districtId: { not: null }, rooms: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 1,
    });
    const currentMax = before[0]?._count._all ?? 0;
    for (let i = 0; i < Math.max(3, currentMax + 3); i++) {
      await makeProperty({ districtId: districtA, rooms: 7 });
    }
    await makeProperty({ districtId: districtA, rooms: 1 });

    const pick = await pickDigest(ROOMS_NOW);
    expect(pick.kind).toBe("ROOMS");
    if ("reason" in pick) throw new Error(`ожидали подборку, получили пропуск: ${pick.reason}`);
    expect(pick.title).toContain("7-комнатные");
    expect(pick.properties.every((p) => p.rooms === 7)).toBe(true);
  });

  it("меньше 3 подходящих объектов — пропуск с причиной, не ошибка", async () => {
    // Своя, далёкая неделя (см. NEW_THIS_WEEK_FAR_NOW) — ничьи чужие объекты
    // из соседних тестов файла в её окно «последние 7 дней» не попадают.
    await makeProperty({ districtId: districtB, postApprovedAt: new Date(NEW_THIS_WEEK_FAR_NOW.getTime() - 86_400_000) });
    await makeProperty({ districtId: districtB, postApprovedAt: new Date(NEW_THIS_WEEK_FAR_NOW.getTime() - 86_400_000) });

    const pick = await pickDigest(NEW_THIS_WEEK_FAR_NOW);
    expect(pick.kind).toBe("NEW_THIS_WEEK");
    expect("reason" in pick).toBe(true);
    if ("reason" in pick) expect(pick.reason).toContain("2");
  });
});

// ---------------------------------------------------------------------------

describe("digestCaption", () => {
  it("подпись содержит номера объектов (№N) и заголовок", async () => {
    const p1 = await makeProperty({ districtId: districtA, rooms: 2, price: 200_000 });
    const p2 = await makeProperty({ districtId: districtA, rooms: 3, price: 300_000 });
    const caption = await digestCaption("Тестовая подборка", [
      { id: p1.id, shortId: p1.shortId, rooms: p1.rooms, areaSqm: p1.areaSqm, price: p1.price, currency: p1.currency, districtName: "Сино" },
      { id: p2.id, shortId: p2.shortId, rooms: p2.rooms, areaSqm: p2.areaSqm, price: p2.price, currency: p2.currency, districtName: "Сино" },
    ]);
    expect(caption).toContain("Тестовая подборка");
    expect(caption).toContain(`№${p1.shortId}`);
    expect(caption).toContain(`№${p2.shortId}`);
  });
});

// ---------------------------------------------------------------------------

describe("runSocialDigestsTick — гейты", () => {
  it("выключено — не запускается", async () => {
    await prisma.settings.update({ where: { id: "singleton" }, data: { digestsEnabled: false } });
    const result = await runSocialDigestsTick(DISTRICT_BUDGET_NOW);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("выключено");
  });

  it("«сегодня уже запускали» — второй тик в тот же день не запускается", async () => {
    const now = DISTRICT_BUDGET_NOW;
    const wall = dushanbeWallClock(now);
    await prisma.settings.update({
      where: { id: "singleton" },
      data: {
        digestsEnabled: true,
        digestWeekday: wall.getUTCDay(),
        digestHourDushanbe: wall.getUTCHours(),
        digestLastRunAt: now,
      },
    });
    const result = await runSocialDigestsTick(now);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe("сегодня уже запускали");
    await prisma.settings.update({ where: { id: "singleton" }, data: { digestsEnabled: false, digestLastRunAt: null } });
  });
});
