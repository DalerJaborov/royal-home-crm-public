import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { PropertyNarrationView } from "@royal-home/shared";
vi.mock("../../lib/api", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../lib/api")>()), api: vi.fn() }));
import { NarrationPreviewBlock, formatDueAt, previewLengthLine } from "../NarrationPreviewBlock";

/** ПРОСЛУШАТЬ ПЕРЕД ВЫПУСКОМ (17.11.2026): новый ролик ждёт решения хозяина объекта. */
type Data = Pick<PropertyNarrationView, "preview" | "previewDeclined" | "versions">;
const preview = (over: Record<string, unknown> = {}) => ({
  versionId: "11111111-1111-4111-8111-111111111111", revision: 3, previewPath: "/uploads/handoff/new.mp4", currentPath: "/uploads/handoff/old.mp4",
  oldVersionId: "22222222-2222-4222-8222-222222222222", createdAt: "2026-11-17T10:00:00.000Z", dueAt: "2026-11-17T10:20:00.000Z",
  voiceSec: 33.6, clipSec: 36.2, note: "ускорено на 5 %", canDecide: true, ...over,
});
const data = (over: Partial<Data> = {}): Data => ({
  preview: preview(), versions: [{ id: "11111111-1111-4111-8111-111111111111", revision: 3 }, { id: "22222222-2222-4222-8222-222222222222", revision: 2 }] as unknown as Data["versions"], ...over,
} as Data);
function render(d: Data) {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><NarrationPreviewBlock propertyId="p1" data={d} /></QueryClientProvider>);
}

describe("Прослушать перед выпуском", () => {
  // Срок в данных — 17.11 15:20 по Душанбе; «сейчас» того же дня, иначе к времени дописывается дата.
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-17T08:00:00.000Z")); });
  afterAll(() => { vi.useRealTimers(); });
  it("хозяин видит плеер, длину, сравнение, срок и три кнопки", () => {
    const html = render(data());
    for (const part of ["Новый ролик с новой озвучкой — послушайте", "/uploads/handoff/new.mp4", "Голос 34 с · ролик 36 с", "ускорено на 5 %",
      "Сравнить со старым", "/uploads/handoff/old.mp4", "Было (версия 2)", "Стало (версия 3)", "Если не решите — выйдет сам в 15:20",
      "Выпустить", "Другой голос или текст", "Оставить старый"]) expect(html).toContain(part);
    expect(html).not.toContain("Решает агент объекта");
  });
  it("без права решать кнопок нет, есть подпись", () => {
    const html = render(data({ preview: preview({ canDecide: false }) as Data["preview"] }));
    expect(html).toContain("Решает агент объекта");
    for (const part of ["Выпустить", "Оставить старый", "Другой голос или текст"]) expect(html).not.toContain(part);
    expect(html).toContain("/uploads/handoff/new.mp4");
  });
  it("dueAt=null: сам не выйдет", () => {
    const html = render(data({ preview: preview({ dueAt: null }) as Data["preview"] }));
    expect(html).toContain("Сам не выйдет — ждёт вашего решения");
    expect(html).not.toContain("выйдет сам в");
  });
  it("нет старого ролика и старой озвучки: сравнения нет", () => {
    const html = render(data({ preview: preview({ currentPath: null, oldVersionId: null }) as Data["preview"] }));
    expect(html).not.toContain("Сравнить со старым");
  });
  it("хозяин отказался: тихая строка без блока", () => {
    const html = render(data({ preview: null, previewDeclined: true }));
    expect(html).toContain("Новая озвучка не наложена: оставлен старый ролик. Выберите другой голос или текст — CRM наложит заново");
    expect(html).not.toContain("послушайте");
  });
  it("нет preview — блока нет", () => {
    expect(render(data({ preview: null }))).toBe("");
  });
  it("время по Душанбе: сегодня только часы, другой день с датой", () => {
    const now = new Date("2026-11-17T08:00:00.000Z");
    expect(formatDueAt("2026-11-17T10:20:00.000Z", now)).toBe("15:20");
    expect(formatDueAt("2026-11-18T10:20:00.000Z", now)).toContain("18 ноября");
    expect(previewLengthLine({ voiceSec: null, clipSec: 36 })).toBe("ролик 36 с");
  });
});
