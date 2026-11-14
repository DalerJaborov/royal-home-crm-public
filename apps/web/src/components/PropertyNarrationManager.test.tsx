import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyNarrationItem, PropertyNarrationView } from "@royal-home/shared";
vi.mock("../lib/api", () => ({ api: vi.fn() }));
import { PropertyNarrationManager, narrationIsPending } from "./PropertyNarrationManager";

/**
 * КАРТОЧКА ОБЪЕКТА: АГЕНТ ВИДИТ ТОЛЬКО ГОЛОС, ТЕКСТ И «ОЗВУЧИТЬ» (14.11.2026, владелец: «всю
 * техническую часть полностью убирать в настройки CRM, в настройках объекта этого вообще не должно быть»).
 */
const config = {
  modelId: "eleven_v4", autoGenerate: true,
  voices: [{ id: "f1", name: "Мадина", gender: "female" as const }, { id: "m1", name: "Фирӯз", gender: "male" as const }],
  templates: [
    { id: "tg-a", name: "Кӯтоҳ", lang: "tg" as const, text: "{вид} барои фурӯш. Масоҳаташ {площадь} метри мураббаъ." },
    { id: "tg-b", name: "Дароз", lang: "tg" as const, text: "Ассалому алайкум! {вид}, {площадь} метри мураббаъ." },
    { id: "ru-a", name: "Русский", lang: "ru" as const, text: "В продаже {вид}. Площадь {площадь} метров." },
  ],
};
const facts = { type: "APARTMENT", rooms: 2, areaSqm: "62", floor: 3, totalFloors: 9, district: "Сино", price: "60000", currency: "USD" };
const version = (over: Partial<PropertyNarrationItem> = {}): PropertyNarrationItem => ({ id: "v", revision: 1, script: "Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.", voiceId: "f1", status: "READY",
  approvedAt: null, stale: false, hasAudio: true, errorCode: null, createdAt: "2026-11-14", source: "WIZARD", templateId: "tg-a", language: "tg", ...over });
function render(overrides: Partial<PropertyNarrationView> = {}) {
  const client = new QueryClient();
  client.setQueryData(["property-narration", "p"], { versions: [], suggestedScript: "Квартира.", facts, config, configured: true, autoGenerate: true,
    canApprove: false, canApproveAudio: true, canDraft: true, sendsEnabled: false, ...overrides } satisfies PropertyNarrationView);
  return renderToStaticMarkup(<QueryClientProvider client={client}><PropertyNarrationManager propertyId="p" /></QueryClientProvider>);
}
const TECH = ["Модель озвучки", "Символов в сутки", "Словарь произношения", "Настройки голосов", "Служебное", "Сгенерировать в ElevenLabs", "Подготовить образцы"];

describe("карточка объекта: озвучка для агента", () => {
  it("нет озвучки: сначала голос, потом текст по шаблону с цифрами словами, одна кнопка «Озвучить», техники нет", () => {
    const html = render();
    expect(html.indexOf("Голос")).toBeLessThan(html.indexOf("Текст"));
    expect(html).toContain("Квартира барои фурӯш. Масоҳаташ шасту ду метри мураббаъ.");
    expect(html).toContain(">Озвучить<");
    expect(html).toContain("Другой вариант");
    expect(html).toContain("Тоҷикӣ"); expect(html).toContain("Русский");
    for (const word of TECH) expect(html).not.toContain(word);
  });
  it("готовое аудио: послушать и одобрить, без формы", () => {
    const html = render({ versions: [version()] });
    expect(html).toContain("послушайте и одобрите"); expect(html).toContain("Одобрить"); expect(html).toContain("Изменить голос или текст");
    expect(html).not.toContain("Другой вариант");
  });
  it("озвучку разового прохода одобряет владелец, а не агент", () => {
    expect(render({ versions: [version({ source: "BACKFILL" })], canApproveAudio: false })).toContain("одобряет владелец");
  });
  it("готовится: статус и опрос сервера, кнопок нет", () => {
    const pending = version({ status: "DRAFT", hasAudio: false, generateAfter: "2026-11-14T10:00:00Z" });
    expect(render({ versions: [pending] })).toContain("Готовим озвучку");
    expect(narrationIsPending(pending)).toBe(true);
    expect(narrationIsPending(version())).toBe(false);
  });
  it("одобрено, устарело, не получилось — понятными словами", () => {
    expect(render({ versions: [version({ approvedAt: "2026-11-14" })] })).toContain("Озвучка одобрена");
    expect(render({ versions: [version({ stale: true })] })).toContain("Данные объекта изменились");
    const failed = render({ versions: [version({ status: "FAILED", hasAudio: false })] });
    expect(failed).toContain("Озвучка не получилась"); expect(failed).toContain(">Озвучить<");
  });
  it("«Без озвучки»: только кнопка включить", () => {
    const html = render({ off: true });
    expect(html).toContain("Включить озвучку"); expect(html).not.toContain(">Озвучить<");
  });
  it("автоозвучка выключена: агент сохраняет текст, генерирует маркетинг", () => {
    const html = render({ autoGenerate: false });
    expect(html).toContain("Сохранить текст"); expect(html).not.toContain(">Озвучить<");
  });
  it("служебное (передача монтажёру, отчёт собственнику) — только маркетингу и руководству, свёрнутым", () => {
    const marketing = render({ canApprove: true, versions: [version({ approvedAt: "2026-11-14" })] });
    expect(marketing).toContain("Служебное"); expect(marketing).toContain("Только новую озвучку"); expect(marketing).toContain("<details");
    expect(render({ versions: [version({ approvedAt: "2026-11-14" })] })).not.toContain("Служебное");
  });
  it("живая отправка плана монтажёру — только когда сервер в LIVE", () => {
    const deliveries = [{ id: "d", status: "PREVIEW", mode: "AUDIO_ONLY", versionId: "v", createdAt: "2026-11-14", lastError: null, planHash: "a".repeat(64) }];
    expect(render({ canApprove: true, deliveries })).not.toContain("Подтвердить отправку этого плана");
    expect(render({ canApprove: true, sendsEnabled: true, deliveries })).toContain("Подтвердить отправку этого плана");
  });
  it("монтажёр (canDraft=false) только слушает", () => {
    const html = render({ canDraft: false, canApproveAudio: false, versions: [version({ approvedAt: "2026-11-14" })] });
    expect(html).not.toContain("Без озвучки"); expect(html).not.toContain(">Изменить<");
  });
});
