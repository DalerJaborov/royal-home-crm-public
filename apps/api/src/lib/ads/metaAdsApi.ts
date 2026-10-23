import { decryptSecretSafe } from "../../crypto.js";
import { prisma } from "../../db.js";
import { fetchWithRetry } from "../../messengers/meta.js";
import { ADS_GRAPH_VERSION } from "./adsGraphVersion.js";
import type { GraphAdSet } from "./adSetSettings.js";

export { ADS_GRAPH_VERSION, DEFAULT_ADS_GRAPH_VERSION, resolveAdsGraphVersion } from "./adsGraphVersion.js";
import { describeError } from "../describeError.js";
import { logSystemError } from "../systemError.js";
import {
  applyVideoDetails,
  creativeBodyText,
  parseCreativeAssets,
  type AdCreativeAsset,
  type GraphCreative,
  type VideoDetails,
} from "./adAssets.js";

/**
 * ЧТЕНИЕ РЕКЛАМНОГО КАБИНЕТА META (Marketing API).
 *
 * Отдельный модуль от messengers/meta.ts, хотя Graph тот же: там переписка (маркеры
 * Страницы и Instagram, вебхуки, отправка сообщений), здесь только деньги и только
 * чтение. Права тоже разные — статистика требует `ads_read`, которого у маркеров
 * переписки нет.
 *
 * СЕТЬ. Ходим на graph.facebook.com НАПРЯМУЮ, без прокси. Это не упущение: с нашего
 * VPS недоступен именно graph.instagram.com (см. комментарий в messengers/meta.ts),
 * а facebook-хост работает — через него уже идут WhatsApp и Страница.
 *
 * ЧТО ИМЕННО СПРАШИВАЕМ. Две выборки, потому что Meta держит их врозь:
 *   1) /insights — деньги и показы, разрезанные ПО ДНЯМ (time_increment=1);
 *   2) /ads — из чего объявление сделано: какую публикацию продвигали. Именно
 *      второе даёт связь с объектом CRM, потому что названия у бустов бессмысленные
 *      («Новое объявление с целью Вовлечённость» — так называются 4 из 5 объявлений
 *      в живом кабинете агентства, проверено 20.08.2026).
 */

/** Больше страниц пагинации не читаем: защита от бесконечной ленты при сбое Meta. */
const MAX_PAGES = 20;
const PAGE_SIZE = 200;
const CALL_TIMEOUT_MS = 20_000;

export interface MetaAdsCredentials {
  enabled: boolean;
  token: string | null;
  /**
   * Кабинеты, которые читаем. НЕСКОЛЬКО: у агентства реклама идёт и из личного
   * кабинета владельца, и из кабинета подрядчика — расход по одной и той же
   * квартире может лежать в разных кабинетах, и складывать его надо, а не
   * выбирать один.
   *
   * Каждый приводится к виду act_1234567890 — Ads Manager показывает номер без
   * префикса, и владелец копирует его как есть.
   */
  adAccountIds: string[];
}

export async function loadMetaAdsCredentials(): Promise<MetaAdsCredentials> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { metaAdsEnabled: true, metaAdsToken: true, metaAdAccountId: true },
  });
  return {
    enabled: !!s?.metaAdsEnabled,
    token: decryptSecretSafe(s?.metaAdsToken ?? null) || process.env.META_ADS_TOKEN || null,
    adAccountIds: parseAdAccountIds(s?.metaAdAccountId ?? process.env.META_AD_ACCOUNT_ID ?? null),
  };
}

/** «751587752930155, act_999» → ["act_751587752930155", "act_999"]. Разделителем
 *  считаем и запятую, и пробел, и перевод строки: владелец вставляет номера как
 *  придётся, а ошибка здесь означает молча пустой отчёт. */
export function parseAdAccountIds(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(/[\s,;]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const digits = trimmed.replace(/\D/g, "");
    if (!digits) continue;
    seen.add(`act_${digits}`);
  }
  return Array.from(seen);
}

export function isMetaAdsConfigured(c: MetaAdsCredentials): boolean {
  return c.enabled && !!c.token && c.adAccountIds.length > 0;
}

/** Одно объявление с точки зрения «за что оно платит». */
export interface MetaAdEntity {
  id: string;
  name: string;
  campaignId: string | null;
  campaignName: string | null;
  adsetId: string | null;
  adsetName: string | null;
  /** Адрес продвигаемой публикации в Instagram, если продвигали пост. */
  postUrl: string | null;
  /** Идентификатор медиа в Instagram — второй путь к той же публикации. */
  mediaId: string | null;
  /** «<id Страницы>_<id поста>» — по первой половине видно, ЧЬЯ Страница платит. */
  storyId: string | null;
  thumbnailUrl: string | null;
  /**
   * Текст объявления, как его отдала Meta.
   *
   * Нужен не для красоты: по нему объявление привязывается к объекту, когда
   * публикации не оказалось в ленте Instagram (реклама с другого аккаунта, старый
   * пост, промо со Страницы Facebook). Название кампании для этого не годится —
   * Meta обрезает его до первой строки, и у половины объявлений там одинаковое
   * «Продаётся квартира».
   */
  caption: string | null;
  /** Когда объявление создано в кабинете. */
  createdTime: string | null;
  /** Заданные сроки показа группы объявлений; конец пуст у бессрочных. */
  startTime: string | null;
  stopTime: string | null;
  /** Что видно в Ads Manager: ACTIVE, PAUSED, ADSET_PAUSED… */
  status: string | null;
  /** Цель кампании — чего ждали: переписок, переходов, охвата. */
  objective: string | null;
  /**
   * Материалы объявления (ролики, картинки, карточки, публикация). У «гибкого»
   * объявления их несколько, и каждый может быть про свой объект. Необязательное
   * поле: мок и старые вызывающие его не передают.
   */
  assets?: AdCreativeAsset[];
  /**
   * true — объявление прочитано по ОБЛЕГЧЁННОМУ набору полей (Meta отказала на
   * asset_feed_spec и др.): материалов в нём может быть больше, чем мы видим. По такому
   * ответу связи с объектами только добавляются, ничего не удаляется, а материалы и их
   * число не перезаписываются (syncMetaAds.ts).
   */
  partial?: boolean;
}

/** Деньги и показы одного объявления за один день. */
export interface MetaAdDailyStat {
  adId: string;
  /**
   * Названия из самого insights — нужны, чтобы завести объявление, которого нет в списке
   * /ads (заархивировано или удалено, а расход у него был): без них расход потерялся бы
   * и CRM стала бы меньше кабинета. Необязательные: мок и старые вызывающие их не знают.
   */
  adName?: string;
  campaignName?: string;
  adsetName?: string;
  /** YYYY-MM-DD в часовом поясе рекламного кабинета — так их нарезает Meta. */
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  /** Начатые переписки — «Результат» в Ads Manager для целей «Вовлечённость»/«Сообщения». */
  conversations: number;
}

interface GraphErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/**
 * Истёкший или отозванный маркер (код 190) — единственная ошибка, которую нельзя
 * лечить повтором и нельзя оставить в общей куче: она означает, что отчёт по
 * рекламе тихо замер, и владельцу надо ЗАМЕНИТЬ маркер руками. Поэтому у неё
 * отдельный текст в журнале и отдельный тип здесь.
 */
export class MetaAdsTokenError extends Error {}

/**
 * Ошибка лимита запросов Meta. Коды по документации Graph API (Rate Limiting): 4 — лимит
 * приложения, 17 — лимит пользователя, 32 — лимит Страницы, 613 — собственный лимит вызовов,
 * 80000–80014 — лимиты бизнес-сценариев (80004 — рекламный кабинет). Повтор и «откат на
 * облегчённый набор» ей не лечатся: каждая лишняя попытка только удлиняет паузу, поэтому
 * вызывающий пропускает необязательное чтение до следующего прогона.
 */
export class MetaRateLimitError extends Error {}

export function isRateLimitCode(code: number | undefined): boolean {
  return code === 4 || code === 17 || code === 32 || code === 613 || (code !== undefined && code >= 80000 && code <= 80014);
}

interface GraphPage<T> {
  data?: T[];
  paging?: { next?: string };
}

/** Разбор ответа Graph: бросает типизированную ошибку, если Meta отказала (общий для GET и POST). */
function throwOnGraphError(res: Response, body: GraphErrorBody): void {
  if (res.ok && !body.error) return;
  const code = body.error?.code;
  const message = body.error?.message ?? `HTTP ${res.status}`;
  // 190 — маркер истёк/отозван, 102 — сессия недействительна. Оба лечатся только
  // новым маркером, повторять их бессмысленно.
  if (code === 190 || code === 102) throw new MetaAdsTokenError(message);
  if (isRateLimitCode(code)) throw new MetaRateLimitError(`Marketing API: ${message}`);
  throw new Error(`Marketing API: ${message}`);
}

/** Один GET к Graph с разбором ошибки Meta (она приходит с кодом 200 не всегда). */
export async function graphGet<T>(url: string, token: string | null): Promise<T> {
  // Маркер клеим только к нашим собственным адресам: ссылки «дальше» Meta отдаёт
  // уже с ним внутри, и второй access_token в строке — гарантированная 400.
  const withToken = url.includes("access_token=")
    ? url
    : `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token ?? "")}`;
  const res = await fetchWithRetry(withToken, { method: "GET" }, CALL_TIMEOUT_MS);
  const body = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
  throwOnGraphError(res, body);
  return body;
}

/**
 * Один POST к Graph (создание креатива/объявления, смена статуса). Тело — форма, маркер
 * кладём в тело, а не в адрес: адреса попадают в журналы. Сетевой повтор — только
 * безопасный (fetchWithRetry не повторяет отправку после таймаута, см. isRetrySafe),
 * поэтому дубля объявления из-за повтора не будет.
 */
export async function graphPost<T>(url: string, token: string | null, fields: Record<string, string>): Promise<T> {
  const form = new URLSearchParams({ ...fields, access_token: token ?? "" });
  const res = await fetchWithRetry(
    url,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() },
    CALL_TIMEOUT_MS
  );
  const body = (await res.json().catch(() => ({}))) as T & GraphErrorBody;
  throwOnGraphError(res, body);
  return body;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Проход по страницам Graph с общим потолком — одинаковый для обеих выборок.
 * Упёрлись в потолок страниц, а Meta ещё отдаёт «дальше», — выборка ОБРЕЗАНА: об этом
 * пишем в журнал (раз в сутки на выборку), иначе объявления за потолком молча
 * пропали бы из CRM, а расход разошёлся бы с кабинетом.
 */
export async function graphPaged<T>(
  firstUrl: string,
  token: string | null,
  maxPages = MAX_PAGES,
  label = "выборка"
): Promise<T[]> {
  const items: T[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; url && page < maxPages; page++) {
    const body: GraphPage<T> = await graphGet<GraphPage<T>>(url, token);
    items.push(...(body.data ?? []));
    url = body.paging?.next ?? null;
  }
  if (url) {
    void logSystemError(
      "ads",
      `Реклама: «${label}» оборвана на потолке ${maxPages} страниц (прочитано ${items.length}), в Meta есть ещё — часть данных не попала в CRM`,
      { dedupKey: `ads-paging-ceiling:${label}`, dedupWindowMs: DAY_MS }
    );
  }
  return items;
}

interface GraphAd {
  id: string;
  name?: string;
  campaign_id?: string;
  adset_id?: string;
  created_time?: string;
  effective_status?: string;
  campaign?: { name?: string; objective?: string };
  adset?: { name?: string; start_time?: string; end_time?: string };
  creative?: GraphCreative;
}

/**
 * Текст объявления из того, что отдала сама Meta.
 *
 * Реклама существующего поста собрана по-разному в зависимости от того, как её
 * запускали: из Ads Manager текст лежит в creative.body, из кнопки «Продвигать»
 * под постом — в object_story_spec (у ссылки, видео или фото по-своему). Ни одно
 * из полей не обязательно, поэтому перебираем все и берём первое непустое.
 */
function creativeText(r: GraphAd): string | null {
  return creativeBodyText(r.creative) ?? null;
}

/** Поля креатива, без которых объявление не разобрать вообще. */
const BASE_CREATIVE_FIELDS =
  "instagram_permalink_url,effective_instagram_media_id,effective_object_story_id,thumbnail_url," +
  "body,object_story_spec";
/**
 * Поля для разбора «гибких» объявлений (03.10.2026). Запрашиваются ОТДЕЛЬНО от
 * базовых: если Meta какое-то из них не примет для версии API, весь список
 * объявлений не должен пропасть — fetchMetaAds откатывается на базовый набор.
 */
const RICH_CREATIVE_FIELDS =
  BASE_CREATIVE_FIELDS +
  ",asset_feed_spec{videos{video_id,thumbnail_url},images{hash,url},bodies,titles,link_urls}" +
  ",source_instagram_media_id,video_id,image_url";

/** С asset_feed_spec ответ тяжёлый: на 200 строках Meta отвечает «слишком много данных». */
const RICH_PAGE_SIZE = 50;
/** 80 × 50 = 4000 объявлений — тот же объём, что был у прежней выборки (20 × 200). */
const RICH_MAX_PAGES = 80;

const AD_BASE_FIELDS =
  "id,name,campaign_id,adset_id,created_time,effective_status,campaign{name,objective},adset{name,start_time,end_time}";

/**
 * ВСЕ статусы объявлений, включая ARCHIVED и DELETED (ревью 03.10.2026, п. 8). Без
 * фильтра `effective_status` список /ads не отдаёт заархивированные и удалённые, а у
 * них был расход: CRM становилась меньше кабинета Meta, и директору каждый день шёл
 * SPEND_MISMATCH. Значения — из перечисления effective_status Marketing API (список
 * строк JSON в параметре). НЕ ПРОВЕРЕНО на живом кабинете: если Meta примет параметр
 * иначе или откажет, срабатывает откат ниже, а расход архивных всё равно подхватывается
 * из insights (syncMetaAds.ts — объявление заводится по ad_id статистики).
 */
const ALL_EFFECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "PREAPPROVED",
  "PENDING_BILLING_INFO",
  "CAMPAIGN_PAUSED",
  "ARCHIVED",
  "ADSET_PAUSED",
  "IN_PROCESS",
  "WITH_ISSUES",
];

/**
 * ЗАПАСНОЙ СПИСОК СТАТУСОВ (03.10.2026, прод): полный список выше Meta отвергла
 * «Invalid parameter», и синк откатывался на выборку БЕЗ фильтра — архивные
 * объявления пропадали из CRM, а с ними и объект рекламы, с которой пришла Бону.
 * Здесь только самые ходовые значения перечисления; DELETED, PREAPPROVED,
 * PENDING_BILLING_INFO, IN_PROCESS убраны как вероятные виновники отказа.
 */
const CORE_EFFECTIVE_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
  "CAMPAIGN_PAUSED",
  "ADSET_PAUSED",
  "PENDING_REVIEW",
  "DISAPPROVED",
  "WITH_ISSUES",
];

function adsUrl(
  adAccountId: string,
  creativeFields: string,
  limit: number,
  statusList: readonly string[] | null = ALL_EFFECTIVE_STATUSES
): string {
  const statuses = statusList ? `&effective_status=${encodeURIComponent(JSON.stringify(statusList))}` : "";
  return (
    `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adAccountId}/ads` +
    `?fields=${AD_BASE_FIELDS},creative{${creativeFields}}&limit=${limit}${statuses}`
  );
}

/** Подписи роликов меняются редко: несколько часов в памяти экономят сотни запросов в день. */
const VIDEO_CACHE_MS = 6 * 60 * 60 * 1000;
const videoCache = new Map<string, { at: number; details: VideoDetails }>();
const VIDEO_BATCH = 50;

/**
 * Описания роликов одним пакетным запросом (`?ids=a,b,c`). Отказ Meta — не повод
 * ронять синхронизацию: ролик без подписи просто не привяжется по тексту, а
 * объявление останется помеченным неполным.
 */
export async function fetchVideoDetails(
  c: MetaAdsCredentials,
  videoIds: string[]
): Promise<Map<string, VideoDetails>> {
  const out = new Map<string, VideoDetails>();
  const now = Date.now();
  const missing: string[] = [];
  for (const id of new Set(videoIds)) {
    const hit = videoCache.get(id);
    if (hit && now - hit.at < VIDEO_CACHE_MS) out.set(id, hit.details);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += VIDEO_BATCH) {
    const batch = missing.slice(i, i + VIDEO_BATCH);
    try {
      const body = await graphGet<Record<string, { description?: string; title?: string; permalink_url?: string }>>(
        `https://graph.facebook.com/${ADS_GRAPH_VERSION}/?ids=${batch.map(encodeURIComponent).join(",")}` +
          `&fields=description,permalink_url,title`,
        c.token
      );
      for (const id of batch) {
        const v = body[id];
        // Ключа может не быть (ролик удалён или нет доступа) — тогда подпись пуста.
        const text = v?.description?.trim() || v?.title?.trim() || undefined;
        const permalink = v?.permalink_url ? `https://www.facebook.com${v.permalink_url}` : undefined;
        const details: VideoDetails = { text, permalink };
        videoCache.set(id, { at: now, details });
        out.set(id, details);
      }
    } catch (err) {
      // Маркер умер — это уже не про ролики, пусть узнает вызывающий.
      if (err instanceof MetaAdsTokenError) throw err;
      void logSystemError("ads", `Описания роликов объявлений не прочитаны: ${describeError(err)}`, {
        dedupKey: "ads-video-details",
        dedupWindowMs: DAY_MS,
      });
    }
  }
  return out;
}

/** Все объявления кабинета вместе с тем, какую публикацию они продвигают. */
export async function fetchMetaAds(c: MetaAdsCredentials, adAccountId: string): Promise<MetaAdEntity[]> {
  let rows: GraphAd[];
  /** Откат на базовые поля: материалов в ответе может быть меньше, чем в объявлении. */
  let partial = false;
  try {
    rows = await graphPaged<GraphAd>(
      adsUrl(adAccountId, RICH_CREATIVE_FIELDS, RICH_PAGE_SIZE),
      c.token,
      RICH_MAX_PAGES,
      `объявления ${adAccountId}`
    );
  } catch (errAll) {
    if (errAll instanceof MetaAdsTokenError) throw errAll;
    // Отказ мог быть из-за полного списка статусов, а не из-за полей: тот же запрос
    // с основными статусами сохраняет материалы «гибких» объявлений.
    try {
      rows = await graphPaged<GraphAd>(
        adsUrl(adAccountId, RICH_CREATIVE_FIELDS, RICH_PAGE_SIZE, CORE_EFFECTIVE_STATUSES),
        c.token,
        RICH_MAX_PAGES,
        `объявления ${adAccountId} (основные статусы)`
      );
      return toAdEntities(c, rows, false);
    } catch (errCore) {
      if (errCore instanceof MetaAdsTokenError) throw errCore;
    }
    const err = errAll;
    partial = true;
    // Расширенные поля не прошли — работаем по базовым, но не молча: без них «гибкие»
    // объявления видны как одно. Сообщение БЕЗ изменчивых чисел и со стабильным ключом на
    // сутки: этот сбой повторяется каждые 15 минут, пока Meta не поправят/не поправим мы.
    void logSystemError(
      "ads",
      `Материалы объявлений ${adAccountId} не прочитаны (asset_feed_spec и др.), работаем по базовым полям, связи в этом прогоне только добавляются: ${describeError(err)}`,
      { dedupKey: `ads-creative-fallback:${adAccountId}`, dedupWindowMs: DAY_MS }
    );
    try {
      rows = await graphPaged<GraphAd>(
        adsUrl(adAccountId, BASE_CREATIVE_FIELDS, PAGE_SIZE),
        c.token,
        MAX_PAGES,
        `объявления ${adAccountId} (базовые поля)`
      );
    } catch (err2) {
      if (err2 instanceof MetaAdsTokenError) throw err2;
      // Возможно, не принят сам фильтр статусов: сперва короткий список (архив в нём
      // есть), и только потом — как до 03.10.2026, без фильтра.
      try {
        rows = await graphPaged<GraphAd>(
          adsUrl(adAccountId, BASE_CREATIVE_FIELDS, PAGE_SIZE, CORE_EFFECTIVE_STATUSES),
          c.token,
          MAX_PAGES,
          `объявления ${adAccountId} (основные статусы)`
        );
      } catch (err3) {
        if (err3 instanceof MetaAdsTokenError) throw err3;
        void logSystemError(
          "ads",
          `Список объявлений ${adAccountId} с фильтром статусов не прочитан, читаем без него (архивные объявления в список не попадут, их догрузит бот по номеру объявления): ${describeError(err3)}`,
          { dedupKey: `ads-status-filter-fallback:${adAccountId}`, dedupWindowMs: DAY_MS }
        );
        rows = await graphPaged<GraphAd>(
          adsUrl(adAccountId, BASE_CREATIVE_FIELDS, PAGE_SIZE, null),
          c.token,
          MAX_PAGES,
          `объявления ${adAccountId} (без фильтра статусов)`
        );
      }
    }
  }
  return toAdEntities(c, rows, partial);
}

/** Строки Graph → объявления CRM, с подписями роликов одним пакетным заходом. */
async function toAdEntities(c: MetaAdsCredentials, rows: GraphAd[], partial: boolean): Promise<MetaAdEntity[]> {

  // Подписи роликов — один пакетный заход на весь кабинет (и ролики карточек каруселей).
  const parsed = rows.map((r) => parseCreativeAssets(r.creative));
  const videoIds = parsed.flatMap((assets) =>
    assets.flatMap((a) => (a.kind === "video" ? [a.id] : a.videoId ? [a.videoId] : []))
  );
  const details = videoIds.length > 0 ? await fetchVideoDetails(c, videoIds) : new Map<string, VideoDetails>();

  return rows.map((r, i) => ({
    id: r.id,
    name: r.name?.trim() || "Без названия",
    campaignId: r.campaign_id ?? null,
    campaignName: r.campaign?.name ?? null,
    adsetId: r.adset_id ?? null,
    adsetName: r.adset?.name ?? null,
    postUrl: r.creative?.instagram_permalink_url ?? null,
    // effective_object_story_id имеет вид «<id страницы>_<id поста>» и к Instagram
    // отношения не имеет — как идентификатор медиа годится только первое поле.
    mediaId: r.creative?.effective_instagram_media_id ?? r.creative?.source_instagram_media_id ?? null,
    storyId: r.creative?.effective_object_story_id ?? null,
    thumbnailUrl: r.creative?.thumbnail_url ?? null,
    caption: creativeText(r) ?? null,
    createdTime: r.created_time ?? null,
    startTime: r.adset?.start_time ?? null,
    stopTime: r.adset?.end_time ?? null,
    status: r.effective_status ?? null,
    objective: r.campaign?.objective ?? null,
    assets: applyVideoDetails(parsed[i], details),
    ...(partial ? { partial: true } : {}),
  }));
}

/**
 * ОДНО ОБЪЯВЛЕНИЕ ПО НОМЕРУ (03.10.2026, «почему Ноза»). Клиент пришёл с рекламы,
 * а объявления нет в таблице Ad: список /ads его не отдал (архив при откате фильтра
 * статусов, другой кабинет, синк ещё не дошёл). Без строки Ad бот не знает объект и
 * отдаёт клиента по общей очереди. Graph отдаёт объявление и напрямую по id — тем же
 * маркером, если у него есть доступ к кабинету. null — нет доступа или объявления.
 */
export async function fetchMetaAdById(
  c: MetaAdsCredentials,
  adId: string
): Promise<{ entity: MetaAdEntity; adAccountId: string | null } | null> {
  if (!/^\d{5,30}$/.test(adId)) return null;
  const url = (creativeFields: string) =>
    `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adId}?fields=account_id,${AD_BASE_FIELDS},creative{${creativeFields}}`;
  let row: GraphAd & { account_id?: string };
  let partial = false;
  try {
    row = await graphGet<GraphAd & { account_id?: string }>(url(RICH_CREATIVE_FIELDS), c.token);
  } catch (err) {
    if (err instanceof MetaAdsTokenError) throw err;
    partial = true;
    row = await graphGet<GraphAd & { account_id?: string }>(url(BASE_CREATIVE_FIELDS), c.token);
  }
  if (!row?.id) return null;
  const [entity] = await toAdEntities(c, [row], partial);
  return { entity, adAccountId: row.account_id ? `act_${row.account_id.replace(/^act_/, "")}` : null };
}

/**
 * НАСТРОЙКИ ГРУПП ОБЪЯВЛЕНИЙ (04.10.2026, слой обучения «Студии запуска рекламы»).
 *
 * ОТДЕЛЬНЫЙ запрос `/{act}/adsets`, а не вложенное `adset{...}` в /ads: групп в кабинете
 * в разы меньше, чем объявлений (в живом кабинете 1:1, но у «гибких» — одна группа на
 * много объявлений), а вложение таргетинга утяжелило бы КАЖДУЮ строку списка /ads, где
 * и так тяжёлый креатив с asset_feed_spec и потолок «слишком много данных» на 200 строках.
 * Одна выборка на кабинет, склейка по adset_id в syncMetaAds.
 *
 * Поля сверены с Marketing API reference/ad-campaign 04.10.2026. `targeting` просим
 * ЦЕЛИКОМ, а не вложенным выбором `targeting{geo_locations,…}`: что Graph принимает выбор
 * подполей у этого составного поля, документация не подтверждает, а целиком оно отдаётся
 * точно; лишнее отсекает adSetSettings.ts при разборе.
 */
const ADSET_BASE_FIELDS =
  "id,name,daily_budget,lifetime_budget,bid_strategy,billing_event,optimization_goal,destination_type,start_time,end_time";
const ADSET_RICH_FIELDS = `${ADSET_BASE_FIELDS},budget_remaining,promoted_object,targeting`;
/** Таргетинг тяжёлый (списки аудиторий): страницы меньше, чем у базового набора. */
const ADSET_RICH_PAGE_SIZE = 50;
const ADSET_RICH_MAX_PAGES = 80;
/** Статусы группы из перечисления effective_status AdSet — как и у объявлений, включая архив. */
const ACTIVE_ADSET_STATUSES = ["ACTIVE", "IN_PROCESS", "WITH_ISSUES"];
/** Остановленные, в архиве и удалённые: их настройки не меняются сами, читать их каждые 15 минут незачем. */
const INACTIVE_ADSET_STATUSES = ["PAUSED", "CAMPAIGN_PAUSED", "ARCHIVED", "DELETED"];
const ALL_ADSET_STATUSES = [...ACTIVE_ADSET_STATUSES, ...INACTIVE_ADSET_STATUSES];

/** Какие группы читаем: действующие (каждая синхронизация), остальные (раз в сутки) или все. */
export type AdSetScope = "all" | "active" | "inactive";

function adSetsUrl(adAccountId: string, fields: string, limit: number, statusList: readonly string[] | null): string {
  const statuses = statusList ? `&effective_status=${encodeURIComponent(JSON.stringify(statusList))}` : "";
  return `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adAccountId}/adsets?fields=${fields}&limit=${limit}${statuses}`;
}

export interface MetaAdSetsResult {
  /** Группы кабинета по внешнему id. Пусто — не прочитались (синхронизация идёт дальше). */
  byId: Map<string, GraphAdSet>;
  /** true — прочитано по облегчённому набору: таргетинга и promoted_object в ответе нет. */
  partial: boolean;
  /** Почему чтение пропущено: лимит запросов Meta или полный отказ. Нет — прочитано (возможно, пусто). */
  skipped?: "rate_limit" | "failed";
}

/**
 * Группы объявлений кабинета. НЕ БРОСАЕТ на отказе полей: откат «богатый набор → базовый
 * набор → без фильтра статусов», каждый шаг — запись в журнал со стабильным ключом на сутки
 * (как у креатива в fetchMetaAds). Когда не прочиталось совсем — пустой результат: слой
 * обучения не стоит расходов и объявлений. Бросает только MetaAdsTokenError — умерший маркер.
 *
 * ЛИМИТ ЗАПРОСОВ Meta (MetaRateLimitError) откатом НЕ лечится: два «облегчённых» повтора только
 * усилили бы торможение. Чтение пропускается до следующего прогона (`skipped: "rate_limit"`),
 * в журнале одна запись на сутки.
 */
export async function fetchMetaAdSets(
  c: MetaAdsCredentials,
  adAccountId: string,
  options: { scope?: AdSetScope } = {}
): Promise<MetaAdSetsResult> {
  const scope = options.scope ?? "all";
  const statusList =
    scope === "active" ? ACTIVE_ADSET_STATUSES : scope === "inactive" ? INACTIVE_ADSET_STATUSES : ALL_ADSET_STATUSES;
  const allAttempts: { url: string; partial: boolean; note: string }[] = [
    { url: adSetsUrl(adAccountId, ADSET_RICH_FIELDS, ADSET_RICH_PAGE_SIZE, statusList), partial: false, note: "" },
    {
      url: adSetsUrl(adAccountId, ADSET_BASE_FIELDS, PAGE_SIZE, statusList),
      partial: true,
      note: "таргетинг и promoted_object не прочитаны, берём базовые поля группы",
    },
    {
      url: adSetsUrl(adAccountId, ADSET_BASE_FIELDS, PAGE_SIZE, null),
      partial: true,
      note: "фильтр статусов не принят, читаем без него (архивные группы не попадут)",
    },
  ];
  // Третий путь («без фильтра статусов») читает ВСЕ группы — для выборки по статусам он свёл бы
  // на нет её смысл, поэтому только для scope "all".
  const attempts = scope === "all" ? allAttempts : allAttempts.slice(0, 2);
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    try {
      const rows = await graphPaged<GraphAdSet>(
        attempt.url,
        c.token,
        attempt.partial ? MAX_PAGES : ADSET_RICH_MAX_PAGES,
        `группы объявлений ${adAccountId}`
      );
      const byId = new Map<string, GraphAdSet>();
      for (const row of rows) if (row?.id) byId.set(row.id, row);
      return { byId, partial: attempt.partial };
    } catch (err) {
      if (err instanceof MetaAdsTokenError) throw err;
      if (err instanceof MetaRateLimitError) {
        void logSystemError(
          "ads",
          `Настройки групп объявлений ${adAccountId}: Meta ограничила частоту запросов, чтение пропущено до следующего прогона: ${describeError(err)}`,
          { dedupKey: `ads-adset-ratelimit:${adAccountId}`, dedupWindowMs: DAY_MS }
        );
        return { byId: new Map(), partial: true, skipped: "rate_limit" };
      }
      lastErr = err;
      const next = attempts[i + 1];
      if (next) {
        void logSystemError(
          "ads",
          `Настройки групп объявлений ${adAccountId}: ${next.note}: ${describeError(err)}`,
          { dedupKey: `ads-adset-fallback:${adAccountId}:${i}`, dedupWindowMs: DAY_MS }
        );
      }
    }
  }
  void logSystemError("ads", `Настройки групп объявлений ${adAccountId} не прочитаны: ${describeError(lastErr)}`, {
    dedupKey: `ads-adset-failed:${adAccountId}`,
    dedupWindowMs: DAY_MS,
  });
  return { byId: new Map(), partial: true, skipped: "failed" };
}

export interface GraphInsight {
  ad_id?: string;
  ad_name?: string;
  campaign_name?: string;
  adset_name?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  actions?: { action_type?: string; value?: string }[];
}

/** «Начатые переписки» среди действий Meta. Две метрики про одно и то же: первая —
 *  все начатые диалоги, вторая — окно в 7 дней. Берём первую, она и стоит колонкой
 *  «Результат» в кабинете; вторая — запасная, для старых кампаний. */
export function conversationsOf(actions: GraphInsight["actions"]): number {
  const wanted = [
    "onsite_conversion.total_messaging_connection",
    "onsite_conversion.messaging_conversation_started_7d",
  ];
  for (const type of wanted) {
    const hit = actions?.find((a) => a.action_type === type);
    if (hit) return Number(hit.value ?? 0) || 0;
  }
  return 0;
}

/** Расходы по дням за период [since, until] включительно (даты в YYYY-MM-DD). */
export async function fetchMetaAdDailyStats(
  c: MetaAdsCredentials,
  adAccountId: string,
  since: string,
  until: string
): Promise<MetaAdDailyStat[]> {
  const fields = "ad_id,ad_name,campaign_name,adset_name,spend,impressions,reach,clicks,actions";
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const url =
    `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adAccountId}/insights` +
    `?level=ad&time_increment=1&time_range=${timeRange}&fields=${fields}&limit=${PAGE_SIZE}`;
  const rows = await graphPaged<GraphInsight>(url, c.token, MAX_PAGES, `расход по дням ${adAccountId}`);
  return rows
    .filter((r): r is GraphInsight & { ad_id: string; date_start: string } => !!r.ad_id && !!r.date_start)
    .map((r) => ({
      adId: r.ad_id,
      adName: r.ad_name?.trim() || undefined,
      campaignName: r.campaign_name?.trim() || undefined,
      adsetName: r.adset_name?.trim() || undefined,
      date: r.date_start,
      spend: Number(r.spend ?? 0) || 0,
      impressions: Number(r.impressions ?? 0) || 0,
      reach: Number(r.reach ?? 0) || 0,
      clicks: Number(r.clicks ?? 0) || 0,
      conversations: conversationsOf(r.actions),
    }));
}

/**
 * Итог расхода кабинета за период по самой Meta (`level=account`, без разбивки по
 * объявлениям) — контрольная цифра для сверки: если сумма по объявлениям в CRM
 * разошлась с ней, значит часть расхода потерялась по дороге (удалённые из
 * кабинета объявления, недозалитые дни). Сумма — в валюте кабинета.
 */
export async function fetchAccountSpendTotal(
  c: MetaAdsCredentials,
  adAccountId: string,
  since: string,
  until: string
): Promise<number> {
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const body = await graphGet<{ data?: { spend?: string }[] }>(
    `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adAccountId}/insights?level=account&time_range=${timeRange}&fields=spend`,
    c.token
  );
  return (body.data ?? []).reduce((acc, r) => acc + (Number(r.spend ?? 0) || 0), 0);
}

/** Валюта кабинета — в ней Meta отдаёт spend. Отказ чтения (не токен) возвращает `null`, а не
 *  «доллар» (аудит 04.10.2026, ADS-ROOT02): подставленный USD переписывал уже сохранённые
 *  сомони как доллары. Что делать с `null`, решает вызывающий: синхронизация берёт последнюю
 *  сохранённую валюту кабинета, сверка помечает итог Meta как не полученный. */
export async function fetchAdAccountCurrency(
  c: MetaAdsCredentials,
  adAccountId: string
): Promise<"USD" | "TJS" | null> {
  try {
    const body = await graphGet<{ currency?: string }>(
      `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adAccountId}?fields=currency`,
      c.token
    );
    return body.currency === "TJS" ? "TJS" : "USD";
  } catch (err) {
    if (err instanceof MetaAdsTokenError) throw err;
    void logSystemError("ads", `Валюта кабинета ${adAccountId} не прочитана, берём сохранённую: ${describeError(err)}`, {
      dedupKey: `ads-currency:${adAccountId}`,
      dedupWindowMs: DAY_MS,
    });
    return null;
  }
}

/**
 * Валюта кабинета для «Студии запуска»: в отличие от fetchAdAccountCurrency отказ чтения —
 * это `null`, а не «доллар». Синхронизации расходов доллар по умолчанию простителен (кабинет
 * агентства в долларах), а сухому запросу — нет: он считает бюджет в центах, и кабинет в
 * сомони, принятый за долларовый, дал бы бюджет, неверный в разы. Не бросает ничего.
 */
export async function fetchAdAccountCurrencyStrict(
  c: MetaAdsCredentials,
  adAccountId: string
): Promise<string | null> {
  try {
    const body = await graphGet<{ currency?: string }>(
      `https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adAccountId}?fields=currency`,
      c.token
    );
    return typeof body.currency === "string" && body.currency.length > 0 ? body.currency : null;
  } catch {
    return null;
  }
}

export interface AdAccountDetails {
  id: string;
  name: string | null;
  currency: string;
  /** Чем платят: «Visa •• 4242», «PayPal», «Кредитная линия Meta». */
  fundingSource: string | null;
  /** Незакрытый долг кабинета в валюте кабинета — Meta отдаёт в центах. */
  balance: number | null;
  /** Порог, после которого Meta списывает; полезен, чтобы понимать ритм списаний. */
  spendCap: number | null;
  timezone: string | null;
  /**
   * Потрачено «относительно spend_cap» (а без лимита — всего за жизнь кабинета), в валюте
   * кабинета; Meta отдаёт в сотых, как и balance. Нужен, чтобы увидеть «лимит достигнут».
   * Поля ниже необязательные (волна 1 рекламы, 03.10.2026): прежние читатели и подделки в
   * тестах их не знают.
   */
  amountSpent?: number | null;
  /** account_status Meta: 1 активен, 2 отключён, 3 не оплачен, 7 проверка рисков, 8 расчёт, 9 льготный период, 100/101 закрытие. */
  accountStatus?: number | null;
  /** disable_reason Meta (0 — причины нет). Имеет смысл, только когда accountStatus = 2. */
  disableReason?: number | null;
}

/**
 * КТО И ЧЕМ ПЛАТИТ за рекламу (просьба владельца 21.08.2026: «списания с какой
 * карты»). Директору это важнее половины метрик: деньги уходят с конкретной
 * карты, и он должен видеть, с какой именно, не заходя в кабинет Meta.
 */
export async function fetchAdAccountDetails(c: MetaAdsCredentials, adAccountId: string): Promise<AdAccountDetails | null> {
  try {
    // amount_spent, account_status, disable_reason — поля AdAccount из Marketing API (сверено
    // с reference/ad-account 03.10.2026); нужны сторожу «долг / деньги кончились» (adAlerts.ts).
    const fields =
      "name,currency,balance,spend_cap,amount_spent,account_status,disable_reason,timezone_name,funding_source_details";
    const body = await graphGet<{
      id?: string;
      name?: string;
      currency?: string;
      balance?: string;
      spend_cap?: string;
      amount_spent?: string;
      account_status?: number;
      disable_reason?: number;
      timezone_name?: string;
      funding_source_details?: { display_string?: string; type?: number };
    }>(`https://graph.facebook.com/${ADS_GRAPH_VERSION}/${adAccountId}?fields=${fields}`, c.token);

    return {
      id: adAccountId,
      name: body.name ?? null,
      currency: body.currency ?? "USD",
      fundingSource: body.funding_source_details?.display_string ?? null,
      // Суммы кабинета Meta отдаёт в сотых долях валюты.
      balance: body.balance != null ? Number(body.balance) / 100 : null,
      spendCap: body.spend_cap != null && Number(body.spend_cap) > 0 ? Number(body.spend_cap) / 100 : null,
      timezone: body.timezone_name ?? null,
      amountSpent: body.amount_spent != null && Number.isFinite(Number(body.amount_spent)) ? Number(body.amount_spent) / 100 : null,
      accountStatus: typeof body.account_status === "number" ? body.account_status : null,
      disableReason: typeof body.disable_reason === "number" ? body.disable_reason : null,
    };
  } catch {
    // Кабинет мог не отдать платёжные детали (нет прав) — это не повод ронять экран.
    return null;
  }
}
