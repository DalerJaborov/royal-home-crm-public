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
  it("высота равна содержимому, внутренней прокрутки нет, ручной растяжки нет", () => {
    let content = 140;
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => content });
    try {
      const { getByLabelText } = render(<Harness />);
      const area = getByLabelText("Текст озвучки") as HTMLTextAreaElement;
      expect(area.style.height).toBe("142px");
      expect(area.className).toContain("overflow-hidden");
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
