import { Building2, CalendarClock, ClipboardPlus, History, Search, TrendingUp, type LucideIcon } from "lucide-react";

/**
 * Категории-подсказки ИИ-ассистента — раньше жили только в AssistantPanel.tsx.
 * Вынесены сюда, потому что с 19.08.2026 их показывают ДВА места: сама панель
 * ассистента и раздел «Спросить ИИ» в меню кнопки «+» (FabMenu.tsx) — то же самое
 * содержимое, разное расположение. Держать список в одном файле, а не копировать
 * между компонентами.
 */
export interface AssistantCategory {
  icon: LucideIcon;
  label: string;
  example: string;
}

export const ASSISTANT_CATEGORIES: AssistantCategory[] = [
  {
    icon: Search,
    label: "Поиск объектов",
    example: "Покажи 2-комнатные до 400 000 с. в Сино",
  },
  {
    icon: Building2,
    label: "Клиенты",
    example: "Кто из моих клиентов ближе всего к сделке?",
  },
  {
    icon: TrendingUp,
    label: "Статистика",
    example: "Сколько лидов пришло в этом месяце и откуда?",
  },
  {
    icon: History,
    label: "История по клиенту",
    example: "Что обсуждали на прошлой встрече с Умедом?",
  },
  {
    icon: CalendarClock,
    label: "Задачи и встречи",
    example: "Перенеси встречу с Далером на завтра",
  },
  {
    icon: ClipboardPlus,
    label: "Новая задача",
    example: "Поставь задачу перезвонить Мадине в четверг в 15:00",
  },
];
