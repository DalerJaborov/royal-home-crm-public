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
 *
 * СВОЯ РУБРИКА — ИЛИ НИЧЕГО (12.11.2026). Страница сначала проверяется целиком: её собственная
 * рубрика (метаданные списка) обязана совпасть с рубрикой раздела, иначе сайт отдал не тот список
 * (так адрес домов 11.11 оказался общей лентой «Все объявления» на 9 326 страниц) — стоп
 * `wrong_scope` с записью в журнал. Затем каждое объявление: пишется только рубрика из белого
 * списка раздела (`rubricIds`), тип сделки и объекта — из рубрики (`somonRubrics.ts`). Страница,
 * где нет ни одного объявления своей рубрики, — конец раздела.
 */

import { SomonSourceUnavailable, fetchSomon } from "../somonLeads/sourceClient.js";
import { isSomonSourceStopped } from "../somonLeads/sourceBudgetStore.js";
import { logSystemError } from "../systemError.js";
import { saveListings, type SaveStats } from "./marketStore.js";
import type { ParsedListing } from "./somonParser.js";
import { extractAds, extractNextPayload, toListing } from "./somonParser.js";
import { SOMON_APARTMENT_SALE_RUBRIC_IDS, SOMON_SOURCE, somonRubricId } from "./somonRubrics.js";

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
  /** Рубрика самой страницы списка (`"rubric":{"id":…}` в метаданных): другая — сайт отдал не тот список. */
  pageRubricId: number;
  /** Белый список рубрик объявлений раздела: остальное на странице не пишется. */
  rubricIds: readonly number[];
}

/**
 * Разделы, которые собираем (и которые разрешает дверь `fetchSomon`). Номера рубрик сверены по живым
 * страницам 12.11.2026: квартиры — список 216, объявления 2829–2839; дома — 218 и там, и там.
 * Прежний адрес домов `/nedvizhimost/prodazha-domov/dushanbe/` отдаёт общую ленту — не возвращать.
 */
export const SECTIONS: CrawlSection[] = [
  { path: "/nedvizhimost/prodazha-kvartir/dushanbe/", label: "Продажа квартир", pageRubricId: 216, rubricIds: SOMON_APARTMENT_SALE_RUBRIC_IDS },
  { path: "/nedvizhimost/prodazha-domov-havli-i-dach/dushanbe/", label: "Продажа домов", pageRubricId: 218, rubricIds: [218] },
];

/** Раздел квартир — его страницы скачивает и минутный парсер лидов. */
export const APARTMENTS_SECTION = SECTIONS[0];

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Почему обход остановился раньше конца раздела. */
export type CrawlStop =
  | "forbidden" // 403: сайт закрыл доступ, источник остановлен до решения человека
  | "rate_limited" // 429: просьба сбавить темп, обход прекращён
  | "source_stopped" // общий бюджет остановлен (403/5 сбоев подряд)
  | "wait_timeout" // слот бюджета не освободился за разумное время (уступаем лидам или пауза после сбоя)
  | "unavailable" // сеть/5xx после повторной попытки, 404 посреди раздела (если рынок не сжался)
  | "layout_changed" // в странице нет данных объявлений: вёрстка сайта поменялась
  | "wrong_scope" // сайт отдал список чужой рубрики (общую ленту и т.п.): ничего не пишем
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
  /** Сколько объявлений чужих рубрик пропущено (не записано). */
  foreignSkipped: number;
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

/** Рубрика самой страницы списка из её метаданных (`"next_page":…,"rubric":{"id":216,…}`); нет — null. */
export function somonPageRubricId(payload: string): number | null {
  const start = payload.indexOf('"next_page":');
  if (start < 0) return null;
  const advertsAt = payload.indexOf('"adverts":[', start);
  const meta = payload.slice(start, advertsAt > start ? advertsAt : start + 8000);
  const m = /"rubric":\{"id":(\d+)/.exec(meta);
  return m ? Number(m[1]) : null;
}

export interface SomonPage {
  /** Страница — список рубрики раздела (не общая лента, не чужой раздел). */
  inScope: boolean;
  /** Сколько объявлений вообще было на странице. */
  adsTotal: number;
  /** Объявления рубрик раздела — только они пишутся. */
  listings: ParsedListing[];
}

/** HTML страницы списка → объявления раздела. Чужая рубрика страницы — `inScope: false` и пусто. */
export function parseSomonPage(html: string, section: CrawlSection = APARTMENTS_SECTION): SomonPage {
  const payload = extractNextPayload(html);
  const ads = extractAds(payload);
  if (somonPageRubricId(payload) !== section.pageRubricId) return { inScope: false, adsTotal: ads.length, listings: [] };
  const allowed = new Set(section.rubricIds);
  const listings = ads
    .filter((ad) => {
      const id = somonRubricId(ad);
      return id != null && allowed.has(id);
    })
    .map(toListing)
    .filter((l): l is ParsedListing => l !== null);
  return { inScope: true, adsTotal: ads.length, listings };
}

/**
 * Записывает уже скачанную страницу в рыночный каталог (без второго запроса).
 * Зовёт минутный парсер лидов: html уже получен им через ту же дверь (раздел квартир).
 * Действует то же правило рубрик, что у обхода: чужая страница или чужое объявление не пишутся.
 */
export async function saveSomonPageHtml(html: string, section: CrawlSection = APARTMENTS_SECTION): Promise<SaveStats> {
  return saveListings(SOMON_SOURCE, parseSomonPage(html, section).listings);
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
  const result: CrawlResult = { section: section.label, pagesFetched: 0, listingCount: 0, complete: false, foreignSkipped: 0 };

  const stop = async (reason: CrawlStop, page: number, status?: number): Promise<CrawlResult> => {
    result.stopReason = reason;
    // Только код причины и номер страницы: ни тел ответов, ни адресов. Предел страниц, заданный
    // вызывающим (инкремент читает 2–3 первые), — не сбой, а задуманный конец: молчим.
    const requestedLimit = reason === "page_limit" && options.maxPages != null;
    if (reason !== "deadline" && !requestedLimit) {
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
    const parsed = parseSomonPage(html, section);
    // Сайт отдал не список раздела (общую ленту, чужой раздел): ни одной строки не пишем.
    if (!parsed.inScope) return stop("wrong_scope", page);
    if (parsed.adsTotal === 0) {
      // Пустая страница до известного конца — не «конец выдачи», а подозрительный разбор.
      if (page < lastPage || page === 1) return stop("layout_changed", page);
      break;
    }
    const { listings } = parsed;
    result.foreignSkipped += parsed.adsTotal - listings.length;
    if (listings.length === 0) {
      // Объявления есть, но ни одного своей рубрики: раздел кончился (дальше сайт подмешивает
      // чужое). На первой странице так не бывает — значит, это не тот список.
      if (page === 1) return stop("wrong_scope", page);
      console.info(`[market-somon] «${section.label}»: на стр. ${page} нет объявлений своей рубрики — конец раздела`);
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
