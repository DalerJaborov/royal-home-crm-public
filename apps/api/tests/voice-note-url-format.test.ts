import { describe, expect, it } from "vitest";
import { agentFreezeSchema, clientRefuseSchema, voiceNoteUrlSchema } from "@royal-home/shared";

/**
 * Ссылка на голосовую заметку — только наш путь к закрытому файлу (ночная
 * проверка 24.09.2026, №164). Раньше девять таких полей принимали любую строку:
 * чужая ссылка ложилась в карточку, и плеер ломался.
 */
describe("ссылка на голосовую заметку", () => {
  it("чужой адрес не принимается", () => {
    expect(voiceNoteUrlSchema.safeParse("https://evil.example/x.mp3").success).toBe(false);
    expect(voiceNoteUrlSchema.safeParse("/me/voice-notes/../../etc/passwd").success).toBe(false);
    expect(agentFreezeSchema.shape.reasonVoiceUrl.safeParse("https://evil.example/x.mp3").success).toBe(false);
  });

  it("свой путь, прежний путь и пустое значение проходят", () => {
    expect(voiceNoteUrlSchema.safeParse("/me/voice-notes/0b6f1c1e-1a2b-4c3d-9e8f-001122334455.webm").success).toBe(true);
    expect(voiceNoteUrlSchema.safeParse("/uploads/voice-notes/old-note.m4a").success).toBe(true);
    expect(voiceNoteUrlSchema.safeParse("").success).toBe(true);
  });

  it("поле отказа от клиента тоже проверяется", () => {
    const r = clientRefuseSchema.safeParse({ reason: "Клиент передумал", voiceNoteUrl: "javascript:alert(1)" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.some((i) => i.path.includes("voiceNoteUrl"))).toBe(true);
  });
});
