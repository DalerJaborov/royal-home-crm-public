import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CallSourceMark } from "./CallSourceMark";

/** Метка «WhatsApp» у входящего (18.11.2026): одна на все строки звонков, у линии — пусто. */
describe("CallSourceMark", () => {
  it("звонок из WhatsApp — метка во всех трёх видах строки", () => {
    for (const look of ["royal", "chip", "chip-xs"] as const) {
      const html = renderToStaticMarkup(<CallSourceMark source="whatsapp" look={look} />);
      expect(html).toContain("WhatsApp");
      expect(html).toContain('title="Клиент позвонил через WhatsApp"');
    }
    expect(renderToStaticMarkup(<CallSourceMark source="whatsapp" look="royal" />)).toContain('data-tone="neutral"');
    expect(renderToStaticMarkup(<CallSourceMark source="whatsapp" look="chip-xs" />)).toContain('class="chip ok xs"');
  });

  it("линия, пусто или старый ответ без поля — ничего не рисуется", () => {
    for (const source of ["phone", undefined, null, "что-то новое"]) {
      expect(renderToStaticMarkup(<CallSourceMark source={source} look="chip" />)).toBe("");
    }
  });
});
