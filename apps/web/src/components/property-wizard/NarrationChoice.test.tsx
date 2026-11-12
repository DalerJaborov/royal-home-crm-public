import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { NarrationOptionsView } from "@royal-home/shared";
vi.mock("../../lib/api", () => ({ api: vi.fn() }));
import { NarrationChoice, narrationChoiceForCreate } from "./NarrationChoice";
import { parseVoiceLines } from "../PropertyNarrationManager";

const facts = { type: "APARTMENT", rooms: 2, areaSqm: "62", floor: 3, totalFloors: 9, district: "Сино" };
const options: NarrationOptionsView = {
  templates: [
    { id: "tg-short", name: "Кӯтоҳ", lang: "tg", text: "{вид} барои фурӯш. [{комнаты} ҳуҷра.] Масоҳаташ {площадь} метри мураббаъ." },
    { id: "ru-short", name: "Рус", lang: "ru", text: "В продаже {вид}. Площадь {площадь} метров." },
  ],
  voices: [{ id: "f1", name: "Мадина", gender: "female" }, { id: "m1", name: "Фирӯз", gender: "male" }],
  defaultTemplateId: null, defaultVoiceId: "m1", autoGenerate: true,
};
function render(value = {}) {
  const client = new QueryClient();
  client.setQueryData(["narration-options"], options);
  return renderToStaticMarkup(<QueryClientProvider client={client}><NarrationChoice facts={facts} value={value} onChange={() => {}} /></QueryClientProvider>);
}

describe("wizard narration choice", () => {
  it("builds the Tajik text from the owner's template with numbers as words", () => {
    const html = render();
    expect(html).toContain("Квартира барои фурӯш. Ду ҳуҷра. Масоҳаташ шасту ду метри мураббаъ.");
    expect(html).toContain("Женские"); expect(html).toContain("Мужские");
    expect(html).toContain("придёт вам на прослушивание");
  });
  it("switches language with the template and keeps the agent's own text", () => {
    expect(render({ templateId: "ru-short" })).toContain("В продаже квартира. Площадь 62 метров.");
    expect(render({ script: "Свой текст агента про квартиру" })).toContain("Свой текст агента про квартиру");
  });
  it("sends only meaningful choices with the create request", () => {
    expect(narrationChoiceForCreate({})).toBeUndefined();
    expect(narrationChoiceForCreate({ script: "  коротко " })).toBeUndefined();
    expect(narrationChoiceForCreate({ templateId: "tg-short", voiceId: "f1", script: "Свой текст агента" })).toEqual({ templateId: "tg-short", voiceId: "f1", script: "Свой текст агента" });
  });
  it("«Без озвучки» (12.11.2026): уходит одним флагом, текст и голос скрыты", () => {
    expect(narrationChoiceForCreate({ none: true, voiceId: "f1" })).toEqual({ none: true });
    const html = render({ none: true });
    expect(html).toContain("Без озвучки");
    expect(html).not.toContain("Женские");
  });
  it("последний выбор сотрудника стоит заранее и подписан", () => {
    const client = new QueryClient();
    client.setQueryData(["narration-options"], { ...options, lastChoice: { voiceId: "f1", templateId: "ru-short" } });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><NarrationChoice facts={facts} value={{}} onChange={() => {}} /></QueryClientProvider>);
    expect(html).toContain("последний раз выбран");
    expect(html).toContain("В продаже квартира. Площадь 62 метров.");
    expect(html).toMatch(/value="f1"[^>]*checked|checked[^>]*value="f1"/);
  });
  it("voice lines accept an optional gender", () => {
    expect(parseVoiceLines("a | Мадина | ж\nb | Фирӯз | м\nc | Без пола")).toEqual([
      { id: "a", name: "Мадина", gender: "female" }, { id: "b", name: "Фирӯз", gender: "male" }, { id: "c", name: "Без пола" },
    ]);
  });
});
