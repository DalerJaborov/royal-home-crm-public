import { describe, expect, it, vi } from "vitest";
import { crawlPaydoSection, PAYDO_SECTIONS, paydoRunComplete } from "../src/lib/market/paydoCrawler.js";
import type { PaydoClient } from "../src/lib/market/paydoClient.js";

const SECTION = PAYDO_SECTIONS[0];
type Page = { advertisements: unknown[]; cursor: string | null; hasMore: boolean } | null;

/** Клиент-заглушка: страница N отдаётся функцией `page`, сеть не нужна. */
function client(page: (n: number) => Page): PaydoClient {
  let n = 0;
  return { search: vi.fn(async () => page(++n)) } as unknown as PaydoClient;
}
const more = (n: number): Page => ({ advertisements: [{}], cursor: `c${n}`, hasMore: true });

describe("обход раздела Paydo: полный или нет", () => {
  it("дочитан до hasMore=false — полный", async () => {
    const result = await crawlPaydoSection(client((n) => (n < 3 ? more(n) : { advertisements: [{}], cursor: null, hasMore: false })), SECTION);
    expect(result).toMatchObject({ complete: true, pagesFetched: 3 });
    expect(result.stopReason).toBeUndefined();
  });

  it("обрыв на странице 150 (5xx/400 после ретраев клиента) — НЕполный, собранное сохранено", async () => {
    const result = await crawlPaydoSection(client((n) => (n === 150 ? null : more(n))), SECTION);
    expect(result).toMatchObject({ complete: false, stopReason: "page_failed", pagesFetched: 149 });
  });

  it("упёрлись в предел страниц при живой выдаче — неполный", async () => {
    const result = await crawlPaydoSection(client(more), SECTION, { maxPages: 5 });
    expect(result).toMatchObject({ complete: false, stopReason: "page_limit", pagesFetched: 5 });
  });

  it("пустая страница посреди выдачи или пустой первый ответ — неполный", async () => {
    expect(await crawlPaydoSection(client((n) => (n === 2 ? { advertisements: [], cursor: "c", hasMore: true } : more(n))), SECTION)).toMatchObject({ complete: false, stopReason: "empty_page" });
    expect(await crawlPaydoSection(client(() => ({ advertisements: [], cursor: null, hasMore: false })), SECTION)).toMatchObject({ complete: false, stopReason: "empty_page" });
  });

  it("последняя страница ровно на пределе страниц — всё равно полный", async () => {
    const result = await crawlPaydoSection(client((n) => ({ advertisements: [{}], cursor: n < 3 ? "c" : null, hasMore: n < 3 })), SECTION, { maxPages: 3 });
    expect(result).toMatchObject({ complete: true, pagesFetched: 3 });
  });
});

describe("ручной обход: что считается полным прогоном", () => {
  const full = { complete: true, pagesFetched: 10 };
  it("только если пройдены ВСЕ разделы и каждый дочитан", () => {
    expect(paydoRunComplete(PAYDO_SECTIONS.length, PAYDO_SECTIONS.map(() => full))).toBe(true);
    // «разделов: 1» — дома не обойдены, гасить их нельзя
    expect(paydoRunComplete(1, [full])).toBe(false);
    // обрыв во втором разделе
    expect(paydoRunComplete(PAYDO_SECTIONS.length, [full, { complete: false, pagesFetched: 149 }])).toBe(false);
    // раздел остановили до результата (блокировка)
    expect(paydoRunComplete(PAYDO_SECTIONS.length, [full])).toBe(false);
    // 0 страниц — не «пустой каталог»
    expect(paydoRunComplete(PAYDO_SECTIONS.length, [full, { complete: true, pagesFetched: 0 }])).toBe(false);
    expect(paydoRunComplete(PAYDO_SECTIONS.length, [])).toBe(false);
  });
});
