import type {
  ClientSource,
  ClientStatus,
  DealStage,
  ExpenseCategory,
  InactiveReason,
  LostReason,
  LostStage,
  MarketType,
  PropertyCondition,
  PropertyDetailKey,
  PropertyStage,
  PropertyType,
  Role,
  WorkStatus,
} from "./enums.js";

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  APARTMENT: "Квартира",
  HOUSE: "Дом",
  COMMERCIAL: "Коммерческое",
  LAND: "Участок",
};

export const PROPERTY_CONDITION_LABELS: Record<PropertyCondition, string> = {
  NEEDS_REPAIR: "Требует ремонта",
  GOOD: "Хорошее",
  EXCELLENT: "Отличное",
  NEW_BUILDING: "Новостройка",
};

export const PROPERTY_STAGE_LABELS: Record<PropertyStage, string> = {
  FOUNDATION: "Котлован",
  SHELL: "Коробка, черновые не сделаны",
  UNDER_CONSTRUCTION: "Строится",
  ROUGH_FINISH: "Черновые работы сделаны",
  BUILT: "Построен",
};

export const MARKET_TYPE_LABELS: Record<MarketType, string> = {
  NEW_BUILD: "Новостройки",
  SECONDARY: "Вторичка",
  FOUNDATION_PIT: "Котлован",
};

export const PROPERTY_DETAIL_LABELS: Record<PropertyDetailKey, string> = {
  balcony: "Балкон",
  bathroom: "Санузел",
  ceilingHeight: "Высота потолков",
  windows: "Окна",
  heating: "Отопление",
  elevator: "Лифт",
  parking: "Парковка",
  security: "Безопасность",
  yearBuilt: "Год постройки",
  material: "Материал дома",
  internet: "Интернет",
  furniture: "Мебель",
  appliances: "Бытовая техника",
};

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  ADVERTISING: "Реклама",
  SALARY: "Зарплата",
  OFFICE: "Офис",
  OTHER: "Прочее",
};

export const CLIENT_SOURCE_LABELS: Record<ClientSource, string> = {
  WEBSITE: "Сайт",
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
  TELEGRAM: "Telegram",
  TIKTOK: "TikTok",
  GOOGLE_ADS: "Google Ads",
  YANDEX_DIRECT: "Яндекс.Директ",
  REFERRAL: "Рекомендация",
  PHONE_CALL: "Звонок",
  WALK_IN: "Пришёл в офис",
};

export const ROLE_LABELS: Record<Role, string> = {
  DIRECTOR: "Директор",
  ADMIN: "Администратор",
  MANAGER: "Менеджер",
  AGENT: "Агент",
  MARKETING: "Маркетинг",
  EDITOR: "Монтажёр",
  SECURITY: "Служба безопасности",
  SHAREHOLDER: "Акционер",
  HEAD_OF_SALES: "РОП",
};

export const CLIENT_STATUS_LABELS: Record<ClientStatus, string> = {
  NEW: "Новый",
  CONTACTED: "На контакте",
  HOT: "Горячий",
  COLD: "Холодный",
  UNRESPONSIVE: "Не отвечает",
  LOST: "Потерянный",
  DEAL_CLOSED: "Сделка закрыта",
  ARCHIVED: "В архиве",
};

/** Подписи для того, чем управляет сам агент (см. WorkStatus в enums.ts). */
export const WORK_STATUS_LABELS: Record<WorkStatus, string> = {
  ACTIVE: "Активный",
  INACTIVE: "Неактивный",
};

export const INACTIVE_REASON_LABELS: Record<InactiveReason, string> = {
  THINKING: "Клиент думает",
  NO_MONEY_YET: "Временно нет денег",
  POSTPONED: "Покупку отложил",
  STOPPED_RESPONDING: "Перестал отвечать",
  NOT_READY_YET: "Временно не готов покупать",
  ASKED_LATER: "Попросил связаться позже",
  FAMILY_CIRCUMSTANCES: "Семейные обстоятельства",
  OTHER: "Другое (см. комментарий)",
};

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  NEGOTIATION: "Переговоры",
  AGREEMENT_PENDING: "Согласование",
  CONTRACT_SIGNED: "Договор подписан",
  PENDING_APPROVAL: "Ждёт одобрения",
  COMPLETED: "Завершена",
  CANCELLED: "Отменена",
};

export const LOST_STAGE_LABELS: Record<LostStage, string> = {
  greeting: "Поздоровались, до сути не дошло",
  needs: "Выясняли, что человек ищет",
  budget: "Разговор про бюджет",
  district: "Разговор про район",
  properties: "Бот прислал объекты",
  phone: "Бот попросил номер",
  other: "Другое",
};

export const LOST_REASON_LABELS: Record<LostReason, string> = {
  opted_out: "Попросил больше не писать",
  follow_ups_exhausted: "Напоминания кончились, не вернулся",
  silent: "Замолчал и не вернулся",
};
