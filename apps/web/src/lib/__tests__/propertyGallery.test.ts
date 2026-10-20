import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Галерея карточки объекта (24.09.2026, разбор карточки, пункты 15 и I; с
 * 06.10.2026 одна лента на ПК и телефон, `PropertyGallery`): фото открывается
 * во весь экран, а не вкладкой с сеткой-редактором, лента листается без потолка
 * на восьмом снимке. Раскладку проверяют кадры; здесь — что части на месте.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const gallery = read("../../components/property/PropertyGallery.tsx");
const page = read("../../pages/PropertyDetail.tsx");
const css = read("../../theme-royal-home-2026.css");

describe("галерея карточки объекта", () => {
  it("нажатие на фото открывает просмотр во весь экран, а не вкладку «Фото и видео»", () => {
    expect(gallery).toContain("onClick={() => setLightboxAt(i)}");
    expect(gallery).toMatch(/<PhotoLightbox\s+photos=\{photos\}\s+index=\{lightboxAt\}/);
    expect(gallery).not.toContain('setTab("media")');
  });

  it("индекс кадра считается по прокрутке без потолка, точки идут окном", () => {
    expect(gallery).toContain("Math.min(total - 1, Math.max(0, Math.round(el.scrollLeft / Math.max(1, el.clientWidth))))");
    expect(gallery).toContain("galleryDots(current, total)");
    expect(gallery).not.toMatch(/slice\(0, *8\)/);
  });

  it("на экране одна галерея: старой сетки `.gal` и ленты телефона в карточке нет", () => {
    expect(page.match(/<PropertyGallery /g)).toHaveLength(1);
    expect(page).not.toContain("gal n${");
    expect(page).not.toContain("gal-hero");
  });

  it("лента привязана к кадрам, стрелки только мышью, счётчик поверх фото", () => {
    expect(css).toContain("scroll-snap-type: x mandatory;");
    expect(css).toContain("@media (hover: hover) and (min-width: 821px)");
    expect(css).toContain(".rh2 .scr .rh-gallery-count");
  });
});
