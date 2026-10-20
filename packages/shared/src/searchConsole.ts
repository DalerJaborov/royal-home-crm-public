import { z } from "zod";

/**
 * «САЙТ И ПОИСК» (24.09.2026, Dan: «seo сайта, что лучше позиция в поиске и так
 * далее, полный контроль — в другую вкладку»). Данные Google Search Console о
 * royalhome.tj: что люди ищут, по каким запросам видят сайт, на каком месте он
 * стоит и какие страницы находят. Общий договор сервера (lib/searchConsole.ts)
 * и экрана «Маркетинг → Сайт и поиск».
 */

/** Период — 7, 28 или 90 дней: те же, что предлагает сам Search Console. */
export const SEARCH_PERIODS = [7, 28, 90] as const;
export const searchOverviewQuerySchema = z.object({
  days: z.coerce.number().pipe(z.union([z.literal(7), z.literal(28), z.literal(90)])).default(28),
  refresh: z.literal("1").optional(),
});

export interface SearchMetrics {
  clicks: number;
  impressions: number;
  /** Доля кликов от показов, 0..1. */
  ctr: number;
  /** Среднее место в выдаче (1 — первое). null — показов не было. */
  position: number | null;
}

export interface SearchQueryRow extends SearchMetrics {
  query: string;
}

export interface SearchPageRow extends SearchMetrics {
  /** Полный адрес страницы, как его отдаёт Google. */
  page: string;
  /** Путь без домена — короче для экрана. */
  path: string;
  /** Страница объекта (/listing/…), если объект нашёлся в CRM. */
  property: { shortId: number; title: string } | null;
}

export type SearchOverview =
  | {
      connected: false;
      /** Google-приложение (Client ID и Client secret, те же, что у YouTube) внесено в Настройках. */
      appConfigured: boolean;
    }
  | {
      connected: true;
      siteUrl: string;
      days: number;
      /** Даты периода, ГГГГ-ММ-ДД. Google отдаёт данные с задержкой в 2–3 дня. */
      start: string;
      end: string;
      totals: SearchMetrics;
      /** Тот же отрезок до периода — для «больше/меньше, чем было». */
      previous: SearchMetrics;
      queries: SearchQueryRow[];
      pages: SearchPageRow[];
      /** Запросы, где сайт стоит на 4–20 месте и его часто видят: подтянуть их в тройку — самые дешёвые клики. */
      nearTop: SearchQueryRow[];
      /** Не удалось прочитать — честная причина вместо пустых таблиц. */
      error: string | null;
    };

/**
 * ЯНДЕКС ВЕБМАСТЕР (24.09.2026) — вторая половина «Сайт и поиск». Своё
 * OAuth-приложение Яндекса: ID и пароль вносят прямо на вкладке.
 */
export const yandexAppSchema = z.object({
  clientId: z.string().trim().min(8, "ID приложения — из oauth.yandex.ru").max(100),
  clientSecret: z.string().trim().min(8, "Пароль приложения — из oauth.yandex.ru").max(100),
});
export type YandexAppInput = z.infer<typeof yandexAppSchema>;

/** Сводка Вебмастера о сайте. */
export interface YandexSiteSummary {
  /** ИКС — индекс качества сайта у Яндекса. */
  sqi: number | null;
  /** Страниц в поиске. */
  searchablePages: number | null;
  /** Страниц, исключённых из поиска. */
  excludedPages: number | null;
  /** Проблем сайта, которые видит Вебмастер (все уровни важности вместе). */
  problems: number;
}

export type YandexSearchOverview =
  | {
      connected: false;
      /** ID и пароль приложения Яндекса внесены. */
      appConfigured: boolean;
    }
  | {
      connected: true;
      /** Адрес сайта, как его знает Вебмастер. */
      hostUrl: string;
      days: number;
      start: string;
      end: string;
      totals: SearchMetrics;
      previous: SearchMetrics;
      queries: SearchQueryRow[];
      nearTop: SearchQueryRow[];
      summary: YandexSiteSummary | null;
      error: string | null;
    };
