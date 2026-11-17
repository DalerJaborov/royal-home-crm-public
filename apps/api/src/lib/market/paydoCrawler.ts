/**
 * ОБХОД Paydo.tj (JSON API) — только квартиры (201) и дома/хавли (203) в Душанбе.
 * Только чтение. Колбэк `onPage` — как у somonCrawler: пишем в базу по ходу.
 */

import type { ParsedListing } from "./somonParser.js";
import { PaydoClient } from "./paydoClient.js";
import { parsePaydoAd, type PaydoRawAd, type PaydoSubcategory } from "./paydoParser.js";

export interface PaydoSection {
  subcategoryId: PaydoSubcategory;
  label: string;
}

export const PAYDO_SECTIONS: PaydoSection[] = [
  { subcategoryId: 201, label: "Paydo: продажа квартир" },
  { subcategoryId: 203, label: "Paydo: продажа домов и хавли" },
];

/** Почему обход раздела остановился раньше конца выдачи. */
export type PaydoStop =
  | "page_failed" // страница не отдалась после ретраев клиента (5xx, 400, сеть)
  | "page_limit" // упёрлись в страховочный предел страниц, выдача ещё шла
  | "empty_page" // пустая страница при hasMore (или пустой первый запрос): подозрительный ответ
  | "caught_up"; // onPage попросил остановиться (инкремент дошёл до уже известных объявлений)

/** Ответ onPage: "stop" — дальше этот раздел не читать (обход при этом НЕполный). */
export type PaydoPageVerdict = void | "stop";

export interface PaydoCrawlResult {
  section: string;
  pagesFetched: number;
  listings: ParsedListing[];
  /**
   * true — выдача раздела прочитана до конца (hasMore=false). Только тогда можно судить
   * об «исчезнувших»: оборванный посреди раздела обход оставил бы ~половину каталога
   * «не встреченной» и погасил бы её ложным «сняли».
   */
  complete: boolean;
  stopReason?: PaydoStop;
}

/** Полный ли прогон по разделам: пройдены ВСЕ разделы каталога и каждый дочитан до конца. */
export function paydoRunComplete(requestedSections: number, results: Pick<PaydoCrawlResult, "complete" | "pagesFetched">[]): boolean {
  return (
    requestedSections === PAYDO_SECTIONS.length &&
    results.length === requestedSections &&
    results.every((r) => r.complete && r.pagesFetched > 0)
  );
}

export async function crawlPaydoSection(
  client: PaydoClient,
  section: PaydoSection,
  options: {
    maxPages?: number;
    onPage?: (listings: ParsedListing[], page: number) => Promise<PaydoPageVerdict>;
  } = {}
): Promise<PaydoCrawlResult> {
  const maxPages = options.maxPages ?? 2000;
  const all: ParsedListing[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;
  const done = (complete: boolean, stopReason?: PaydoStop): PaydoCrawlResult => ({
    section: section.label,
    pagesFetched,
    listings: all,
    complete,
    ...(stopReason ? { stopReason } : {}),
  });

  for (let page = 1; page <= maxPages; page++) {
    const result = await client.search(section.subcategoryId, cursor);
    // Сбой после ретраев: собранное сохранено (onPage), но обход НЕполный.
    if (!result) return done(false, "page_failed");
    pagesFetched++;

    const listings = result.advertisements
      .map((ad) => parsePaydoAd(ad as PaydoRawAd, section.subcategoryId))
      .filter((l): l is ParsedListing => l !== null);
    all.push(...listings);
    if (listings.length > 0 && (await options.onPage?.(listings, page)) === "stop") return done(false, "caught_up");

    if (!result.hasMore || !result.cursor) {
      // Пустая первая страница живого каталога — не «раздел пуст», а сбой ответа.
      return result.advertisements.length === 0 && page === 1 ? done(false, "empty_page") : done(true);
    }
    if (result.advertisements.length === 0) return done(false, "empty_page");
    cursor = result.cursor;
  }

  // Предел страниц исчерпан, а выдача ещё шла.
  return done(false, "page_limit");
}
