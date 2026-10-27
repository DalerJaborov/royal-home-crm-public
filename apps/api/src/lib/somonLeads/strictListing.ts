import { z } from "zod";
import { extractNextPayload } from "./listingParser.js";

const itemSchema = z.object({ id: z.number().int().positive().safe(), title: z.string().nullable().optional(), url: z.string().nullable().optional(), published: z.string().nullable().optional(), ad_type: z.object({ type: z.string().optional() }).nullable().optional() }).passthrough();
export class SomonEmptyListing extends Error {}

/** Parse the whole listing array. A malformed element rejects the page rather
 * than silently losing IDs from the baseline. */
export function parseSomonListingPage(html: string, page: number) {
  const payload = extractNextPayload(html);
  const metaStart = payload.indexOf('"next_page":');
  const marker = payload.indexOf('"adverts":[', metaStart);
  if (metaStart < 0 || marker < 0) throw new Error("Somon listing structure unavailable");
  const meta = payload.slice(metaStart, marker);
  if (!meta.includes('"slug":"prodazha-kvartir"') || !meta.includes('"location_ids":[1]')) throw new Error("Unexpected Somon listing scope");
  const start = payload.indexOf("[", marker);
  let depth = 0, inString = false, escaped = false, end = -1;
  for (let i = start; i < payload.length && i - start < 4 * 1024 * 1024; i++) {
    const c = payload[i];
    if (inString) { if (escaped) escaped = false; else if (c === "\\") escaped = true; else if (c === '"') inString = false; }
    else if (c === '"') inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error("Incomplete Somon listing");
  let data: unknown;
  try { data = JSON.parse(payload.slice(start, end)); } catch { throw new Error("Invalid Somon listing JSON"); }
  const parsed = z.array(itemSchema).max(100).safeParse(data);
  if (!parsed.success) throw new Error("Invalid Somon listing item");
  const ads = parsed.data;
  if (!ads.length) throw new SomonEmptyListing("Somon listing is empty");
  if (new Set(ads.map(a => a.id)).size !== ads.length) throw new Error("Inconsistent Somon listing IDs");
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map(m => Number(m[1]));
  if (!pages.length) throw new Error("Somon pagination is unavailable");
  const last = Math.max(...pages);
  if (!Number.isSafeInteger(last) || last < 1 || last > 10000) throw new Error("Invalid Somon pagination");
  if (page < last) {
    const size = /page_size=(\d+)/.exec(meta);
    if (!size || Number(size[1]) !== ads.length) throw new Error("Incomplete Somon listing page");
  }
  return { ads, last };
}
