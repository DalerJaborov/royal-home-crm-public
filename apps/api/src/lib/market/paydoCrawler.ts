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

export interface PaydoCrawlResult {
  section: string;
  pagesFetched: number;
  listings: ParsedListing[];
}

export async function crawlPaydoSection(
  client: PaydoClient,
  section: PaydoSection,
  options: {
    maxPages?: number;
    onPage?: (listings: ParsedListing[], page: number) => Promise<void>;
  } = {}
): Promise<PaydoCrawlResult> {
  const maxPages = options.maxPages ?? 2000;
  const all: ParsedListing[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    const result = await client.search(section.subcategoryId, cursor);
    if (!result) break; // сбой после ретраев: лучше сохранить собранное, чем падать
    pagesFetched++;

    const listings = result.advertisements
      .map((ad) => parsePaydoAd(ad as PaydoRawAd, section.subcategoryId))
      .filter((l): l is ParsedListing => l !== null);
    all.push(...listings);
    if (listings.length > 0) await options.onPage?.(listings, page);

    if (!result.hasMore || !result.cursor || result.advertisements.length === 0) break;
    cursor = result.cursor;
  }

  return { section: section.label, pagesFetched, listings: all };
}
