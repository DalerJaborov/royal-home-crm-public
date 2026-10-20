import { logSystemError } from "../systemError.js";

/**
 * ВЕРСИЯ GRAPH ДЛЯ РЕКЛАМЫ (Marketing API) — ОТДЕЛЬНО ОТ МЕССЕНДЖЕРОВ (04.10.2026).
 *
 * У Marketing API свой календарь жизни версий, короче, чем у Graph для переписки
 * (разбор docs/ads-launch-research-web-04-10.md): v23 истёк 09.06.2026, v24
 * истекает 06.10.2026, v25.0 вышел 18.02.2026. Общая константа messengers/meta.ts
 * GRAPH_VERSION («v23.0») обслуживает WhatsApp, Instagram и Страницу — их версии
 * живут дольше, и менять её ради рекламы нельзя: задели бы переписку. Поэтому у
 * рекламных вызовов (lib/ads/*) своя константа, и перевод на следующую версию — это
 * одна переменная окружения, а не правка кода и не выкат.
 *
 * КАК ПРОВЕРИТЬ НА ЖИВОМ КАБИНЕТЕ после выката: запрос
 * `GET /{ADS_GRAPH_VERSION}/act_<id>?fields=name` с рекламным маркером. Ответ с именем
 * кабинета — версия принята. Ответ с кодом 2635 («You are calling a deprecated version
 * of the Ads API») — версия умерла, поставить META_ADS_GRAPH_VERSION на следующую.
 * Заголовок ответа `X-Ad-Api-Version-Warning` говорит, что Meta подменила версию сама.
 */

/** Значение по умолчанию: действующая версия на 04.10.2026. */
export const DEFAULT_ADS_GRAPH_VERSION = "v25.0";

/** Формат номера версии Graph: «v25.0». Всё остальное в переменной окружения — опечатка. */
const GRAPH_VERSION_FORMAT = /^v\d+\.\d+$/;

/**
 * Версия из переменной окружения с проверкой формата. Пусто — по умолчанию без шума;
 * не по формату — по умолчанию И запись в журнал (опечатка «25.0» без «v» иначе дала бы
 * адрес `graph.facebook.com/25.0/...`, то есть тихую поломку всей рекламы).
 */
export function resolveAdsGraphVersion(raw: string | undefined = process.env.META_ADS_GRAPH_VERSION): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_ADS_GRAPH_VERSION;
  if (GRAPH_VERSION_FORMAT.test(value)) return value;
  void logSystemError(
    "ads",
    `META_ADS_GRAPH_VERSION задана неверно (ждём вид «v25.0»), берём ${DEFAULT_ADS_GRAPH_VERSION}`,
    { dedupKey: "ads-graph-version-invalid", dedupWindowMs: 24 * 60 * 60 * 1000 }
  );
  return DEFAULT_ADS_GRAPH_VERSION;
}

/** Версия Graph во ВСЕХ рекламных вызовах (lib/ads/*). Читается один раз при старте. */
export const ADS_GRAPH_VERSION = resolveAdsGraphVersion();
