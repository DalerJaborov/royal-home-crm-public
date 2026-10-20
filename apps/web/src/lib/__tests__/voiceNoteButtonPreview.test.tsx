import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";

/**
 * Предпросмотр записанной голосовой заметки идёт через плеер с токеном, а не сырым
 * <audio src="/me/voice-notes/…"> (аудит Codex 04.10.2026, CHAT03). Путь из ответа
 * сервера лежит внутри API и закрыт авторизацией: голый тег уходил в корень домена
 * без заголовка Authorization и получал оболочку SPA.
 */
vi.mock("../api", () => ({ api: vi.fn() }));
vi.mock("../../components/VoiceNotePlayer", () => ({
  VoiceNotePlayer: ({ url }: { url: string }) => React.createElement("i", { "data-player": url }),
}));

import { VoiceNoteButton } from "../../components/VoiceNoteButton";

describe("VoiceNoteButton: предпросмотр записанной заметки", () => {
  it("рисует VoiceNotePlayer с путём заметки и не рисует <audio> с сырым адресом", () => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal("MediaRecorder", class {});
    const html = renderToString(
      <VoiceNoteButton uploadUrl="/me/voice-notes" value={{ url: "/me/voice-notes/a.webm", transcript: null }} onChange={() => {}} />
    );
    vi.unstubAllGlobals();
    expect(html).toContain('data-player="/me/voice-notes/a.webm"');
    expect(html).not.toContain("<audio");
  });
});
