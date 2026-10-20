import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INTERACTION_INVALIDATE_KEYS } from "../../hooks/useClients";
import { ME_STALE_MS } from "../../hooks/useMe";

/**
 * Ночная проверка 01.10.2026: кэш сайта устаревает не там, где его гасят.
 *   №248 — новая запись по клиенту (показ, звонок) не гасила календарь и главную;
 *   №251 — свои права сотрудник видел старыми до пяти минут;
 *   №252 — отмена передачи видео не гасила карточку объекта.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("№248: запись по клиенту гасит календарь, главную и счётчики", () => {
  const roots = INTERACTION_INVALIDATE_KEYS.map((k) => k[0]);

  it("кроме карточки и списка — ещё три семейства", () => {
    expect(roots).toEqual(expect.arrayContaining(["client", "clients", "calendar-tasks", "dashboard-summary", "counters"]));
  });

  it("всё, что гасит обратная сторона (useCalendar), гасит и добавление записи", () => {
    const calendar = read("../../hooks/useCalendar.ts");
    const fn = calendar.slice(calendar.indexOf("function invalidateTaskViews"));
    const calendarRoots = [...fn.matchAll(/queryKey: \["([a-z-]+)"\]/g)].map((m) => m[1]);
    expect(calendarRoots.length).toBeGreaterThan(0);
    for (const root of calendarRoots) expect(roots, root).toContain(root);
  });
});

describe("№251: свои права обновляются быстро", () => {
  it("кэш профиля живёт не дольше минуты", () => {
    expect(ME_STALE_MS).toBeLessThanOrEqual(60_000);
  });

  it("профиль перезапрашивается при возврате на вкладку", () => {
    const src = read("../../hooks/useMe.ts");
    const fn = src.slice(src.indexOf("export function useMyProfile"), src.indexOf("export function useUpdateMyProfile"));
    expect(fn).toContain("refetchOnWindowFocus: true");
    expect(fn).toContain("staleTime: ME_STALE_MS");
  });
});

describe("№252: отмена передачи видео гасит и карточку объекта", () => {
  it("useInvalidateHandoffQueues гасит [\"property\"]", () => {
    const src = read("../../hooks/useMarketing.ts");
    const fn = src.slice(src.indexOf("function useInvalidateHandoffQueues"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain('queryKey: ["property"]');
  });
});
