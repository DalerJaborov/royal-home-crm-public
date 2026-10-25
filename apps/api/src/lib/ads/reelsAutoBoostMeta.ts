import type { ReelsAutoBoostCtaType } from "@royal-home/shared";
import {
  ADS_GRAPH_VERSION,
  conversationsOf,
  graphGet,
  graphPaged,
  graphPost,
  type GraphInsight,
  type MetaAdsCredentials,
} from "./metaAdsApi.js";

/**
 * ВЫЗОВЫ META ДЛЯ АВТОПРОДВИЖЕНИЯ РОЛИКОВ (запись в рекламный кабинет).
 *
 * Отдельный от metaAdsApi.ts файл: тот — чтение, этот — деньги и запись. Нужен
 * маркер с правом ads_management (у маркера «только чтение статистики» любой POST
 * вернёт отказ по правам — исполнитель положит его в журнал ошибок, ничего не сломав).
 * Каждый вызов идёт через graphGet/graphPost с таймаутом 20 с; ошибки не глотаем —
 * их ловит и записывает вызывающий.
 *
 * ОПИРАЕМСЯ НА ДОКУМЕНТАЦИЮ (сверено 23.10.2026 через поиск по документации Meta):
 *  - продвижение готовой публикации Instagram: креатив с object_id (Страница),
 *    instagram_user_id и source_instagram_media_id —
 *    https://developers.facebook.com/documentation/ads-commerce/instagram/ads-api/guides/use-posts-as-ads
 *  - объявление: POST /act_<кабинет>/ads с adset_id, creative {creative_id}, status —
 *    https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/partnership-ads/ads-creation/boost-existing-post
 *  - кнопки «написать»: MESSAGE_PAGE + app_destination (INSTAGRAM_DIRECT / MESSENGER) —
 *    страница use-posts-as-ads выше; WHATSAPP_MESSAGE —
 *    https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp
 *  - id аккаунта Instagram кабинета: GET /act_<кабинет>/connected_instagram_accounts (там же);
 *  - проверка пригодности публикации: поле boost_eligibility_info у медиа Instagram —
 *    https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/
 *  - результат: insights, действие onsite_conversion.total_messaging_connection
 *    (запасное — messaging_conversation_started_7d), то же, что читает синхронизация
 *    расходов (metaAdsApi.ts::conversationsOf) —
 *    https://developers.facebook.com/documentation/ads-commerce/graph-api/reference/adgroup/insights
 *
 * НЕ ПРОВЕРЕНО НА ЖИВОМ КАБИНЕТЕ (кабинет не оплачен, маркера записи нет): точный вид
 * value у WHATSAPP_MESSAGE и имена подполей boost_eligibility_info. Оба места написаны
 * так, чтобы отказ Meta был громким (журнал ошибок), а не молчаливым.
 */

const GRAPH = `https://graph.facebook.com/${ADS_GRAPH_VERSION}`;

export interface AdSetInfo {
  /** Кабинет в виде act_123…, которому принадлежит группа объявлений. */
  accountId: string;
  effectiveStatus: string | null;
}

/** Группа объявлений: кабинет, которому она принадлежит, и статус. Бросает при отказе Meta. */
export async function fetchAdSetInfo(c: MetaAdsCredentials, adSetId: string): Promise<AdSetInfo> {
  const body = await graphGet<{ account_id?: string; effective_status?: string }>(
    `${GRAPH}/${adSetId}?fields=account_id,effective_status`,
    c.token
  );
  const digits = (body.account_id ?? "").replace(/\D/g, "");
  if (!digits) throw new Error(`Meta не вернула кабинет группы объявлений ${adSetId}`);
  return { accountId: `act_${digits}`, effectiveStatus: body.effective_status ?? null };
}

/** Валюта кабинета. Стоп-лосс сравнивает расход с порогом «в долларах», поэтому не-USD — отказ. */
export async function fetchAccountCurrency(c: MetaAdsCredentials, accountId: string): Promise<string | null> {
  const body = await graphGet<{ currency?: string }>(`${GRAPH}/${accountId}?fields=currency`, c.token);
  return body.currency ?? null;
}

/** Аккаунт Instagram, подключённый к кабинету. Первый из списка; null — подключённых нет. */
export async function fetchConnectedInstagramUserId(c: MetaAdsCredentials, accountId: string): Promise<string | null> {
  const body = await graphGet<{ data?: Array<{ id?: string }> }>(
    `${GRAPH}/${accountId}/connected_instagram_accounts?fields=id,username`,
    c.token
  );
  return body.data?.find((a) => !!a.id)?.id ?? null;
}

export interface BoostEligibility {
  /** null — Meta не сказала (поле недоступно этому маркеру): решает попытка создания. */
  eligible: boolean | null;
  reason: string | null;
}

/**
 * Пригодна ли публикация для продвижения (музыка с лицензией, фильтры, «поделились
 * в Facebook» и т.п. делают её непригодной). Любой сбой чтения — «не знаем»: создание
 * креатива вернёт настоящую причину отказа, терять ролик из-за недоступного поля нельзя.
 */
export async function fetchBoostEligibility(c: MetaAdsCredentials, mediaId: string): Promise<BoostEligibility> {
  try {
    const body = await graphGet<{ boost_eligibility_info?: Record<string, unknown> }>(
      `${GRAPH}/${mediaId}?fields=boost_eligibility_info`,
      c.token
    );
    const info = body.boost_eligibility_info;
    if (!info || typeof info !== "object") return { eligible: null, reason: null };
    const flag = info.eligible_to_boost;
    const reasonRaw = info.boost_ineligible_reason ?? info.ineligible_reason ?? null;
    return {
      eligible: typeof flag === "boolean" ? flag : null,
      reason: typeof reasonRaw === "string" ? reasonRaw : reasonRaw ? JSON.stringify(reasonRaw) : null,
    };
  } catch {
    return { eligible: null, reason: null };
  }
}

/** Кнопка объявления → call_to_action Meta. */
export function ctaFor(type: ReelsAutoBoostCtaType): { type: string; value: { app_destination: string } } {
  switch (type) {
    case "WHATSAPP_MESSAGE":
      return { type: "WHATSAPP_MESSAGE", value: { app_destination: "WHATSAPP" } };
    case "INSTAGRAM_DIRECT":
      return { type: "MESSAGE_PAGE", value: { app_destination: "INSTAGRAM_DIRECT" } };
    case "MESSENGER":
      return { type: "MESSAGE_PAGE", value: { app_destination: "MESSENGER" } };
  }
}

/** Креатив «продвинуть готовую публикацию Instagram». Возвращает id креатива. */
export async function createBoostCreative(
  c: MetaAdsCredentials,
  p: { accountId: string; pageId: string; instagramUserId: string; mediaId: string; cta: ReelsAutoBoostCtaType; name: string }
): Promise<string> {
  const body = await graphPost<{ id?: string }>(`${GRAPH}/${p.accountId}/adcreatives`, c.token, {
    name: p.name,
    object_id: p.pageId,
    instagram_user_id: p.instagramUserId,
    source_instagram_media_id: p.mediaId,
    call_to_action: JSON.stringify(ctaFor(p.cta)),
  });
  if (!body.id) throw new Error("Meta не вернула id креатива");
  return body.id;
}

/** Объявление в группе объявлений постоянной кампании. Возвращает id объявления. */
export async function createBoostAd(
  c: MetaAdsCredentials,
  p: { accountId: string; adSetId: string; creativeId: string; name: string; status: "ACTIVE" | "PAUSED" }
): Promise<string> {
  const body = await graphPost<{ id?: string }>(`${GRAPH}/${p.accountId}/ads`, c.token, {
    name: p.name,
    adset_id: p.adSetId,
    creative: JSON.stringify({ creative_id: p.creativeId }),
    status: p.status,
  });
  if (!body.id) throw new Error("Meta не вернула id объявления");
  return body.id;
}

/**
 * Не создали ли мы объявление для этой публикации раньше, но не успели записать его id
 * (обрыв между ответом Meta и записью в базу). Имя объявления содержит media id —
 * ищем по нему в группе. Только для повторных попыток.
 */
export async function findAdByMediaId(c: MetaAdsCredentials, adSetId: string, mediaId: string): Promise<string | null> {
  const filtering = encodeURIComponent(JSON.stringify([{ field: "name", operator: "CONTAIN", value: mediaId }]));
  const body = await graphGet<{ data?: Array<{ id?: string }> }>(
    `${GRAPH}/${adSetId}/ads?fields=id&limit=5&filtering=${filtering}`,
    c.token
  );
  return body.data?.find((a) => !!a.id)?.id ?? null;
}

/** Включить или поставить на паузу объявление. */
export async function setAdStatus(c: MetaAdsCredentials, adId: string, status: "ACTIVE" | "PAUSED"): Promise<void> {
  await graphPost<{ success?: boolean }>(`${GRAPH}/${adId}`, c.token, { status });
}

export interface AdStat {
  spend: number;
  conversations: number;
}

/**
 * Расход и начатые переписки по всем объявлениям группы за всё время (одним запросом).
 * Объявления без показов в ответ не попадают — вызывающий считает их нулём.
 */
export async function fetchAdSetAdStats(c: MetaAdsCredentials, adSetId: string): Promise<Map<string, AdStat>> {
  const rows = await graphPaged<GraphInsight>(
    `${GRAPH}/${adSetId}/insights?level=ad&date_preset=maximum&fields=ad_id,spend,actions&limit=200`,
    c.token,
    5,
    `автопродвижение роликов ${adSetId}`
  );
  const out = new Map<string, AdStat>();
  for (const r of rows) {
    if (!r.ad_id) continue;
    out.set(r.ad_id, { spend: Number(r.spend ?? 0) || 0, conversations: conversationsOf(r.actions) });
  }
  return out;
}
