import { describe, expect, it, vi } from "vitest";
// Чистая сборка текста копии: до базы не доходим.
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: async () => {} } }));
import { narrationCopyMessages, NARRATION_TEXT_MESSAGE } from "../src/lib/narrationDelivery.js";
import { montageCopyNote } from "../src/lib/montageObservers.js";
import { TELEGRAM_CAPTION_MAX_CHARS } from "../src/telegram/api.js";

/** 21.11.2026: копия озвучки наблюдателю — тот же mp3 и та же подпись с пометкой «Копия. Монтажёр: …». */
describe("копия озвучки наблюдателям монтажа", () => {
  const note = montageCopyNote("Монтажёр");
  const audio = { id: "v1", storageKey: "narration/v1.mp3", filename: "property-213-voice-v1.mp3", caption: "Озвучка к ролику №213, версия 1, одобрена.\n\nТекст:\nНархи хона ҳафтсад ҳазор сомонӣ." };

  it("короткая подпись с текстом: один файл, подпись монтажёра целиком после пометки «Копия»", () => {
    expect(narrationCopyMessages(note, audio, 213)).toEqual({ caption: `${note}\n\n${audio.caption}`, text: null });
  });

  it("подпись с пометкой не влезла: файл с первой строкой, текст озвучки отдельным сообщением", () => {
    const long = { ...audio, caption: `Озвучка к ролику №213, версия 1, одобрена.\n\nТекст:\n${"сомонӣ ".repeat(160).trim()}` };
    const parts = narrationCopyMessages(note, long, 213);
    expect(parts.caption).toBe(`${note}\n\nОзвучка к ролику №213, версия 1, одобрена.`);
    expect(parts.caption!.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_MAX_CHARS);
    expect(parts.text).toBe(`${note}\n\nТекст озвучки №213:\n${"сомонӣ ".repeat(160).trim()}`);
  });

  it("текст, ушедший монтажёру отдельным сообщением, наблюдатель получает так же", () => {
    const text = { id: "v1-text", storageKey: NARRATION_TEXT_MESSAGE, filename: "", caption: "Нархи хона ҳафтсад ҳазор сомонӣ." };
    expect(narrationCopyMessages(note, text, 213)).toEqual({ caption: null, text: `${note}\n\nТекст озвучки №213:\nНархи хона ҳафтсад ҳазор сомонӣ.` });
  });
});
