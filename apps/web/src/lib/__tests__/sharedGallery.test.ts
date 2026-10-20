import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lightboxItemsFromShared, openIndexForCell } from "../sharedGallery";

/** Аудит 04.10.2026, WEB-PAGES05: фото 6-9 на публичной странице нельзя было открыть. */
const photos = Array.from({ length: 9 }, (_, i) => ({ url: `/p/${i + 1}.jpg`, thumbUrl: `/t/${i + 1}.jpg` }));

describe("галерея публичной ссылки", () => {
  it("просмотрщик получает все 9 фото, а не пять ячеек", () => {
    const items = lightboxItemsFromShared(photos);
    expect(items).toHaveLength(9);
    expect(items[8]?.url).toBe("/p/9.jpg");
    expect(new Set(items.map((i) => i.key)).size).toBe(9);
  });

  it("обычная ячейка открывает своё фото", () => {
    expect(openIndexForCell(0, 9)).toBe(0);
    expect(openIndexForCell(3, 9)).toBe(3);
  });

  it("«Ещё N» на последней ячейке открывает первое скрытое фото", () => {
    expect(openIndexForCell(4, 9)).toBe(5);
  });

  it("если фото не больше пяти, последняя ячейка открывает себя", () => {
    expect(openIndexForCell(4, 5)).toBe(4);
    expect(openIndexForCell(2, 3)).toBe(2);
  });

  it("страница подключает PhotoLightbox", () => {
    const src = readFileSync(fileURLToPath(new URL("../../pages/PublicPropertyShare.tsx", import.meta.url)), "utf8");
    expect(src).toContain("<PhotoLightbox");
    expect(src).not.toContain('target="_blank"');
  });
});
