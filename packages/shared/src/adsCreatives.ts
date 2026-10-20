/**
 * КАКИЕ КРЕАТИВЫ РАБОТАЮТ (03.10.2026, GET /ads/creatives).
 *
 * Рейтинг платных объявлений по цене клиента (и по цене обращения Meta, когда клиентов
 * в CRM ещё мало). Одно объявление — одна строка: деньги объявления на несколько
 * объектов НЕ размножаются (делит их только lib/ads/adAllocation.ts, и только там, где
 * нужна доля объекта; здесь единица счёта — само объявление).
 *
 * Договор экрана и сервера живёт здесь, в одном месте.
 */

/** Чем отсортирован рейтинг. */
export type AdCreativeRankBasis =
  /** Цена клиента в CRM (Client.sourceAdId) — главное число. */
  | "client"
  /** Клиентов в CRM мало — честный запасной путь: цена обращения Meta. */
  | "conversation"
  /** Данных не хватает ни на то, ни на другое — рейтинга нет. */
  | "none";

/** Метка строки в рейтинге. */
export type AdCreativeMark =
  | "best"
  | "worst"
  /** Данных достаточно, но ни в лучших, ни в худших. */
  | "middle"
  /** Расход или показов слишком мало, чтобы судить («мало данных»). */
  | "lowData";

/** Почему строка «мало данных». */
export type AdCreativeLowDataReason = "spend" | "impressions" | "both";

/** Состояние объявления — то же слово, что на доске (lib/ads/adDelivery.ts). */
export type AdCreativeDelivery = "RUNNING" | "STALLED" | "FINISHED" | "PAUSED" | "REVIEW" | "REJECTED" | "NEVER";

export interface AdCreativeRow {
  adId: string;
  /** Название для людей: первая строка публикации, иначе кампания, иначе имя объявления. */
  title: string;
  campaignName: string | null;
  /** Миниатюра Meta. Ссылки Meta протухают — экран обязан иметь запасной значок. */
  thumbnailUrl: string | null;
  postUrl: string | null;
  delivery: AdCreativeDelivery;
  /** Дней с реальными тратами внутри периода. */
  activeDays: number;
  /** Расход за период, сомони (курс — единый, lib/money.ts::adSpendToTjsCents). */
  spendTjs: number;
  impressions: number;
  /** Обращения Meta («начатые переписки»). */
  conversations: number;
  /** Клиенты CRM с объявления за период (когорта, adLeadAttribution). */
  leads: number;
  /** Дошедшие до показа. */
  showings: number;
  /** Расход / обращения Meta; null — обращений нет (не «0 сомони»). */
  costPerConversationTjs: number | null;
  /** Расход / клиенты CRM; null — клиентов нет. */
  costPerLeadTjs: number | null;
  /**
   * Частота показов ≈ показы / охват. ПРИБЛИЗИТЕЛЬНО: охват в Meta считается по дням,
   * и сумма дневных охватов больше настоящего охвата периода — частота занижена.
   * null — охвата нет.
   */
  frequencyApprox: number | null;
  /** Сколько объектов в объявлении (0 — без объекта). Расход при этом считается один раз. */
  objectsCount: number;
  /** Реклама самого агентства — в рейтинг не входит. */
  brand: boolean;
  mark: AdCreativeMark;
  /** Место среди лучших / худших (1 — самое-самое); null у остальных. */
  rankPosition: number | null;
  /** Заполнено у `lowData`. */
  lowDataReason: AdCreativeLowDataReason | null;
}

export interface AdCreativesResponse {
  from: string;
  to: string;
  label: string;
  rankedBy: AdCreativeRankBasis;
  /** Готовая человеческая подпись, чем ранжировали (и почему именно этим). */
  rankedByNote: string;
  /** Пороги значимости, как есть на сервере: чтобы экран не выдумывал свои. */
  thresholds: { minSpendTjs: number; minImpressions: number };
  /**
   * Не бренд, не чужое. Порядок: лучшие (по месту), середина (по цене), худшие
   * (по месту), «мало данных» (по расходу).
   */
  rows: AdCreativeRow[];
  /** Реклама агентства: расход виден, места в рейтинге нет. */
  brand: AdCreativeRow[];
  /** Сколько объявлений признано чужими (в рейтинге и расходе не участвуют). */
  foreignCount: number;
  /** true — объявлений с тратами больше, чем отдано в ответе. */
  truncated: boolean;
  /** true — клиентов в периоде больше предела выборки: цена клиента по неполному набору. */
  leadsTruncated: boolean;
  syncedAt: string | null;
  enabled: boolean;
}
