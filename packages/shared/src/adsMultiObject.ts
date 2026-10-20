import { z } from "zod";

/**
 * ОДНО ОБЪЯВЛЕНИЕ — НЕСКОЛЬКО ОБЪЕКТОВ (03.10.2026).
 *
 * Поводом стало «гибкое» объявление «Умед хонахо»: в одном объявлении Ads Manager
 * лежат 4 ролика про 4 разные квартиры, а CRM видела один пост и записывала весь
 * расход на первый объект. Договор экрана и сервера живёт здесь, в одном месте.
 */

/** Доля одного объекта в объявлении: вес относительный, итог нормируется до 100 %. */
export const adPropertyShareSchema = z.object({
  propertyId: z.string().uuid(),
  // Минимум 0.001 — ровно та точность, до которой adAllocation.ts округляет вес (колонка
  // хранит три знака): 0.0004 раньше проходил проверку, а потом молча снимал объект.
  weight: z.number().min(0.001).max(1000).default(1),
});

/** PATCH /ads/:id/properties — полный список объектов объявления; пустой = снять привязку. */
export const setAdPropertiesBodySchema = z.object({
  items: z.array(adPropertyShareSchema).max(20),
});
export type SetAdPropertiesBody = z.infer<typeof setAdPropertiesBodySchema>;

/** Объект внутри строки рекламы: доля и деньги именно на него. */
export interface AdBoardProperty {
  id: string;
  shortId: number;
  title: string | null;
  status: string;
  thumbUrl: string | null;
  /** 0..1, сумма долей объявления равна 1. */
  share: number;
  /** Деньги на этот объект за выбранный период, сомони; сумма по объектам = расход объявления до дирама. */
  spendTjs: number;
  conversations: number;
  /** Клиенты и цена клиента на объект (волна 1, 03.10.2026): клиенты объявления делятся по весам, как деньги. */
  leadStats?: AdLeadStats;
}

/**
 * Объявление глазами ОДНОГО объекта: GET /ads/property/:id → `adsOfProperty[]`
 * (03.10.2026). Одна строка на каждое объявление, где объект входит в AdProperty
 * (исключённые из учёта не попадают). Деньги делит lib/ads/adAllocation.ts — тот же
 * делитель, что у отчёта и доски, поэтому сумма `spendTjs` по всем объектам
 * объявления равна его расходу до дирама.
 */
export interface AdOfPropertyShare {
  adId: string;
  name: string;
  /** Доля этого объекта в объявлении, 0..1. */
  share: number;
  /** Сколько объектов в объявлении всего (1 — объявление не общее). */
  objectsInAd: number;
  /** Деньги именно на этот объект из объявления, сомони (тот же период, что у плашки). */
  spendTjs: number;
}

/** Добавка к строке объекта в GET /ads/report: сколько объявлений объекта общие (на ≥ 2 объекта). */
export interface AdSpendSharedAds {
  sharedAdsCount: number;
}

/**
 * РЕАЛЬНАЯ ЦЕНА КЛИЕНТА ПО ОБЪЯВЛЕНИЮ И ПО ОБЪЕКТУ (03.10.2026, «Реклама, волна 1»).
 *
 * «Обращение» Meta — это начатая переписка по версии Meta; «клиент» — человек, который
 * реально попал в CRM с этим объявлением (Client.sourceAdId). Это разные числа, и
 * владельцу нужны оба: первое меряет рекламу, второе — деньги, которые дошли до дела.
 * Цепочка: объявление → обращение → клиент → показ → сделка → комиссия компании.
 *
 * Все поля НОВЫЕ и необязательные в ответах /ads/board и /ads/property/:id: экраны,
 * не знающие про них, работают как раньше. Считает lib/ads/adLeadAttribution.ts.
 */
export interface AdLeadStats {
  /** Клиентов в CRM, пришедших с объявления за период (когорта: карточка создана в период). */
  leads: number;
  /** Из них дошли до показа (хотя бы один неотменённый показ). */
  showings: number;
  /** Из них дошли до закрытой сделки. */
  deals: number;
  /** Доля компании в комиссии закрытых сделок этих клиентов, сомони. */
  commissionTjs: number;
  /** Расход / клиенты в CRM. null — клиентов нет (деления на ноль не показываем). */
  costPerLeadTjs: number | null;
  /** Расход / дошедшие до показа. null — показов нет. */
  costPerShowingTjs: number | null;
  /** Расход / обращения по версии Meta — для сравнения с ценой клиента. null — обращений нет. */
  costPerLeadMeta: number | null;
  /** Окупаемость: (комиссия компании − расход) / расход, доля. null — расхода нет. */
  romi: number | null;
  /**
   * true — `leads` и `showings` это ДОЛИ клиентов объявления, поделённые между объектами по
   * весам (число с двумя знаками, например 0.25), а не целые люди. Так бывает в разбивке
   * объявления по объектам: целыми клиентов делить нельзя, и последние объекты всегда
   * оставались бы с «клиентов нет». Итог по объявлению — всегда целые, поле там не ставится.
   */
  leadsAreShares?: boolean;
}

/** Утренняя сводка директору: рекламные цифры за вчера. */
export interface AdsDigestSummary {
  spendTjs: number;
  /** Обращения по версии Meta. */
  conversations: number;
  /** Клиенты в CRM, пришедшие с рекламы вчера. */
  leads: number;
  costPerLeadTjs: number | null;
  /** Цена клиента за 7 дней до вчерашнего включительно против предыдущих 7; null — данных не хватает. */
  trend: "up" | "down" | "flat" | null;
  /** Насколько изменилась цена клиента, процентов (по модулю). */
  trendPct: number | null;
}

/** Что сверка нашла неправильным. */
export const adIssueKinds = [
  "NO_OBJECT", // идёт и тратит деньги, а объекта, «бренда» и «чужого» нет
  "ASSETS_NOT_LINKED", // материалов в объявлении больше, чем привязанных объектов
  "SHARE_SUM_BROKEN", // доли не дают 100 % или деньги по объектам не сходятся с расходом объявления
  "SPEND_MISMATCH", // расход в CRM расходится с итогом кабинета Meta
  "STALE_SYNC", // сверка давно не проходила
  "AD_REJECTED", // Meta отклонила объявление / есть проблемы доставки
] as const;
export type AdIssueKind = (typeof adIssueKinds)[number];

export interface AdIssue {
  kind: AdIssueKind;
  adId: string | null;
  text: string;
}

/** GET /ads/reconcile */
export interface AdReconcileReport {
  ok: boolean;
  checkedAt: string;
  from: string;
  to: string;
  crmTotalTjs: number;
  metaTotalTjs: number | null;
  /** (crm − meta) / meta в процентах; null, когда Meta не ответила. */
  diffPct: number | null;
  issues: AdIssue[];
}

/** GET /ads/trend — расход и результат по дням. */
export interface AdTrendPoint {
  date: string;
  spendTjs: number;
  conversations: number;
  impressions: number;
}

/** GET /ads/leaderboard — объекты по цене обращения (меньше = лучше). */
export interface AdLeaderboardRow {
  propertyId: string;
  shortId: number;
  title: string | null;
  spendTjs: number;
  conversations: number;
  costPerConversationTjs: number | null;
}
