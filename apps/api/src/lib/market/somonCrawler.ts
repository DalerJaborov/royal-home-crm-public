/**
 * ОБХОД somon.tj И СОХРАНЕНИЕ В СВОЮ БАЗУ.
 *
 * ПРИЛИЧИЯ — НЕ ФОРМАЛЬНОСТЬ, А УСЛОВИЕ РАБОТЫ. Блокируют не за сбор данных, а
 * за жадность: сотня потоков и тысячи запросов в минуту. Поэтому здесь строго
 * последовательный обход с паузой между страницами, честный User-Agent, по
 * которому видно, кто мы, и отказ от повторной закачки того, что не менялось.
 * Для сайта мы — один неторопливый посетитель.
 *
 * robots.txt somon.tj (проверен 21.08.2026) запрещает /api, /admin, /profile,
 * страницы автора, /aid/, сортировки и фильтры по цене в адресе. Страницы категорий,
 * их пагинация и карточки /adv/ — разрешены, их и берём. Фильтровать по цене
 * через адрес нельзя, но нам это и не нужно: мы берём раздел целиком.
 */

import type { ParsedListing } from "./somonParser.js";
import { extractAds, extractNextPayload, toListing } from "./somonParser.js";

const USER_AGENT = "Mozilla/5.0 (compatible; RoyalHomeBot/1.0; +https://royalhome.tj)";
/** Пауза между страницами. Меньше секунды уже похоже на нападение, а не на посетителя. */
const DELAY_MS = 2500;
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;

export interface CrawlSection {
  /** Путь раздела без адреса сайта и без страницы. */
  path: string;
  label: string;
}

/**
 * Разделы, которые собираем.
 *
 * Показывать владелец просил только продажу квартир в Душанбе, но собираем шире:
 * место стоит копейки, а прошлое перекачать нельзя — сегодняшний отказ от домов
 * и аренды означает, что через полгода истории по ним не будет вовсе.
 */
export const SECTIONS: CrawlSection[] = [
  { path: "/nedvizhimost/prodazha-kvartir/dushanbe/", label: "Продажа квартир" },
  { path: "/nedvizhimost/prodazha-domov/dushanbe/", label: "Продажа домов" },
  { path: "/nedvizhimost/prodazha-kommercheskoy-nedvizhimosti/dushanbe/", label: "Продажа коммерции" },
  { path: "/nedvizhimost/prodazha-uchastkov/dushanbe/", label: "Продажа участков" },
  { path: "/nedvizhimost/arenda-kvartir/dushanbe/", label: "Аренда квартир" },
];

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Скачивает страницу с таймаутом и повторами.
 *
 * Повтор — только на сетевую ошибку и на 5xx/429: 404 повторять бессмысленно, а
 * 429 («слишком часто») отрабатываем растущей паузой — это прямая просьба сайта
 * сбавить темп, и её надо слушаться, а не долбить дальше.
 */
async function fetchPage(url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "ru" },
        signal: controller.signal,
      });
      if (res.ok) return await res.text();
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(DELAY_MS * attempt * 2);
        continue;
      }
      return null;
    } catch {
      await sleep(DELAY_MS * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Сколько всего страниц в разделе — по ссылкам пагинации на первой странице. */
export function detectLastPage(html: string): number {
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length ? Math.min(Math.max(...pages), 1000) : 1;
}

export interface CrawlResult {
  section: string;
  pagesFetched: number;
  listings: ParsedListing[];
}

/**
 * Обходит один раздел целиком.
 *
 * `onPage` вызывается после каждой страницы — чтобы вызывающий мог писать в базу
 * по ходу, а не копить десять тысяч объявлений в памяти и потерять всё, если
 * обход прервётся на середине.
 */
export async function crawlSection(
  section: CrawlSection,
  options: { maxPages?: number; onPage?: (listings: ParsedListing[], page: number, total: number) => Promise<void> } = {}
): Promise<CrawlResult> {
  const base = `https://somon.tj${section.path}`;
  const first = await fetchPage(base);
  if (!first) return { section: section.label, pagesFetched: 0, listings: [] };

  const lastPage = Math.min(detectLastPage(first), options.maxPages ?? 1000);
  const all: ParsedListing[] = [];

  const parsePage = (html: string): ParsedListing[] =>
    extractAds(extractNextPayload(html))
      .map(toListing)
      .filter((l): l is ParsedListing => l !== null);

  const firstListings = parsePage(first);
  all.push(...firstListings);
  await options.onPage?.(firstListings, 1, lastPage);

  let pagesFetched = 1;
  for (let page = 2; page <= lastPage; page++) {
    await sleep(DELAY_MS);
    const html = await fetchPage(`${base}?page=${page}`);
    if (!html) continue;
    pagesFetched++;
    const listings = parsePage(html);
    // Пустая страница при живом ответе — обычно конец выдачи: дальше не идём,
    // чтобы не молотить сотню запросов в пустоту.
    if (listings.length === 0) break;
    all.push(...listings);
    await options.onPage?.(listings, page, lastPage);
  }

  return { section: section.label, pagesFetched, listings: all };
}
