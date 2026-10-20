/**
 * «ОТЧЁТ ВЛАДЕЛЬЦУ ОБЪЕКТА» — договор публичной страницы /o/:token (03.10.2026).
 *
 * Ответ GET /api/v1/public/owner-report/:token открыт БЕЗ входа, поэтому в нём ТОЛЬКО
 * агрегаты: числа, темы вопросов и текст-рекомендация. Здесь нет и не должно быть
 * сумм расходов и комиссии, имён и телефонов людей, цитат, цен других объектов,
 * документов. Новое поле сюда добавляется осознанно — тест
 * `owner-report-public.test.ts` перебирает весь JSON ответа и ищет запрещённое.
 *
 * Язык ответа — русский; структура (`kind`, `key`, `label`) готова к переводу на
 * таджикский: подписи берутся по ключу, а не вшиты в числа.
 */

/** Окно «последняя неделя» на странице. */
export const OWNER_REPORT_WEEK_DAYS = 7;
/** Окно «за всё время»: больше любого срока жизни объекта в базе. */
export const OWNER_REPORT_ALL_DAYS = 3650;

/** Темы вопросов клиентов. Список закрытый: страница подбирает подпись по ключу. */
export const OWNER_REPORT_TOPIC_KEYS = ["PRICE", "BARGAIN", "DOCUMENTS", "CONDITION", "DISTRICT", "FLOOR"] as const;
export type OwnerReportTopicKey = (typeof OWNER_REPORT_TOPIC_KEYS)[number];

export const OWNER_REPORT_TOPIC_LABELS: Record<OwnerReportTopicKey, string> = {
  PRICE: "Цена",
  BARGAIN: "Торг и скидка",
  DOCUMENTS: "Документы",
  CONDITION: "Состояние и ремонт",
  DISTRICT: "Район и окружение",
  FLOOR: "Этаж и планировка",
};

/** Что рекомендуем делать дальше. Правила — lib/ownerReport/build.ts. */
export const OWNER_REPORT_NEXT_STEP_KINDS = [
  "DISCUSS_PRICE",
  "HOLD_PRICE",
  "REFRESH_MEDIA",
  "FOLLOW_UP",
  "WAIT",
  "NOT_ON_SALE",
  "KEEP_WORKING",
] as const;
export type OwnerReportNextStepKind = (typeof OWNER_REPORT_NEXT_STEP_KINDS)[number];

export type OwnerReportSaleStatus = "AVAILABLE" | "SOON" | "RESERVED" | "SOLD" | "UNAVAILABLE";

/** Цифры за один период («7 дней» или «всё время»). `null` — по этому каналу данных нет вовсе. */
export interface OwnerReportPeriod {
  /** Сколько раз объект показали и отправили людям. */
  shownToClients: number;
  /** Сколько разных людей были на связи по объекту (звонок, сообщение, диалог бота; один человек — один раз). */
  contacts: number;
  /** Проведённых показов. */
  showings: number;
  /** Содержательных комментариев (бот ответил по делу или передал человеку; спам не считается). */
  comments: number;
  /** Просмотры страницы объекта на сайте; null — объект не на сайте или данных от сайта нет. */
  siteViews: number | null;
  /** Реклама: показы и обращения; null — реклама по объекту не шла. Деньги сюда не попадают никогда. */
  ads: { impressions: number; inquiries: number } | null;
}

export interface OwnerReportWeek {
  /** Понедельник недели по Душанбе, «ГГГГ-ММ-ДД». */
  weekStart: string;
  events: number;
  people: number;
}

export interface OwnerReportTopic {
  key: OwnerReportTopicKey;
  label: string;
  /** Сколько раз тема прозвучала. Ни цитат, ни имён, ни телефонов. */
  count: number;
}

export interface OwnerReportNextStep {
  kind: OwnerReportNextStepKind;
  title: string;
  text: string;
  /** Цифры, на которых построена рекомендация, — показывать всегда. */
  evidence: string[];
}

export interface OwnerReportResponse {
  /** ISO-момент, на который собраны данные. */
  generatedAt: string;
  agency: { name: string; slogan: string; logoUrl: string | null };
  property: {
    title: string;
    rooms: number | null;
    district: string | null;
    city: string | null;
    price: number;
    currency: string;
    /** Первое фото (миниатюра); null — фото нет. */
    photoUrl: string | null;
    saleStatus: OwnerReportSaleStatus;
    /** Дней в продаже; null — объект не в продаже. */
    daysOnSale: number | null;
  };
  periods: { week: OwnerReportPeriod; all: OwnerReportPeriod };
  /** Динамика интереса по неделям, от старой к новой. */
  weekly: OwnerReportWeek[];
  /** 0–5 тем, по убыванию; пусто — вопросов пока не накопилось. */
  topics: OwnerReportTopic[];
  nextStep: OwnerReportNextStep;
}

/** Ссылка в карточке объекта у сотрудника (POST/GET /properties/:id/owner-report-link). */
export interface OwnerReportLinkInfo {
  id: string;
  /** Полный адрес страницы для владельца (с базой CRM, если она задана). */
  url: string;
  createdAt: string;
  lastViewedAt: string | null;
  viewsCount: number;
}
