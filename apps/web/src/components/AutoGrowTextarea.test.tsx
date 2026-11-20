// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AutoGrowTextarea } from "./NarrationComposer";

/** Владелец 20.11.2026: текст озвучки в поле обрезался внутренним скроллом («с радостью покажем!» спрятано). */
afterEach(cleanup);

function Harness() {
  const [text, setText] = useState("коротко");
  return <AutoGrowTextarea aria-label="Текст озвучки" minRows={6} value={text} onChange={(e) => setText(e.target.value)} />;
}

describe("поле текста озвучки растёт по тексту", () => {
  it("изменилась ширина (поворот телефона) — высота пересчитывается; без изменения ширины — нет", () => {
    let content = 100;
    let width = 300;
    let notify: () => void = () => {};
    const OriginalObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { constructor(cb: () => void) { notify = cb; } observe() {} disconnect() {} };
    const heightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const widthDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => content });
    Object.defineProperty(Element.prototype, "clientWidth", { configurable: true, get: () => width });
    try {
      const { getByLabelText } = render(<Harness />);
      const area = getByLabelText("Текст озвучки") as HTMLTextAreaElement;
      expect(area.style.height).toBe("102px");
      content = 260; notify();
      expect(area.style.height).toBe("102px"); // ширина та же — пересчёта нет
      width = 180; notify();
      expect(area.style.height).toBe("262px"); // ширина сузилась — текст переносится иначе, поле выросло
    } finally {
      (globalThis as { ResizeObserver?: unknown }).ResizeObserver = OriginalObserver;
      if (heightDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", heightDescriptor); else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
      if (widthDescriptor) Object.defineProperty(Element.prototype, "clientWidth", widthDescriptor); else delete (Element.prototype as { clientWidth?: number }).clientWidth;
    }
  });
  it("высота равна содержимому, внутренней прокрутки нет, ручной растяжки нет", () => {
    let content = 140;
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => content });
    try {
      const { getByLabelText } = render(<Harness />);
      const area = getByLabelText("Текст озвучки") as HTMLTextAreaElement;
      expect(area.style.height).toBe("142px");
      expect(area.className).toContain("overflow-y-auto");
      expect(area.className).toContain("resize-none");
      expect(area.rows).toBe(6);
      // Дописали длинный текст — поле выросло, а не получило прокрутку.
      content = 420;
      fireEvent.change(area, { target: { value: "Квартира в центре. ".repeat(30) } });
      expect(area.style.height).toBe("422px");
      // Сократили — поле вернулось к высоте содержимого.
      content = 90;
      fireEvent.change(area, { target: { value: "ещё короче" } });
      expect(area.style.height).toBe("92px");
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original); else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    }
  });
});
