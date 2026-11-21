// @vitest-environment jsdom
/**
 * Фото объекта — одна дверь (пачка D1, 20.11.2026). Поведение и сторож класса:
 * битая ссылка → следующая → заглушка «Фото недоступно», коробка 4:3 и не шире
 * 480 px; голый <img> с адресом фото объекта вне PropertyPhoto не пропускается.
 */
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

  it("contain: фото целиком поверх размытой подложки из миниатюры; без contain подложки нет", () => {
    const { container, rerender } = render(<PropertyPhoto fill contain backdropSource="thumb.jpg" sources={["big.jpg", "thumb.jpg"]} />);
    const backdrop = container.querySelector("img[data-photo-backdrop]") as HTMLImageElement;
    const main = container.querySelector("img:not([data-photo-backdrop])") as HTMLImageElement;
    expect(backdrop.getAttribute("src")).toBe("thumb.jpg");
    expect(backdrop.getAttribute("aria-hidden")).toBe("true");
    expect(backdrop.style.filter).toContain("blur");
    expect(main.getAttribute("src")).toBe("big.jpg");
    expect(main.style.objectFit).toBe("contain");
    rerender(<PropertyPhoto fill sources={["big.jpg"]} />);
    expect(container.querySelector("img[data-photo-backdrop]")).toBeNull();
    expect((container.querySelector("img") as HTMLImageElement).style.objectFit).toBe("cover");
  });
});
