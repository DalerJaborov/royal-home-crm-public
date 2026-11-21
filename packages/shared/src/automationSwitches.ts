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
  "botRepliesAfterLeadEnabled",
  "botSpamFilterEnabled",
  "shabnamSocialPublishEnabled",
  "instagramCompanyKeyEnabled",
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
    title: "Напоминание «клиент молчит 30 минут»",
    on: "Если клиент написал, а ему никто не ответил 30 минут, ответственному (или руководству) приходит напоминание, и повтор, если переписку взял сотрудник и молчит.",
    off: "Этих напоминаний нет. Сообщения «бот сломался» и «бот передал клиента сотруднику» приходят всегда.",
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
  // Владелец 20.11.2026: «таким спамерам как то не отвечать или как то сэкономить токены».
  botSpamFilterEnabled: {
    title: "Спам — без ответа",
    on: "Просьбы денег, «лайк, коммент, подпишитесь», реклама чужих услуг: бот не отвечает и не тратит ИИ. Номер или слова о квартире, цене, вакансии — всегда обычный ответ.",
    off: "Бот отвечает и на такие сообщения, как на обычные.",
  },
  // Владелец 20.11.2026: «если после передачи агенту клиент опять что-то написал, бот не должен же молчать».
  botRepliesAfterLeadEnabled: {
    title: "Бот отвечает и после заявки",
    on: "Клиент пишет после заявки: бот коротко отвечает, новое передаёт агенту заметкой. Молчит, пока сотрудник сам ведёт переписку.",
    off: "После заявки бот отвечает только на новую деталь и простые вопросы (условия, где работаем, часы), на остальное молчит и ждёт агента.",
  },
  // Владелец 21.11.2026: «Учить Шабнам публиковать ролики без объекта и карусели?» — «да».
  shabnamSocialPublishEnabled: {
    title: "Шабнам публикует ролики и фото без объекта",
    on: "Сотрудник с правом маркетинга присылает Шабнам ролик или до 10 фото, она готовит подпись и показывает пост. В соцсети он уходит только после кнопки «Опубликовать».",
    off: "Шабнам не готовит такие посты. Ролики к объектам она принимает как раньше, пост без объекта можно сделать в разделе «Ролики».",
  },
  // Владелец 21.11.2026: «Да, переводи» — Instagram на постоянный ключ компании (смена пароля не глушит бота).
  instagramCompanyKeyEnabled: {
    title: "Instagram через постоянный ключ Meta",
    on: "Аккаунт Instagram, у которого проверка прошла (Страница Facebook с этим Instagram выдана ключу компании), отвечает через Страницу и публикует ролики, истории и фото постоянным ключом. Смена пароля Instagram бота и публикации не глушит. Если Meta откажет в ответе, он уйдёт личным ключом аккаунта.",
    off: "Все аккаунты Instagram отвечают и публикуют личными ключами, как раньше. После смены пароля Instagram аккаунт нужно подключить заново.",
  },
};

export interface AutomationSwitchGroup {
  id: "ai" | "tasks" | "notifications" | "bot";
  title: string;
  /** Ключи группы: свои и уже существовавшие (`dealStaleSellersEnabled`). */
  keys: ReadonlyArray<AutomationSwitchKey | "dealStaleSellersEnabled">;
}

/** Группы и порядок строк на экране. */
export const AUTOMATION_SWITCH_GROUPS: readonly AutomationSwitchGroup[] = [
  {
    id: "ai",
    title: "ИИ решает за агента",
    keys: ["aiCardFromCallEnabled", "aiAgentShowingAutoBookEnabled", "aiJobSeekerAutoDetachEnabled", "shabnamSocialPublishEnabled"],
  },
  { id: "tasks", title: "Задачи", keys: ["dealStaleSellersEnabled", "dealStaleBuyersEnabled"] },
  {
    id: "notifications",
    title: "Уведомления",
    keys: ["notifyClientWaitingEnabled", "notifyRobotTookCallEnabled", "notifyTrashAnomalyEnabled", "notifyPropertyReviewOverdueEnabled"],
  },
  // Instagram через ключ компании — в группе бота (ревью #344: новых групп на экране не заводим).
  { id: "bot", title: "Бот клиентов", keys: ["botRepliesAfterLeadEnabled", "botSpamFilterEnabled", "instagramCompanyKeyEnabled"] },
];

/** Подпись строки по ключу — для уже существовавшего выключателя берётся его родная. */
export function automationSwitchLabel(key: AutomationSwitchKey | "dealStaleSellersEnabled"): AutomationSwitchLabel {
  return key === "dealStaleSellersEnabled" ? SELLER_SWITCH_LABELS.dealStaleSellersEnabled : AUTOMATION_SWITCH_LABELS[key];
}
