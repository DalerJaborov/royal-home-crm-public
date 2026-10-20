import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/db.js";

/**
 * Одноразовая починка 17 карточек с испорченным полем «Ссылка на публикацию
 * Instagram» (t.me вместо адреса Instagram). Лента мокается: реальный Graph
 * API в тестах не нужен и не должен вызываться — vi.mock ловит попытку
 * настоящего похода наружу так же надёжно, как если бы её вообще не было.
 */

let items: { id: string; permalink: string; caption?: string; mediaType: string }[] = [];

vi.mock("../src/messengers/instagramFeed.js", () => ({
  getAllOwnMedia: vi.fn(async () => items),
}));

const { backfillInstagramUrls } = await import("../src/lib/backfillInstagramUrls.js");

const runId = Date.now().toString(36);
let districtId = "";
const propertyIds: string[] = [];

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-починка-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function makeBroken(url: string | null) {
  const p = await prisma.property.create({
    data: {
      title: `Тест-объект-починка-${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      rooms: 2,
      areaSqm: 50,
      price: 40000,
      currency: "USD",
      districtId,
      address: `Тестовая, ${10 + propertyIds.length}`,
      condition: "GOOD",
      instagramUrl: url,
    },
  });
  propertyIds.push(p.id);
  return p;
}

describe("backfillInstagramUrls", () => {
  it("чинит карточку, чей номер нашёлся в подписи ленты, и не трогает уже верные", async () => {
    const fixable = await makeBroken("https://t.me/royalhome_tj/1");
    const alreadyGood = await makeBroken(`https://www.instagram.com/reel/already-ok-${runId}/`);
    const noSignalInFeed = await makeBroken("https://t.me/royalhome_tj/2");

    items = [
      {
        id: "media-1",
        permalink: `https://www.instagram.com/reel/fixed-${runId}/`,
        caption: `Уютная квартира — №${fixable.shortId}`,
        mediaType: "VIDEO",
      },
      // Та же публикация, что уже стоит у alreadyGood — сверка не должна её тронуть.
      {
        id: "media-2",
        permalink: `https://www.instagram.com/reel/already-ok-${runId}/`,
        caption: `Отличная квартира — №${alreadyGood.shortId}`,
        mediaType: "VIDEO",
      },
      {
        id: "media-3",
        permalink: `https://www.instagram.com/reel/unrelated-${runId}/`,
        caption: "пост без номера карточки",
        mediaType: "VIDEO",
      },
    ];

    const result = await backfillInstagramUrls();

    // Теперь проверяются ВСЕ карточки с непустой ссылкой, включая уже верные —
    // владелец просил перепроверить все 36, а не только явно битые 17. checked/
    // alreadyCorrect не сравниваем на точное число: функция честно обходит ВСЮ
    // таблицу Property, а не только созданные этим тестом записи, и в общей
    // dev-базе могут быть посторонние объекты с непустой ссылкой — членство в
    // нужном списке проверяем прицельно, по id.
    expect(result.fixed.map((f) => f.propertyId)).toContain(fixable.id);
    expect(result.fixed.map((f) => f.propertyId)).not.toContain(alreadyGood.id);
    expect(result.unresolved.map((u) => u.propertyId)).toContain(noSignalInFeed.id);

    const refreshed = await prisma.property.findUniqueOrThrow({ where: { id: fixable.id } });
    expect(refreshed.instagramUrl).toBe(`https://www.instagram.com/reel/fixed-${runId}/`);

    const stillGood = await prisma.property.findUniqueOrThrow({ where: { id: alreadyGood.id } });
    expect(stillGood.instagramUrl).toBe(`https://www.instagram.com/reel/already-ok-${runId}/`);
  });

  it("ссылка похожа на Instagram, но ведёт не на ту публикацию — исправляется", async () => {
    const mismatched = await makeBroken(`https://www.instagram.com/reel/wrong-post-${runId}/`);

    items = [
      {
        id: "media-4",
        permalink: `https://www.instagram.com/reel/correct-post-${runId}/`,
        caption: `Двушка в центре — №${mismatched.shortId}`,
        mediaType: "VIDEO",
      },
    ];

    const result = await backfillInstagramUrls();

    expect(result.fixed.map((f) => f.propertyId)).toContain(mismatched.id);
    const refreshed = await prisma.property.findUniqueOrThrow({ where: { id: mismatched.id } });
    expect(refreshed.instagramUrl).toBe(`https://www.instagram.com/reel/correct-post-${runId}/`);
  });

  it("лента недоступна — все проблемные карточки уходят в unresolved, а не пропадают", async () => {
    const broken = await makeBroken("https://t.me/royalhome_tj/3");
    items = [];
    // getAllOwnMedia возвращает null, когда маркера нет или Graph API отказал.
    const mod = await import("../src/messengers/instagramFeed.js");
    (mod.getAllOwnMedia as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

    const result = await backfillInstagramUrls();
    expect(result.unresolved.map((u) => u.propertyId)).toContain(broken.id);
    expect(result.fixed.map((f) => f.propertyId)).not.toContain(broken.id);
  });

  it("нет ни одной карточки с непустой ссылкой — лента даже не запрашивается", async () => {
    // Реальная таблица Property в dev-базе почти никогда не пуста (сид + другие
    // тесты), поэтому этот угловой случай изолируем подменой findMany, а не
    // реальными данными — иначе тест зависел бы от постороннего состояния базы.
    const mod = await import("../src/messengers/instagramFeed.js");
    (mod.getAllOwnMedia as ReturnType<typeof vi.fn>).mockClear();
    const findManySpy = vi.spyOn(prisma.property, "findMany").mockResolvedValueOnce([]);

    try {
      const result = await backfillInstagramUrls();
      expect(result.checked).toBe(0);
      expect(result.fixed).toHaveLength(0);
      expect(mod.getAllOwnMedia).not.toHaveBeenCalled();
    } finally {
      findManySpy.mockRestore();
    }
  });
});
