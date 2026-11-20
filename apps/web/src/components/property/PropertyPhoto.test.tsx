// @vitest-environment jsdom
/**
 * Фото объекта — одна дверь (пачка D1, 20.11.2026). Поведение и сторож класса:
 * битая ссылка → следующая → заглушка «Фото недоступно», коробка 4:3 и не шире
 * 480 px; голый <img> с адресом фото объекта вне PropertyPhoto не пропускается.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PropertyPhoto, photoCandidates, photoFallbackText } from "./PropertyPhoto";

afterEach(cleanup);

describe("PropertyPhoto", () => {
  it("drops empty and repeated sources", () => {
    expect(photoCandidates([undefined, "", " a.jpg ", "a.jpg", null, "b.jpg"])).toEqual(["a.jpg", "b.jpg"]);
  });

  it("tries the next source on error, then shows the shared fallback", () => {
    const { container } = render(<PropertyPhoto sources={["big.jpg", "thumb.jpg"]} />);
    const img = () => container.querySelector("img");
    expect(img()?.getAttribute("src")).toBe("big.jpg");
    fireEvent.error(img()!);
    expect(img()?.getAttribute("src")).toBe("thumb.jpg");
    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(screen.getByRole("img", { name: "Фото недоступно" })).toBeTruthy();
    expect(container.textContent).toContain("Фото недоступно");
  });

  it("says «Нет фото» when there was nothing to load", () => {
    render(<PropertyPhoto sources={[]} />);
    expect(screen.getByRole("img", { name: "Нет фото" })).toBeTruthy();
    expect(photoFallbackText(false)).toBe("Нет фото");
  });

  it("keeps a bounded 4:3 box so a broken photo cannot stretch the card", () => {
    const { container } = render(<PropertyPhoto sources={["x.jpg"]} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.aspectRatio).toBe("4 / 3");
    expect(box.style.maxWidth).toBe("480px");
  });

  it("compact fallback is an icon with a spoken name and no visible caption", () => {
    const { container } = render(<PropertyPhoto compact sources={["gone.jpg"]} />);
    fireEvent.error(container.querySelector("img")!);
    expect(screen.getByRole("img", { name: "Фото недоступно" }).textContent).toBe("");
  });
});

/**
 * Сторож класса: `<img` с адресом фото объекта (photos / thumbUrl / coverPhotoUrl)
 * вне PropertyPhoto. Исключения — с причиной; список только убывает.
 */
const ALLOWED: Record<string, string> = {
  "components/property/PropertyPhoto.tsx": "сама дверь",
  "components/PhotoLightbox.tsx": "просмотр во весь экран, свой полноэкранный слой",
  "components/property-wizard/StepMedia.tsx": "предпросмотр только что выбранного файла в мастере",
  "components/property-wizard/DraftGate.tsx": "предпросмотр файлов черновика",
  "pages/socialVideos/PhotoPicker.tsx": "выбор кадров для ролика, не карточка объекта",
  "pages/PublicOwnerReport.tsx": "публичная страница отчёта собственнику, своя вёрстка",
  "components/look/home/parts.tsx": "строка главной: без фото рисуется круг-значок (по макету), onError есть",
  "components/clean/CleanDecisionRow.tsx": "прежний чистый вид, удаляется волной 3; onError есть",
  "components/clean/CleanFeaturedProperty.tsx": "прежний чистый вид, удаляется волной 3; onError есть",
  "components/clean/CleanPropertyReviewSheet.tsx": "прежний чистый вид, удаляется волной 3",
  "components/OwnerQuestionsBanner.tsx": "значок вопроса собственника 44 px, не фото карточки",
  "components/mobile/MobilePropertiesList.tsx": "старый телефонный список, удаляется вместе с Mobile*",
  "components/clean/CleanWorkQueues.tsx": "прежний чистый вид, удаляется волной 3; onError есть",
  "pages/PublicPropertyShare.tsx": "публичная страница для клиента, своя вёрстка",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

describe("PropertyPhoto guard", () => {
  it("no raw <img> with a property photo outside PropertyPhoto", () => {
    const root = path.resolve(__dirname, "../..");
    const offenders: string[] = [];
    for (const file of walk(root)) {
      const rel = path.relative(root, file).replace(/\\/g, "/");
      if (ALLOWED[rel]) continue;
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/<img\b[^>]*>/gs)) {
        if (/photos?\b|thumbUrl|coverPhotoUrl|propertyThumbUrl|photoUrl/.test(match[0])) offenders.push(`${rel}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still exists and still has a raw photo <img> (list only shrinks)", () => {
    const root = path.resolve(__dirname, "../..");
    const stale = Object.keys(ALLOWED).filter((rel) => {
      if (rel === "components/property/PropertyPhoto.tsx") return false;
      try {
        const text = readFileSync(path.join(root, rel), "utf8");
        return ![...text.matchAll(/<img\b[^>]*>/gs)].some((m) => /photos?\b|thumbUrl|coverPhotoUrl|propertyThumbUrl|photoUrl|src=\{(?:photo|src|m\.|item\.|it\.|current\.)/.test(m[0]));
      } catch { return true; }
    });
    expect(stale).toEqual([]);
  });
});
