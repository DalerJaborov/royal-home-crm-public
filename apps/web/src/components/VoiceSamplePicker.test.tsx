import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../lib/api", () => ({ api: vi.fn() }));
import { VoiceSamplePicker } from "./VoiceSamplePicker";

const voices = [{ id: "f1", name: "Мадина", gender: "female" as const }, { id: "m1", name: "Фирӯз", gender: "male" as const }, { id: "x1", name: "Без пола" }];
const render = (lang: "tg" | "ru", value: string | null = "m1") => renderToStaticMarkup(
  <VoiceSamplePicker name="v" voices={voices} value={value} lang={lang} onChange={() => {}}
    samples={[{ voiceId: "f1", lang: "tg" }, { voiceId: "m1", lang: "ru" }]} />,
);

describe("voice choice by ear (11.11.2026)", () => {
  it("shows «▶ Прослушать» only for voices with a ready sample in the template language", () => {
    const tg = render("tg");
    expect(tg).toContain("Прослушать голос Мадина");
    expect(tg).not.toContain("Прослушать голос Фирӯз");
    const ru = render("ru");
    expect(ru).toContain("Прослушать голос Фирӯз");
    expect(ru).not.toContain("Прослушать голос Мадина");
  });
  it("groups voices and marks the chosen one; no sample — still selectable", () => {
    const html = render("tg");
    expect(html).toContain("Женские"); expect(html).toContain("Мужские"); expect(html).toContain("Без пола");
    expect(html).toMatch(/checked=""[^>]*value="m1"|value="m1"[^>]*checked=""/);
    expect((html.match(/type="radio"/g) ?? []).length).toBe(3);
  });
});
