import { beforeAll, describe, expect, it } from "vitest";
import { siteImageUrls, SITE_MAX_IMAGE_URLS, type SyncableProperty } from "../src/lib/siteSync.js";

/**
 * Обложек на сайте нет (владелец, 01.10.2026): фирменные обложки нужны только
 * Instagram, Telegram и Facebook, а объявление на royalhome.tj показывает
 * обычные обработанные фото объекта в их порядке.
 */
beforeAll(() => {
  // publicUploadUrl собирает адрес от CRM_PUBLIC_URL — без него все ссылки
  // пустые и проверять нечего.
  process.env.CRM_PUBLIC_URL = "https://crm.example.tj";
});

function makeProperty(cover: string | null, photos: string[]): SyncableProperty {
  return {
    socialCoverSquareUrl: cover,
    photos: photos.map((url, order) => ({ url, order })),
  } as unknown as SyncableProperty;
}

describe("снимки объекта для сайта (siteImageUrls)", () => {
  it("обложка есть — на сайт её нет, фото идут как есть и в прежнем порядке", () => {
    const urls = siteImageUrls(makeProperty("/uploads/covers/a-cover-square.jpg", ["/uploads/1.webp", "/uploads/2.webp"]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/uploads/1.webp");
    expect(urls[1]).toContain("/uploads/2.webp");
    expect(urls.some((u) => u.includes("cover-square"))).toBe(false);
  });

  it("обложки нет — тот же список фото", () => {
    const urls = siteImageUrls(makeProperty(null, ["/uploads/1.webp", "/uploads/2.webp"]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/uploads/1.webp");
  });

  it("обложка из закрытой папки роликов (подписанная) тоже не попадает на сайт", () => {
    const urls = siteImageUrls(makeProperty("/uploads/handoff/x-cover-square.jpg", ["/uploads/1.webp"]));
    expect(urls).toHaveLength(1);
    expect(urls.some((u) => u.includes("handoff") || /[?&]t=/.test(u))).toBe(false);
  });

  it("у объекта только обложка и ни одного фото — список пуст, а не обложка", () => {
    expect(siteImageUrls(makeProperty("/uploads/covers/a-cover-square.jpg", []))).toEqual([]);
  });

  it("обложка совпала с одним из фото по ссылке — фото остаётся на своём месте", () => {
    const urls = siteImageUrls(makeProperty("/uploads/2.webp", ["/uploads/1.webp", "/uploads/2.webp"]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/uploads/1.webp");
    expect(urls[1]).toContain("/uploads/2.webp");
  });

  it("предел сайта соблюдается: лишние фото режутся с конца, обложка не отнимает место", () => {
    const photos = Array.from({ length: SITE_MAX_IMAGE_URLS + 3 }, (_, i) => `/uploads/p${i}.webp`);
    const urls = siteImageUrls(makeProperty("/uploads/covers/a-cover-square.jpg", photos));
    expect(urls).toHaveLength(SITE_MAX_IMAGE_URLS);
    expect(urls[0]).toContain("/uploads/p0.webp");
    expect(urls[SITE_MAX_IMAGE_URLS - 1]).toContain(`/uploads/p${SITE_MAX_IMAGE_URLS - 1}.webp`);
  });
});
