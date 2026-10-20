import { Banknote, Bot, Building2, Database, Inbox, MessageSquare, Search, Users } from "lucide-react";

/**
 * Метаданные семи вкладок Настроек — общие для десктопного списка
 * `.sset-nav` и телефонного списка `.card-s .row` в pages/Settings.tsx
 * (обе ветки разметки — desktop и mobile — живут в одном компоненте
 * `Settings()`). Вынесено в отдельный файл, чтобы список подписей и иконок
 * не дублировался между веткой ПК и веткой телефона внутри того же файла.
 */
export type SettingsTabId = "agency" | "money" | "leads" | "matching" | "team" | "channels" | "bot" | "system";

export interface SettingsTabMeta {
  id: SettingsTabId;
  label: string;
  hint: string;
  icon: typeof Building2;
}

export const SETTINGS_TABS: SettingsTabMeta[] = [
  { id: "agency", label: "Агентство", hint: "Название, логотип, районы", icon: Building2 },
  { id: "money", label: "Деньги", hint: "Комиссия и курс доллара", icon: Banknote },
  { id: "leads", label: "Лиды", hint: "Кому достаётся клиент, лимиты и уведомления", icon: Inbox },
  { id: "matching", label: "Подбор объектов", hint: "Автоподбор, допуски совпадения, радиус по карте", icon: Search },
  { id: "team", label: "Сотрудники", hint: "Люди, права, распределение лидов", icon: Users },
  { id: "channels", label: "Каналы связи", hint: "Instagram, WhatsApp, Telegram", icon: MessageSquare },
  {
    id: "bot",
    label: "ИИ-ассистент",
    hint: "Ключи моделей, промт, способности бота, паузы и чему бот научился",
    icon: Bot,
  },
  { id: "system", label: "Данные и система", hint: "Импорт, здоровье, сайт", icon: Database },
];

export function isSettingsTabId(value: string | null): value is SettingsTabId {
  return SETTINGS_TABS.some((t) => t.id === value);
}
