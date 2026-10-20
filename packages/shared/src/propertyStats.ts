/**
 * ВКЛАДКА «СТАТИСТИКА» В КАРТОЧКЕ ОБЪЕКТА (24.09.2026, Dan: «в любой карточке
 * объекта видеть всю статистику — минималистично, подробно, ярко, чтобы агент
 * или директор могли видеть»). Договор между `GET /properties/:id/stats` и
 * экраном: одна форма ответа на обе стороны.
 */

/**
 * СРАВНЕНИЕ С «СОСЕДЯМИ» ВЫКЛЮЧЕНО (29.09.2026, решение владельца): считается
 * только по нашим объектам в базе — выборка в единицы штук, а не рынок. Вернуть,
 * когда подключим Somon.tj и другие площадки: поставить `true` — сервер снова
 * считает соседей и светофор, карточка снова показывает блок «Соседи».
 */
export const NEIGHBORS_COMPARISON_ENABLED = false;

/** Цвет светофора. `gray` — судить рано (объект новый или ещё не на продаже). */
export type PropertyHealthColor = "green" | "yellow" | "red" | "gray";

export interface PropertyHealth {
  color: PropertyHealthColor;
  /** Одна фраза крупно: что с объектом. */
  headline: string;
  /** Что сделать — от самого важного, не больше трёх. */
  tips: string[];
}

export type PropertyFunnelStepKey = "seen" | "site" | "contact" | "showing" | "deal";

export interface PropertyFunnelStep {
  key: PropertyFunnelStepKey;
  label: string;
  /** null — площадка не отдаёт число (не «ноль», а «не знаем»). */
  count: number | null;
  /** Пояснение мелко: из чего сложено число. */
  hint: string;
}

export interface PropertySiteDay {
  /** «2026-09-24», день по Душанбе. */
  day: string;
  views: number;
}

export interface PropertyNeighbors {
  /** Цена за м² этого объекта, сомони. null — нет цены или площади. */
  pricePerSqm: number | null;
  /** Медиана цены за м² похожих в продаже (тот же район и тип), сомони. */
  medianPerSqm: number | null;
  /** На сколько процентов дороже (+) или дешевле (−) соседей. */
  diffPct: number | null;
  /** Сколько похожих сравнили. */
  sample: number;
  /** С чем сравнили, словами: «2-комнатные квартиры, Сино». */
  scope: string;
  /** Сколько дней похожие обычно продаются (медиана за год). null — мало продаж. */
  typicalDaysToSell: number | null;
  /** Сколько дней этот объект в продаже. */
  daysOnSale: number;
  /** Объект сейчас в продаже — иначе «дней в продаже» не показываем. */
  onSale: boolean;
}

export interface PropertyPlatformStat {
  channel: "INSTAGRAM" | "FACEBOOK" | "YOUTUBE" | "TIKTOK" | "TELEGRAM" | "SITE";
  views: number | null;
  likes: number | null;
  comments: number | null;
  url: string | null;
  /** Почему числа нет, словами. */
  note: string | null;
}

export interface PropertyHotSignal {
  hot: boolean;
  /** Просмотры сайта за последние 2 дня. */
  recentViews: number;
  /** Во сколько раз больше обычного (среднее за 2 недели до них). */
  ratio: number | null;
  /** День, с которого «загорелся». */
  since: string | null;
}

export interface PropertyStatsResponse {
  health: PropertyHealth;
  funnel: PropertyFunnelStep[];
  neighbors: PropertyNeighbors;
  /** Просмотры страницы объекта на сайте по дням, последние 30 дней. */
  siteDays: PropertySiteDay[];
  siteTotals: { views: number; visitors: number; whatsapp: number; phone: number; share: number; favorite: number };
  /** Связь с сайтом настроена и хоть раз собрана. */
  siteConnected: boolean;
  hot: PropertyHotSignal;
  generatedAt: string;
}

/**
 * Площадки — отдельным запросом (`GET /properties/:id/stats/platforms`): их
 * числа идут из Instagram, Facebook, YouTube, TikTok по сети и могут ехать
 * секунды, а светофор, путь покупателя и соседи считаются по своей базе
 * мгновенно. Экран не ждёт чужие площадки, чтобы показать главное.
 */
export interface PropertyPlatformsResponse {
  platforms: PropertyPlatformStat[];
  /** Сумма просмотров роликов по площадкам, которые отдают число; null — ни одна не отдала. */
  seen: number | null;
}

/** Сколько дней рисует график и откуда считается «последние N». */
export const PROPERTY_STATS_DAYS = 30;

/**
 * Светофор списком (24.09.2026): цветная точка у каждого объекта в каталоге и
 * «Объекты, которым нужна помощь» в «Обзоре» маркетинга. Те же правила, что
 * у вкладки «Статистика», посчитанные пачкой.
 */
export interface PropertyHealthBrief {
  color: PropertyHealthColor;
  headline: string;
  /** Первая подсказка — что сделать; null — делать нечего. */
  tip: string | null;
}

/** `GET /properties/health?ids=…` — по id объекта. */
export type PropertiesHealthResponse = Record<string, PropertyHealthBrief>;

/** Сколько id принимает `GET /properties/health` за раз — страница каталога. */
export const PROPERTIES_HEALTH_MAX_IDS = 100;

export interface PropertyNeedsHelpItem extends PropertyHealthBrief {
  id: string;
  shortId: number;
  title: string;
  daysOnSale: number;
}

/** `GET /properties/needs-help` — красные первыми, не больше 10. */
export interface PropertiesNeedsHelpResponse {
  items: PropertyNeedsHelpItem[];
  /** Сколько всего объектов в продаже проверили. */
  checked: number;
  red: number;
  yellow: number;
}
