import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { NARRATION_MUSIC_LIMITS, formatMusicDuration, narrationMusicTitleFromFile, type NarrationMusicLibraryView } from "@royal-home/shared";
vi.mock("../../lib/api", () => ({ api: vi.fn() }));
import { NarrationMusicLibrary } from "./NarrationMusicLibrary";

/** «Своя музыка» в Настройки → Озвучка (18.11.2026): список, прослушать, удалить, загрузить, рубильник. */
const library = (over: Partial<NarrationMusicLibraryView> = {}): NarrationMusicLibraryView => ({
  tracks: [
    { id: "11111111-1111-4111-8111-111111111111", title: "Утро в горах", durationSec: 65.4, sizeBytes: 2_000_000, format: "mp3", createdAt: "2026-11-18T10:00:00.000Z" },
    { id: "22222222-2222-4222-8222-222222222222", title: "Тихий вечер", durationSec: 9, sizeBytes: 300_000, format: "m4a", createdAt: "2026-11-18T10:01:00.000Z" },
  ],
  canConfigure: true, limits: NARRATION_MUSIC_LIMITS, ...over,
});
function render(data: NarrationMusicLibraryView | null, enabled = false) {
  const client = new QueryClient();
  if (data) client.setQueryData(["narration-music"], data);
  return renderToStaticMarkup(<QueryClientProvider client={client}><NarrationMusicLibrary enabled={enabled} onEnabledChange={() => {}} disabled={false} /></QueryClientProvider>);
}

describe("Настройки: своя музыка", () => {
  it("директор: треки с длиной, «Прослушать», «Удалить», «Загрузить трек»; рубильник по положению", () => {
    const html = render(library());
    for (const part of ["Своя музыка", "Утро в горах", "1:05", "Тихий вечер", "0:09", "Прослушать", "Удалить", "Загрузить трек", "Своя музыка при перемонтаже"]) expect(html).toContain(part);
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
    expect(render(library(), true)).toMatch(/type="checkbox"[^>]*checked/);
    expect(html).toContain('accept=".mp3,.m4a,audio/mpeg,audio/mp4"');
  });
  it("маркетинг: слушает, но не загружает и не удаляет; пустая библиотека — подсказка", () => {
    const html = render(library({ canConfigure: false }));
    expect(html).toContain("Прослушать");
    expect(html).not.toContain("Удалить");
    expect(html).not.toContain("Загрузить трек");
    expect(render(library({ tracks: [] }))).toContain("Треков пока нет");
  });
  it("название из имени файла и длина «м:сс»", () => {
    expect(narrationMusicTitleFromFile("utro_v_gorah.mp3")).toBe("utro v gorah");
    expect(narrationMusicTitleFromFile(".mp3")).toBe("Трек");
    expect(formatMusicDuration(125.6)).toBe("2:06");
  });
});
