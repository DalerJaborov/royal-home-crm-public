import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Срок паузы считается В МОМЕНТ «собрать и отправить», а не при старте загрузки (ревью PR #463): ролик грузится
 * дольше срока «10 минут» — сервер иначе ответил бы «Срок паузы уже прошёл», и загруженный файл потерялся бы.
 */
const captured = vi.hoisted(() => ({ options: null as null | { completeBody: (sessionId: string) => Record<string, unknown> } }));
vi.mock("../chunkedUpload", () => ({
  uploadToPurpose: vi.fn(async (_purpose: string, _file: File, options: { completeBody: (s: string) => Record<string, unknown> }) => {
    captured.options = options;
    return { ok: true };
  }),
}));

const { uploadConversationMedia } = await import("../mediaUpload");

afterEach(() => vi.useRealTimers());

describe("срок паузы у файла при долгой загрузке", () => {
  it("пока файл грузился 15 минут, срок «10 минут» считается заново — от момента сборки", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00Z"));
    await uploadConversationMedia("c1", new File(["x"], "a.mp4", { type: "video/mp4" }), undefined, () => {}, "k", "l1", undefined, 10);
    vi.setSystemTime(new Date("2026-11-26T10:15:00Z")); // загрузка закончилась, зовётся сборка
    const body = captured.options!.completeBody("00000000-0000-4000-8000-000000000001");
    expect(Date.parse(body.pausedUntil as string)).toBe(Date.parse("2026-11-26T10:25:00Z"));
    // «Повторить» ещё через час — снова от своего момента.
    vi.setSystemTime(new Date("2026-11-26T11:15:00Z"));
    expect(Date.parse(captured.options!.completeBody("s").pausedUntil as string)).toBe(Date.parse("2026-11-26T11:25:00Z"));
  });

  it("без выбранного срока поля нет (умолчание сервера)", async () => {
    await uploadConversationMedia("c1", new File(["x"], "a.mp4", { type: "video/mp4" }), "подпись", () => {}, "k", "l2");
    expect(captured.options!.completeBody("s")).toEqual({ sessionId: "s", caption: "подпись" });
  });
});
