// Волна D загрузки через Шабнам (26.11.2026): чистые функции, без базы.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ prisma: { $disconnect: async () => {} } }));

import { formatVideoSizeMb, isVideoDocument } from "../src/lib/videoFileExtension.js";
import { bareVideoReason, bareVideoReplyText } from "../src/telegram/bareVideoReply.js";
import type { TelegramIncomingMessage } from "../src/telegram/api.js";

const msg = (extra: Partial<TelegramIncomingMessage>): TelegramIncomingMessage =>
  ({ message_id: 1, chat: { id: 5, type: "private" }, from: { id: 5 }, ...extra }) as TelegramIncomingMessage;

describe("один список видеоформатов для всех входов Шабнам", () => {
  it("файл-видео узнаётся по типу и по любому расширению из общего списка", () => {
    expect(isVideoDocument({ mime_type: "video/3gpp", file_name: "a.bin" })).toBe(true);
    for (const name of ["a.MOV", "b.mp4", "c.3gp", "d.mkv", "e.avi", "f.mts"]) expect(isVideoDocument({ file_name: name })).toBe(true);
    expect(isVideoDocument({ mime_type: "application/pdf", file_name: "plan.pdf" })).toBe(false);
    expect(isVideoDocument({ file_name: "noext" })).toBe(false);
    expect(isVideoDocument(undefined)).toBe(false);
  });
});

describe("размер ролика в сообщении сотруднику", () => {
  it("МБ по-русски: с десятой до 10 МБ, дальше целыми", () => {
    expect(formatVideoSizeMb(41.8 * 1024 * 1024)).toBe("42 МБ");
    expect(formatVideoSizeMb(4.25 * 1024 * 1024)).toBe("4,3 МБ");
    expect(formatVideoSizeMb(3000)).toBe("0,1 МБ");
    expect(formatVideoSizeMb(0)).toBeNull();
    expect(formatVideoSizeMb(undefined)).toBeNull();
  });
});

describe("видео, которое никто не взял, получает ответ вместо «👀»", () => {
  it("причина: кружок, пересланное, остальное; не видео — null", () => {
    expect(bareVideoReason(msg({ video_note: { file_id: "n" } as never }))).toBe("videoNote");
    expect(bareVideoReason(msg({ video: { file_id: "v" } as never, forward_from_message_id: 9 } as never))).toBe("forwarded");
    expect(bareVideoReason(msg({ document: { file_id: "d", file_name: "clip.3gp" } as never }))).toBe("other");
    expect(bareVideoReason(msg({ photo: [{ file_id: "p" }] as never }))).toBeNull();
    expect(bareVideoReason(msg({ document: { file_id: "d", file_name: "check.pdf" } as never }))).toBeNull();
  });
  it("текст честно говорит «не сохранён» и что делать, на «вы»/«шумо», без «—»", () => {
    for (const reason of ["videoNote", "forwarded", "other"] as const) {
      const ru = bareVideoReplyText(reason, "ru");
      expect(ru).toMatch(/не сохран/u);
      expect(ru).toContain("добавь объект");
      expect(ru).not.toMatch(/ ты |—/u);
      const tg = bareVideoReplyText(reason, "tg");
      expect(tg).toMatch(/нигоҳ (надоштам|дошта нашудааст)/u);
      expect(tg).toContain("объект илова кунед");
      expect(tg).not.toContain("—");
    }
  });
});
