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
    // Ревью 18.11: подпись текста на ролике не обещает того, чего код не делает (монтажёру CRM ничего не пишет).
    expect(html).toContain("при перемонтаже CRM сама кладёт плашку с ценой");
    expect(html).not.toContain("не вписывать");
    expect(html).toContain("1200 из 20000 символов");
    expect(html).toContain("f1 | Мадина | ж\nm1 | Фирӯз | м");
    expect(html).not.toContain("может директор или администратор");
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  });
  it("маркетинг видит, но не меняет: поля заблокированы, сохранения нет", () => {
    const html = render(view({ canConfigure: false }));
    expect(html).toContain("Менять настройки озвучки может директор или администратор");
    expect(html).not.toContain("Сохранить настройки озвучки");
    // 7 = прежние 5 + «Концовки» (#216) + «Озвучка текста в помощнике» (#214).
    expect(html.match(/<fieldset[^>]*disabled/g)?.length).toBe(7);
  });
  it("шаблоны и концовки (16.11.2026): у каждого галочки типов объекта, «только вручную», отдельный блок «Концовки»", () => {
    const html = render(view({ config: { ...view().config,
      templates: [{ id: "tg-apt-1", name: "Квартира 1", lang: "tg", text: "{вид} барои фурӯш.", propertyTypes: ["APARTMENT"] }, { id: "tg-short", name: "Кӯтоҳ", lang: "tg", text: "{вид} барои фурӯш.", manualOnly: true }],
      endings: [{ id: "end-a", lang: "tg", text: "Ба мо дар Директ нависед ё занг занед.", propertyTypes: ["APARTMENT", "HOUSE"] }, { id: "end-b", lang: "tg", text: "Ба мо занг занед." }] } }));
    for (const part of ["Концовки", "Добавить концовку", "Текст концовки", "Язык концовки", "Только вручную", "Подходит для", "Квартира", "Дом", "Участок", "Коммерция", "(любой объект)"]) expect(html).toContain(part);
    // Отмечено только то, что сохранено: у «Квартира 1» одна галочка типа, у «Кӯтоҳ» «только вручную», у концовки А две; плюс три общих рубильника
    // (третий — «Озвучка текста в помощнике» из #214, по умолчанию включён) и четвёртый — «Новую озвучку сначала
    // слушает агент» (по умолчанию включён). «CRM сама убирает старый голос» (#219) убран 18.11.2026.
    expect(html.match(/type="checkbox"[^>]*checked/g)?.length).toBe(1 + 1 + 2 + 4);
    expect(html).toContain("Ба мо дар Директ нависед ё занг занед.");
  });
  it("озвучка текста в помощнике: тумблер и три числа с умолчаниями, из настроек подставляются свои", () => {
    const html = render(view());
    for (const part of ["Озвучка текста в помощнике", "Озвучек на человека в сутки", "Символов в одном тексте", "Доля от дневного предела, %"]) expect(html).toContain(part);
    expect(html).toContain('value="5"'); expect(html).toContain('value="1500"'); expect(html).toContain('value="30"');
    const custom = render(view({ config: { ...view().config, freeNarrationPerPersonDaily: 7, freeNarrationMaxChars: 900, freeNarrationBudgetPercent: 15, freeNarrationEnabled: false } }));
    expect(custom).toContain('value="7"'); expect(custom).toContain('value="900"'); expect(custom).toContain('value="15"');
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
