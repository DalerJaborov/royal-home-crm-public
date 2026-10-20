import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeCallFeed } from "../callFeedMerge";

/** Аудит 04.10.2026, WEB-PAGES03: после «Показать ещё» новые звонки и обновления головы не появлялись. */
type Row = { id: string; at: string; transcript?: string | null };
const row = (id: string, at: string, transcript: string | null = null): Row => ({ id, at, transcript });

describe("лента звонков: голова и страницы глубже", () => {
  it("новый звонок из перечитанной головы появляется сверху", () => {
    const old = [row("a", "2026-10-04T10:00:00Z"), row("b", "2026-10-04T09:00:00Z")];
    const deeper = [row("c", "2026-10-03T10:00:00Z")];
    const freshHead = [row("new", "2026-10-04T11:00:00Z"), ...old];
    const merged = mergeCallFeed(old, deeper, freshHead);
    expect(merged.map((r) => r.id)).toEqual(["new", "a", "b", "c"]);
  });

  it("готовая расшифровка в голове заменяет старую строку без неё", () => {
    const stale = [row("a", "2026-10-04T10:00:00Z", null)];
    const fresh = [row("a", "2026-10-04T10:00:00Z", "текст разговора")];
    expect(mergeCallFeed(stale, [], fresh)[0].transcript).toBe("текст разговора");
  });

  it("голова после глубокой страницы побеждает при одинаковом id", () => {
    const deeperOld = [row("x", "2026-10-04T10:00:00Z", "старый")];
    const head = [row("x", "2026-10-04T10:00:00Z", "свежий")];
    expect(mergeCallFeed([], deeperOld, head)[0].transcript).toBe("свежий");
  });

  it("ничего не теряется и не дублируется", () => {
    const a = [row("a", "2026-10-04T10:00:00Z")];
    expect(mergeCallFeed(a, a, a)).toHaveLength(1);
  });
});

describe("MobileCallsAgent", () => {
  it("голова всегда под наблюдением, страницы глубже отдельным запросом", () => {
    const src = readFileSync(fileURLToPath(new URL("../../components/mobile/MobileCalls.tsx", import.meta.url)), "utf8");
    expect(src).toContain("useCallFeed(null)");
    expect(src).toContain("mergeCallFeed(");
  });
});
