import { describe, expect, it } from "vitest";
import { mediaSrc } from "../socialVideos/helpers";

/**
 * Сервер подписывает путь файла заново в каждом ответе, экран опрашивает ролик раз в 3 секунды
 * пока идёт публикация — новый адрес перезагружал плеер (владелец 12.10.2026: «ролик прыгает,
 * включается и отключается»). Для одного файла адрес обязан оставаться тем же.
 */
describe("mediaSrc — устойчивый адрес подписанного файла", () => {
  it("один и тот же файл с новой подписью даёт прежний адрес", () => {
    const first = mediaSrc("/uploads/handoff/promo-aaa.mp4?t=подпись-1");
    const second = mediaSrc("/uploads/handoff/promo-aaa.mp4?t=подпись-2");
    expect(second).toBe(first);
  });

  it("разные файлы не смешиваются, а путь без подписи не меняется", () => {
    expect(mediaSrc("/uploads/handoff/promo-bbb.mp4?t=x")).not.toBe(mediaSrc("/uploads/handoff/promo-ccc.mp4?t=x"));
    expect(mediaSrc("/uploads/covers/promo-1-cover.jpg")).toBe("/uploads/covers/promo-1-cover.jpg");
    expect(mediaSrc("uploads/covers/promo-2-cover.jpg")).toBe("/uploads/covers/promo-2-cover.jpg");
  });
});
