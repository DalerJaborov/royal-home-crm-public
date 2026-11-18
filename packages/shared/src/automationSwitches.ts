import { z } from "zod";
import { SELLER_SWITCH_LABELS } from "./sellerAutomationSwitches.js";

/**
 * ВЫКЛЮЧАТЕЛИ «АВТОМАТИКА ИИ И НАПОМИНАНИЯ» (владелец 19.11.2026).
 *
 * Слова владельца: «оставить все эти функции просто сделать переключатели, эти
 * функции очень полезные, а потом решим что выключить». Ничего не удалено: у каждого
 * механизма ниже есть своя строка в Настройках. По умолчанию ВСЁ ВКЛЮЧЕНО
 * (`@default(true)` в базе, `?? true` здесь): выкат миграции поведение не меняет,
 * выключает только человек. Выключенный механизм просто ничего не делает — ни записи,
 * ни задачи, ни уведомления; остальной ход (ответ клиенту, звонок, запись разговора)
 * идёт как обычно.
 *
 * ОДНО МЕСТО: список полей, схема сохранения (её встраивает PATCH /settings),
 * группы и подписи для экрана. Сервер (apps/api/src/lib/automationSwitches.ts) и экран
 * (apps/web/src/pages/settings/AutomationSwitchesSection.tsx) берут всё отсюда.
 *
 * Два выключателя уже существовали и здесь не дублируются:
 *  - «Застой: продавец без объекта» — `dealStaleSellersEnabled` (sellerAutomationSwitches.ts),
 *    стоит в группе «Задачи» этого экрана тем же полем;
 *  - «Клиент в Telegram без ответа» — `telegramSilenceWatchEnabled` (не трогаем).
 */
export const AUTOMATION_SWITCH_KEYS = [
  "aiCardFromCallEnabled",
  "aiAgentShowingAutoBookEnabled",
  "aiJobSeekerAutoDetachEnabled",
  "dealStaleBuyersEnabled",
  "notifyClientWaitingEnabled",
  "notifyRobotTookCallEnabled",
  "notifyTrashAnomalyEnabled",
  "notifyPropertyReviewOverdueEnabled",
] as const;

export type AutomationSwitchKey = (typeof AUTOMATION_SWITCH_KEYS)[number];

/** Нет строки настроек или поля — ВКЛЮЧЕНО: то же умолчание, что у колонки в базе. */
export const AUTOMATION_SWITCH_DEFAULT = true;

/** Как поля лежат в ответе GET /settings (и в строке Settings базы). */
export type AutomationSwitches = Record<AutomationSwitchKey, boolean>;

/** Часть схемы PATCH /settings: каждое поле — необязательный boolean (встраивается через `.shape`). */
export const automationSwitchesUpdateSchema = z.object(
  Object.fromEntries(AUTOMATION_SWITCH_KEYS.map((key) => [key, z.boolean().optional()])) as Record<
    AutomationSwitchKey,
    z.ZodOptional<z.ZodBoolean>
  >
);

export function isAutomationSwitchOn(
  settings: Partial<Record<AutomationSwitchKey, boolean | null | undefined>> | null | undefined,
  key: AutomationSwitchKey
): boolean {
  return settings?.[key] ?? AUTOMATION_SWITCH_DEFAULT;
}

export interface AutomationSwitchLabel {
  /** Название строки на экране. */
  title: string;
  /** Что происходит, пока выключатель ВКЛЮЧЁН (правило SwitchRow: пояснение — про текущее положение). */
  on: string;
  /** Что происходит, пока выключатель ВЫКЛЮЧЕН. */
  off: string;
}

export const AUTOMATION_SWITCH_LABELS: Record<AutomationSwitchKey, AutomationSwitchLabel> = {
  aiCardFromCallEnabled: {
    title: "ИИ дописывает карточку клиента по звонку",
    on: "После разговора ИИ сам вносит в карточку бюджет, район, комнаты и заметки из того, что сказал клиент.",
    off: "Карточку по звонку ИИ не трогает и разговор для этого не разбирает. Расшифровка и итог звонка остаются.",
  },
  aiAgentShowingAutoBookEnabled: {
    title: "ИИ сам назначает показ по разговору агента",
    on: "Если агент договорился о показе словами (в переписке или по телефону), ИИ сам записывает показ.",
    off: "Показ по разговору агента не назначается. Назначить можно кнопкой, бот и помощник записывают как раньше.",
  },
  aiJobSeekerAutoDetachEnabled: {
    title: "ИИ снимает агента, если клиент ищет работу",
    on: "Если клиент с агентом написал или позвонил насчёт вакансии, карточка сама уходит в «Вакансии», а агент снимается.",
    off: "Существующие карточки сами не меняются: агент остаётся. Анкета кандидата и уведомление приходят, кнопка «В кандидаты» работает.",
  },
  dealStaleBuyersEnabled: {
    title: "Застой: покупатель без сделки",
    on: "Покупателю без сделки дольше срока из «Застой сделки» агенту ставится задача «Закройте сделку».",
    off: "По покупателям эта задача не ставится.",
  },
  notifyClientWaitingEnabled: {
    title: "«Клиент ждёт ответа»",
    on: "Если клиент в переписке остался без ответа, ответственному (или руководству) приходит уведомление (и повтор, если переписку взял сотрудник и не ответил).",
    off: "Эти уведомления не приходят. Бот отвечает клиентам как раньше.",
  },
  notifyRobotTookCallEnabled: {
    title: "«Робот взял звонок, послушайте»",
    on: "Когда робот ответил на входящий звонок, директор и администратор получают уведомление со ссылкой на прослушивание.",
    off: "Уведомления нет. Робот отвечает и запись звонка идёт как обычно.",
  },
  notifyTrashAnomalyEnabled: {
    title: "«Много удалений у агента»",
    on: "Если у одного агента за сутки в Корзину ушло 5 клиентов и больше, директор и администратор получают уведомление.",
    off: "Уведомления нет. Удаления работают как обычно.",
  },
  notifyPropertyReviewOverdueEnabled: {
    title: "«Объект долго на проверке»",
    on: "Если объект завис на проверке дольше срока, проверяющему или руководству приходит уведомление.",
    off: "Уведомления нет. Срок по-прежнему красится на карточке объекта.",
  },
};

export interface AutomationSwitchGroup {
  id: "ai" | "tasks" | "notifications";
  title: string;
  /** Ключи группы: свои и уже существовавшие (`dealStaleSellersEnabled`). */
  keys: ReadonlyArray<AutomationSwitchKey | "dealStaleSellersEnabled">;
}

/** Группы и порядок строк на экране. */
export const AUTOMATION_SWITCH_GROUPS: readonly AutomationSwitchGroup[] = [
  { id: "ai", title: "ИИ решает за агента", keys: ["aiCardFromCallEnabled", "aiAgentShowingAutoBookEnabled", "aiJobSeekerAutoDetachEnabled"] },
  { id: "tasks", title: "Задачи", keys: ["dealStaleSellersEnabled", "dealStaleBuyersEnabled"] },
  {
    id: "notifications",
    title: "Уведомления",
    keys: ["notifyClientWaitingEnabled", "notifyRobotTookCallEnabled", "notifyTrashAnomalyEnabled", "notifyPropertyReviewOverdueEnabled"],
  },
];

/** Подпись строки по ключу — для уже существовавшего выключателя берётся его родная. */
export function automationSwitchLabel(key: AutomationSwitchKey | "dealStaleSellersEnabled"): AutomationSwitchLabel {
  return key === "dealStaleSellersEnabled" ? SELLER_SWITCH_LABELS.dealStaleSellersEnabled : AUTOMATION_SWITCH_LABELS[key];
}
