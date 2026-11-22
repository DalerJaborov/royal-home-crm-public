import { describe, expect, it } from "vitest";
import type { PropertyDraftView } from "@royal-home/shared";
import { formatDraftShortcutHint, formatDraftTimeLeft } from "../../hooks/usePropertyDraft";

const base = "2026-11-22T09:05:00Z"; // 14:05 Dushanbe
const draft = (expiresAt: string) => ({ updatedAt: base, expiresAt }) as unknown as PropertyDraftView;
const at = (h: number, m = 0) => Date.parse(base) + (h * 60 + m) * 60_000;

describe("draft shortcut hint", () => {
  it("shows save time (Dushanbe) and time left", () => {
    expect(formatDraftShortcutHint(draft("2026-11-22T13:05:00Z"), at(0, 45))).toBe("сохранён в 14:05, удалится через 3 ч 15 мин");
  });
  it("formats minutes and whole hours", () => {
    expect(formatDraftTimeLeft("2026-11-22T13:05:00Z", at(3, 35))).toBe("удалится через 25 мин");
    expect(formatDraftTimeLeft("2026-11-22T13:05:00Z", at(0))).toBe("удалится через 4 ч");
  });
});
