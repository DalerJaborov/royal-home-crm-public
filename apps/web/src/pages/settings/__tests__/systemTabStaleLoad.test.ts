import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLatestRequest } from "../../../lib/latestRequest";

/**
 * Аудит 04.10.2026, WEB-PAGES10: «Показать ещё» без защиты от старого ответа
 * смешивала строки разных фильтров журнала ошибок.
 */
describe("журнал ошибок: схема эпох load / loadMore", () => {
  it("«Показать ещё», начатая до смены фильтра, после новой загрузки отбрасывается", () => {
    const fence = createLatestRequest();
    let epoch = 0;
    const load = () => (epoch = fence.next());
    load(); // первая загрузка
    const loadMoreStartedAt = epoch; // нажали «Показать ещё»
    load(); // сняли «Показать разобранные» до ответа
    expect(fence.isLatest(loadMoreStartedAt)).toBe(false);
  });

  it("«Показать ещё» без смены фильтра применяется", () => {
    const fence = createLatestRequest();
    const id = fence.next();
    expect(fence.isLatest(id)).toBe(true);
  });
});

describe("SystemTab", () => {
  const src = readFileSync(fileURLToPath(new URL("../SystemTab.tsx", import.meta.url)), "utf8");

  it("loadMore и load проверяют, что ответ не устарел", () => {
    expect(src).toContain("fence.current.isLatest(startedAt)");
    expect(src).toContain("fence.current.isLatest(requestId)");
  });
});
