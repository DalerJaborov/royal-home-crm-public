/**
 * ОБХОД somon.tj И СОХРАНЕНИЕ В СВОЮ БАЗУ.
 *
 * ПРИЛИЧИЯ — НЕ ФОРМАЛЬНОСТЬ, А УСЛОВИЕ РАБОТЫ. Блокируют не за сбор данных, а
 * за жадность. Поэтому ВСЕ запросы к Somon идут через одну дверь — `fetchSomon`
 * (lib/somonLeads/sourceClient): общий с минутным парсером лидов бюджет в базе,
 * один темп на сайт (10 с), 403 — полная остановка, 429/5xx — пауза с нарастанием.
 * Своего `fetch` здесь нет: два независимых клиента на один сайт — это и есть
 * риск бана. Обход к тому же уступает парсеру лидов (см. `background` в
 * sourceBudgetStore): не вклинивается в его паузы (25 с тишины после запроса лидов) и не
 * стартует во время его стартовой разметки и скана.
 *
 * robots.txt somon.tj (проверен 21.08.2026) запрещает /api, /admin, /profile,
 * страницы автора, /aid/, сортировки и фильтры по цене в адресе. Страницы категорий,
 * их пагинация и карточки /adv/ — разрешены, их и берём.
 *
 * Разделы: только продажа квартир и домов в Душанбе — это ровно то, что пропускает
 * дверь `fetchSomon`. Аренду/коммерцию/участки собирать нельзя без осознанного
 * расширения двери (и согласия владельца).
 */

import { SomonSourceUnavailable, fetchSomon } from "../somonLeads/sourceClient.js";
import { isSomonSourceStopped } from "../somonLeads/sourceBudgetStore.js";
import { logSystemError } from "../systemError.js";
import { saveListings, type SaveStats } from "./marketStore.js";
import type { ParsedListing } from "./somonParser.js";
import { extractAds, extractNextPayload, toListing } from "./somonParser.js";

/** Сколько ждём свободный слот бюджета на ОДНУ страницу, прежде чем сдаться. */
const MAX_WAIT_PER_PAGE_MS = 5 * 60_000;
const WAIT_STEP_MS = 5_000;
/** Сбой сети/5xx — одна повторная попытка (пауза между ними задана общим бюджетом: ≥ 60 с). */
const MAX_ATTEMPTS = 2;
/** Страховка от бесконечного обхода при сломанной пагинации. */
const MAX_PAGES = 400;

export interface CrawlSection {
  /** Путь раздела без адреса сайта и без страницы. */
  path: string;
  label: string;
}

/** Разделы, которые собираем (и которые разрешает дверь `fetchSomon`). */
export const SECTIONS: CrawlSection[] = [
  { path: "/nedvizhimost/prodazha-kvartir/dushanbe/", label: "Продажа квартир" },
  { path: "/nedvizhimost/prodazha-domov/dushanbe/", label: "Продажа домов" },
];

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Почему обход остановился раньше конца раздела. */
export type CrawlStop =
  | "forbidden" // 403: сайт закрыл доступ, источник остановлен до решения человека
  | "rate_limited" // 429: просьба сбавить темп, обход прекращён
  | "source_stopped" // общий бюджет остановлен (403/5 сбоев подряд)
  | "wait_timeout" // слот бюджета не освободился за разумное время (уступаем лидам или пауза после сбоя)
  | "unavailable" // сеть/5xx после повторной попытки, 404 посреди раздела (если рынок не сжался)
  | "layout_changed" // в странице нет данных объявлений: вёрстка сайта поменялась
  | "page_limit" // дошли до страховочного предела страниц
  | "save_failed" // не записалось в нашу базу
  | "deadline"; // вышло время, отведённое на прогон

export interface CrawlResult {
  section: string;
  pagesFetched: number;
  /** Сколько объявлений разобрано (сами объявления не копим: они уже записаны через onPage). */
  listingCount: number;
  /** true — дошли до последней страницы раздела. Только тогда можно судить об «исчезнувших». */
  complete: boolean;
  stopReason?: CrawlStop;
}

type PageOutcome = { ok: true; html: string } | { ok: false; stop: CrawlStop; status?: number };

/**
 * Скачивает страницу через общую дверь. Никаких штормов: 403/429 — стоп сразу;
 * «слот не готов» — ждём с лимитом (и сразу сдаёмся, если источник остановлен);
 * сеть/5xx — одна повторная попытка.
 */
async function fetchPage(path: string, pause: (ms: number) => Promise<void>): Promise<PageOutcome> {
  let attempts = 0;
  let waited = 0;
  for (;;) {
    try {
      const response = await fetchSomon(path, new Date(), fetch, { background: true });
      return { ok: true, html: await response.text() };
    } catch (error) {
      if (!(error instanceof SomonSourceUnavailable)) return { ok: false, stop: "unavailable" };
      if (error.reason === "not_ready") {
        if (await isSomonSourceStopped()) return { ok: false, stop: "source_stopped" };
        if (waited >= MAX_WAIT_PER_PAGE_MS) return { ok: false, stop: "wait_timeout" };
        await pause(WAIT_STEP_MS);
        waited += WAIT_STEP_MS;
        continue;
      }
      if (error.status === 403) return { ok: false, stop: "forbidden", status: 403 };
      if (error.status === 429) return { ok: false, stop: "rate_limited", status: 429 };
      attempts++;
      if (error.status === 404 || attempts >= MAX_ATTEMPTS) return { ok: false, stop: "unavailable", status: error.status };
      // Повтор после сбоя: общий бюджет сам не отдаст слот раньше паузы (≥ 60 с),
      // так что цикл «не готов → ждём» не превращается в шторм.
    }
  }
}

/** Сколько всего страниц в разделе — по ссылкам пагинации на странице. */
export function detectLastPage(html: string): number {
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length ? Math.min(Math.max(...pages), 1000) : 1;
}

/**
 * Страница `page` ответила 404. Перекачиваем `page - 1` (она точно существовала): если
 * теперь она сама не ссылается на `page`, раздел сжался и `page - 1` — последняя.
 * Любой сбой при проверке — не подтверждение (обход остаётся неполным).
 */
async function confirmShrunk(section: CrawlSection, page: number, pause: (ms: number) => Promise<void>): Promise<boolean> {
  const previous = page - 1;
  const outcome = await fetchPage(previous === 1 ? section.path : `${section.path}?page=${previous}`, pause);
  if (!outcome.ok || !outcome.html.includes("self.__next_f.push")) return false;
  return detectLastPage(outcome.html) < page;
}

/** HTML страницы списка → объявления. Пусто, если данных нет. */
export function parseSomonPage(html: string): ParsedListing[] {
  return extractAds(extractNextPayload(html))
    .map(toListing)
    .filter((l): l is ParsedListing => l !== null);
}

/**
 * Записывает уже скачанную страницу в рыночный каталог (без второго запроса).
 * Зовёт минутный парсер лидов: html уже получен им через ту же дверь.
 */
export async function saveSomonPageHtml(html: string): Promise<SaveStats> {
  return saveListings("somon.tj", parseSomonPage(html));
}

export interface CrawlOptions {
  maxPages?: number;
  onPage?: (listings: ParsedListing[], page: number, total: number) => Promise<void>;
  /** Вернуть true — пора остановиться (время прогона вышло, замок потерян). */
  shouldStop?: () => boolean;
  /** Для тестов: подмена ожидания. */
  pause?: (ms: number) => Promise<void>;
}

/**
 * Обходит один раздел целиком. Не бросает: итог — в `complete` и `stopReason`.
 *
 * `onPage` вызывается после каждой страницы — чтобы писать в базу по ходу, а не
 * копить десять тысяч объявлений в памяти и потерять всё при обрыве.
 *
 * Конец раздела — когда страница сама не ссылается на страницы дальше неё (или
 * все известные страницы пройдены). Предел страниц из первой страницы не берём
 * на веру: пагинация может показывать окно, поэтому `lastPage` растёт по ходу.
 */
export async function crawlSection(section: CrawlSection, options: CrawlOptions = {}): Promise<CrawlResult> {
  const pause = options.pause ?? wait;
  const limit = Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES);
  const result: CrawlResult = { section: section.label, pagesFetched: 0, listingCount: 0, complete: false };

  const stop = async (reason: CrawlStop, page: number, status?: number): Promise<CrawlResult> => {
    result.stopReason = reason;
    // Только код причины и номер страницы: ни тел ответов, ни адресов.
    if (reason !== "deadline") {
      await logSystemError("api", `Сбор Somon прерван: «${section.label}», стр. ${page}, причина ${reason}${status ? ` (HTTP ${status})` : ""}`, {
        dedupKey: `market-somon-crawl-${section.path}-${reason}`,
      });
    }
    return result;
  };

  let lastPage = 1;
  for (let page = 1; page <= lastPage; page++) {
    if (options.shouldStop?.()) return stop("deadline", page);
    if (page > limit) return stop("page_limit", page);
    const outcome = await fetchPage(page === 1 ? section.path : `${section.path}?page=${page}`, pause);
    if (!outcome.ok) {
      // 404 на странице, на которую ссылалась прошлая: рынок мог сжаться за время обхода
      // (по образцу finishShrunkBaseline у парсера лидов). Это конец раздела, а не сбой —
      // но только если свежая предыдущая страница уже не ссылается на эту.
      if (outcome.status === 404 && page > 1 && (await confirmShrunk(section, page, pause))) break;
      return stop(outcome.stop, page, outcome.status);
    }

    const { html } = outcome;
    result.pagesFetched++;
    lastPage = Math.max(lastPage, detectLastPage(html));
    if (!html.includes("self.__next_f.push")) return stop("layout_changed", page);
    const listings = parseSomonPage(html);
    if (listings.length === 0) {
      // Пустая страница до известного конца — не «конец выдачи», а подозрительный разбор.
      if (page < lastPage || page === 1) return stop("layout_changed", page);
      break;
    }
    result.listingCount += listings.length;
    try {
      await options.onPage?.(listings, page, lastPage);
    } catch {
      return stop("save_failed", page);
    }
  }
  result.complete = true;
  return result;
}
