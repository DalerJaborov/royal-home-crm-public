import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";

/**
 * Официальный курс USD→TJS с alif.tj (раздел "Дар хазина" — касса, колонка "Фурӯш") —
 * используется для конвертации цен объектов, указанных в долларах, при публикации
 * на сайт (сайт всегда показывает только сомони, см. lib/siteSync.ts). Курс также
 * можно всегда поправить вручную в Настройках — эта функция лишь предлагает
 * автообновление раз в сутки (см. cron.ts), не единственный источник истины.
 *
 * Раньше парсили HTML страницы /ru — alif.tj перевели её на Next.js, курсы там
 * теперь подгружаются клиентским JS и в исходном HTML не появляются вовсе (обычный
 * fetch/curl их не видит). У них есть отдельный JSON-эндпоинт с теми же данными —
 * используем его напрямую, это ещё и надёжнее регулярки по вёрстке.
 *
 * У alif.tj несколько вкладок с разным курсом на одни и те же доллары —
 * "Интиқолҳо" (переводы, `moneyTransferTradeValue`), "Ғайринақдӣ" (`nonCashSellValue`),
 * "Бо кортҳо"/"БМТ" (visa/wallet) и "Дар хазина" (касса, `sellValue`/`buyValue`).
 * "Дар хазина" у них всегда самый высокий курс — решение владельца (17.09.2026):
 * брать именно его, чтобы курс в CRM совпадал с тем, что реально в кассе.
 */
const ALIF_RATES_API_URL = "https://alif.tj/api/rates";

interface AlifLocalRate {
  name: string;
  /** "Фурӯш" в разделе "Дар хазина" (касса) — самый высокий курс из вкладок alif.tj,
   * им и торгует касса, поэтому берём именно его (не moneyTransferTradeValue/
   * nonCashSellValue/visaSellValue — те ниже и относятся к другим вкладкам). */
  sellValue: string;
}

// Разумные границы курса — защита от того, чтобы сломанный парсинг (сайт сменил
// формат ответа, вернул не то значение и т.п.) тихо утащил цены объектов в абсурд.
// Диапазон широкий специально, чтобы не требовать ручной правки границ при обычных
// колебаниях курса, но отсекал явный мусор (например, случайно пойманное число
// из курса EUR/RUB вместо USD).
const MIN_PLAUSIBLE_RATE = 5;
const MAX_PLAUSIBLE_RATE = 15;

/** Возвращает курс "Продажа" 1 USD в TJS или null, если сайт недоступен, изменил
 * формат ответа, или вернул значение вне разумных границ. Никогда не бросает исключение. */
export async function fetchAlifUsdSellRate(): Promise<number | null> {
  // Каждый выход с null — в журнал. Это единственный внешний вызов CRM, чей отказ
  // никуда не писался: logSystemError был импортирован и НИ РАЗУ не вызван, поэтому
  // «Здоровье системы» показывало зелёное, пока курс месяцами не обновлялся, а
  // долларовые объекты уходили на сайт по устаревшей цене. Соседний lib/notifySite.ts
  // прямо утверждает, что «все прочие необязательные вызовы наружу (…, курс, …) уже
  // пишут отказ сюда же» — теперь это правда. Дедупликация внутри logSystemError
  // (10 минут) не даёт ночному крону залить журнал одинаковыми строками.
  try {
    const res = await fetch(ALIF_RATES_API_URL, {
      signal: AbortSignal.timeout(10_000),
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RoyalHomeCRM-ExchangeRateBot/1.0)" },
    });
    if (!res.ok) {
      void logSystemError("exchange-rate", `alif.tj ответил ${res.status} ${res.statusText}`, {
        url: ALIF_RATES_API_URL,
      });
      return null;
    }
    const body = (await res.json()) as { localRates?: AlifLocalRate[] };
    const usd = body.localRates?.find((r) => r.name === "USD");
    if (!usd) {
      void logSystemError("exchange-rate", "В ответе alif.tj нет курса USD — вероятно, изменился формат", {
        url: ALIF_RATES_API_URL,
      });
      return null;
    }

    const sellRate = Number(usd.sellValue);
    if (!Number.isFinite(sellRate) || sellRate < MIN_PLAUSIBLE_RATE || sellRate > MAX_PLAUSIBLE_RATE) {
      void logSystemError(
        "exchange-rate",
        `Курс с alif.tj вне разумных границ (${MIN_PLAUSIBLE_RATE}–${MAX_PLAUSIBLE_RATE}): «${usd.sellValue}»`,
        { url: ALIF_RATES_API_URL }
      );
      return null;
    }
    return sellRate;
  } catch (err) {
    void logSystemError(
      "exchange-rate",
      `Курс USD→TJS не получен с alif.tj: ${err instanceof Error ? err.message : String(err)}`,
      { url: ALIF_RATES_API_URL }
    );
    return null;
  }
}

export type RefreshRateResult = { ok: true; rate: number } | { ok: false; error: string };

/** Обёртка над fetchAlifUsdSellRate, которая сразу сохраняет результат в Настройки —
 * общая для ночного cron (cron.ts) и кнопки "Обновить курс сейчас" (settings.ts). */
export async function refreshUsdToTjsRateFromAlif(): Promise<RefreshRateResult> {
  const rate = await fetchAlifUsdSellRate();
  if (rate == null) {
    return {
      ok: false,
      error: "Не удалось получить курс с alif.tj (сайт недоступен или изменил структуру страницы) — задайте курс вручную",
    };
  }
  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { usdToTjsRate: rate, usdToTjsRateUpdatedAt: new Date(), usdToTjsRateSource: "alif-auto" },
    create: { id: "singleton", usdToTjsRate: rate, usdToTjsRateUpdatedAt: new Date(), usdToTjsRateSource: "alif-auto" },
  });
  return { ok: true, rate };
}
