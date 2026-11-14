import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { NarrationSettingsView } from "@royal-home/shared";
vi.mock("../../lib/api", () => ({ api: vi.fn() }));
import { NarrationSettingsPanel, parseVoiceLines } from "./NarrationSettingsPanel";

/**
 * НАСТРОЙКИ CRM → «ОЗВУЧКА РОЛИКОВ» (14.11.2026): вся техника озвучки, которую владелец убрал
 * из карточки объекта, живёт здесь. Директор правит, маркетинг только видит.
 */
const view = (over: Partial<NarrationSettingsView> = {}): NarrationSettingsView => ({
  config: {
    modelId: "eleven_v4", autoGenerate: true, mixByCrm: true, dailyCharLimit: 20000, dailyGenerationLimit: 40, debounceMinutes: 3,
    voices: [{ id: "f1", name: "Мадина", gender: "female" }, { id: "m1", name: "Фирӯз", gender: "male" }],
    templates: [{ id: "tg-a", name: "Кӯтоҳ", lang: "tg", text: "{вид} барои фурӯш." }, { id: "tg-b", name: "Дароз", lang: "tg", text: "Ассалому алайкум! {вид}." }],
    pronunciationRules: [{ word: "Сино", alias: "Сино", needsNative: true }],
  },
  apiKeyConfigured: true, sendsEnabled: false, quotaExceeded: false, canConfigure: true, configured: true, autoGenerate: true, samplesReady: 4,
  budget: { usedChars: 1200, usedGenerations: 3, dailyChars: 20000, dailyGenerations: 40 }, ...over,
});
function render(data: NarrationSettingsView) {
  const client = new QueryClient();
  client.setQueryData(["narration-settings"], data);
  return renderToStaticMarkup(<QueryClientProvider client={client}><NarrationSettingsPanel /></QueryClientProvider>);
}

describe("Настройки CRM: озвучка роликов", () => {
  it("директор видит всю технику и кнопку сохранения", () => {
    const html = render(view());
    for (const part of ["Модель озвучки", "Подготовить образцы голосов", "Готово образцов: 4", "Автоозвучка", "Голос накладывает CRM",
      "Символов в сутки", "Шаблоны текста", "Словарь произношения", "проверить носителем", "Сохранить настройки озвучки"]) expect(html).toContain(part);
    expect(html).toContain("1200 из 20000 символов");
    expect(html).toContain("f1 | Мадина | ж\nm1 | Фирӯз | м");
    expect(html).not.toContain("может директор или администратор");
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  });
  it("маркетинг видит, но не меняет: поля заблокированы, сохранения нет", () => {
    const html = render(view({ canConfigure: false }));
    expect(html).toContain("Менять настройки озвучки может директор или администратор");
    expect(html).not.toContain("Сохранить настройки озвучки");
    expect(html.match(/<fieldset[^>]*disabled/g)?.length).toBe(5);
  });
  it("кредиты закончились — предупреждение; без ключа образцы не заказать", () => {
    expect(render(view({ quotaExceeded: true }))).toContain("Кредиты ElevenLabs закончились");
    const html = render(view({ configured: false, apiKeyConfigured: false }));
    expect(html).toContain("Ключ ElevenLabs: <b>не настроен</b>");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Подготовить образцы голосов/);
  });
  it("строки голосов: пол необязателен, «|» в названии сохраняется", () => {
    expect(parseVoiceLines("a1 | Мадина | ж\n\nb2 | Фирӯз\nc3 | Голос | новый | муж")).toEqual([
      { id: "a1", name: "Мадина", gender: "female" }, { id: "b2", name: "Фирӯз" }, { id: "c3", name: "Голос | новый", gender: "male" },
    ]);
  });
});
