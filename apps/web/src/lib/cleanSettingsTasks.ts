import { SETTINGS_SECTIONS, normalizeSettingsSearch } from "./settingsSections";
import { SETTINGS_TABS, type SettingsTabId } from "./settingsTabs";

export interface CleanSettingsTask {
  id: string;
  tab: SettingsTabId;
  title: string;
  hint: string;
  topics: readonly string[];
  directorOnly?: boolean;
}

const topics = (tab: SettingsTabId, start = 0, end?: number) => SETTINGS_SECTIONS[tab].slice(start, end)
  .flatMap((section) => [section.title, ...(section.aliases ?? [])]);

/** Navigation only. Values, validation, permissions and save handlers stay in their existing forms. */
export const CLEAN_SETTINGS_TASKS: readonly CleanSettingsTask[] = [
  { tab: "agency", id: "company", title: "Название и логотип", hint: "Как компания представляется клиентам", topics: topics("agency", 0, 1) },
  { tab: "agency", id: "locations", title: "Районы и ориентиры", hint: "Общие справочники адресов для объектов и подбора", topics: topics("agency", 1, 3) },
  { tab: "money", id: "commission", title: "Комиссия сделки", hint: "Доли компании, сотрудников и план комиссии", topics: [...topics("money", 0, 1), "План комиссии на месяц"] },
  { tab: "money", id: "currency", title: "Курс валют", hint: "Курс доллара к сомони и его обновление", topics: topics("money", 1, 2) },
  { tab: "leads", id: "intake", title: "Приём клиентов", hint: "Приоритеты, занятость, лимиты и уведомления", topics: topics("leads") },
  { tab: "leads", id: "distribution", title: "Кому назначать клиентов", hint: "Правила распределения между сотрудниками", topics: topics("team", 1, 2) },
  { tab: "leads", id: "deadlines", title: "Сроки, лимиты и возврат", hint: "Клиенты, подготовка объектов, резерв и повторная работа", topics: [...topics("money", 2), "Сроки и возврат клиентов"] },
  { tab: "matching", id: "matching", title: "Правила подбора", hint: "Бюджет, комнаты, расстояние и оценка совпадения", topics: topics("matching") },
  { tab: "team", id: "people", title: "Сотрудники и доступ", hint: "Учётные записи, права и внутренние номера", topics: topics("team", 0, 1) },
  { tab: "team", id: "rating", title: "Рейтинг и показатели", hint: "Royal Score, состав KPI и события рейтинга", topics: topics("team", 2) },
  { tab: "channels", id: "messengers", title: "Мессенджеры", hint: "Аккаунты WhatsApp, Instagram, Messenger и Telegram", topics: topics("channels", 1, 4) },
  { tab: "channels", id: "publishing", title: "Публикации и обложки", hint: "Передача видео, соцсети и расписание выхода", topics: [...topics("channels", 0, 1), ...topics("channels", 11, 16), "Шаблоны обложек"] },
  { tab: "channels", id: "advertising", title: "Рекламные подключения", hint: "Кабинет Meta, расходы и каталог объектов", topics: [...topics("channels", 4, 5), ...topics("channels", 16, 17)] },
  { tab: "channels", id: "phone", title: "Телефония", hint: "Подключение станции, маршруты звонков и звуки", topics: topics("channels", 5, 11) },
  { tab: "channels", id: "sms", title: "Отправка СМС", hint: "Подключение службы доставки сообщений", topics: topics("channels", 17) },
  { tab: "bot", id: "operation", title: "Работа помощника", hint: "Включение, каналы, время ответов и паузы", topics: topics("bot", 3, 6) },
  { tab: "bot", id: "answers", title: "Ответы и тексты", hint: "Правила продажи, инструкции, комментарии и подписи", topics: [...topics("bot", 6, 10), ...topics("bot", 11, 12)] },
  { tab: "bot", id: "voice", title: "Голосовой помощник", hint: "Голос, язык и работа по телефону", topics: [...topics("bot", 10, 11), ...topics("bot", 12, 13)] },
  { tab: "bot", id: "learning", title: "Обучение и проверка ответов", hint: "Тренировка, вопросы и разбор потерянных клиентов", topics: topics("bot", 13) },
  { tab: "bot", id: "models", title: "Модели и ключи подключения", hint: "Техническая настройка поставщиков ИИ", topics: topics("bot", 0, 3) },
  { tab: "bot", id: "rollout", title: "Внедрение нового помощника", hint: "Управление этапами запуска клиентского помощника", topics: ["Текстовый агент клиентов", "Клиентский ИИ-агент", "Развёртывание помощника"] },
  { tab: "system", id: "monitoring", title: "Состояние и диагностика", hint: "Здоровье системы, журналы и проблемы в работе", topics: [...topics("system", 0, 2), ...topics("system", 3, 5)] },
  { tab: "system", id: "workspace", title: "Интерфейс и главный экран", hint: "Включение новой темы и состав пульта директора", topics: [...topics("agency", 3), ...topics("system", 2, 3), "Новый интерфейс CRM"] },
  { tab: "system", id: "security", title: "Безопасность входа", hint: "Подтверждение личности и срок открытого раздела", topics: topics("system", 5, 6) },
  { tab: "system", id: "data", title: "Импорт и восстановление", hint: "Загрузка данных и точки возврата настроек", topics: topics("system", 6, 8) },
  { tab: "system", id: "website", title: "Управление сайтом", hint: "Доступ к администрированию royalhome.tj", topics: topics("system", 8), directorOnly: true },
];

export const CLEAN_SETTINGS_LABELS: Record<SettingsTabId, string> = {
  agency: "Компания", money: "Деньги", leads: "Клиенты и правила работы", matching: "Подбор объектов",
  team: "Сотрудники и права", channels: "Связь и публикации", bot: "ИИ-помощник", system: "Система и безопасность",
};

export function cleanSettingsTasks(tab: SettingsTabId, role?: string) {
  return CLEAN_SETTINGS_TASKS.filter((task) => task.tab === tab && (!task.directorOnly || role === "DIRECTOR")
    && (task.id !== "rollout" || role === "DIRECTOR" || role === "ADMIN"));
}

export function findCleanSettingsTasks(query: string, role?: string) {
  const words = normalizeSettingsSearch(query).trim().split(/\s+/).filter(Boolean);
  return SETTINGS_TABS.flatMap((tab) => cleanSettingsTasks(tab.id, role)).filter((task) => {
    const text = normalizeSettingsSearch([task.title, task.hint, ...task.topics].join(" "));
    return words.every((word) => text.includes(word));
  });
}

export function resolveCleanSettingsTask(tab: SettingsTabId, params: URLSearchParams, role?: string) {
  const tasks = cleanSettingsTasks(tab, role);
  // OAuth providers return to their historical category address. Keep their result visible.
  const callback = tab === "channels" && (params.has("ads") ? "advertising" : params.has("tiktok") || params.has("threads") ? "publishing" : null);
  return tasks.find((task) => task.id === (callback || params.get("task"))) ?? tasks[0];
}

export function cleanSettingsHref(tab: SettingsTabId | null, search: string, task?: string) {
  const params = new URLSearchParams(search);
  params.delete("task");
  params.delete("section");
  // A completed OAuth result belongs to its connection screen, not to the next category.
  for (const key of ["ads", "tiktok", "threads", "message", "reason"]) params.delete(key);
  if (tab) params.set("tab", tab); else params.delete("tab");
  if (task) params.set("task", task);
  return `/settings${params.size ? `?${params}` : ""}`;
}

export function cleanSettingsSearchHref(task: CleanSettingsTask, query: string, search: string) {
  const words = normalizeSettingsSearch(query).trim().split(/\s+/).filter(Boolean);
  const section = Object.values(SETTINGS_SECTIONS).flat().find((entry) => task.topics.includes(entry.title)
    && words.every((word) => normalizeSettingsSearch([entry.title, ...(entry.aliases ?? [])].join(" ")).includes(word)));
  const href = cleanSettingsHref(task.tab, search, task.id);
  return section ? `${href}&section=${encodeURIComponent(section.title)}` : href;
}
