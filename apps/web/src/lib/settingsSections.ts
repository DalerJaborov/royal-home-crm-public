import type { SettingsTabId } from "./settingsTabs";

interface SettingsSectionMeta {
  title: string;
  /** Public terms present in the actual panel; never values of settings or secrets. */
  aliases?: readonly string[];
  directorOnly?: boolean;
}

/** Index of the existing SettingsTabContent panels. This does not create controls,
 * hide fields, or import mounted forms into the navigation bundle. */
export const SETTINGS_SECTIONS: Record<SettingsTabId, readonly SettingsSectionMeta[]> = {
  agency: [
    { title: "Компания", aliases: ["Название и логотип"] }, { title: "Районы" }, { title: "Ориентиры" },
    { title: "Новая оболочка CRM" },
  ],
  money: [
    { title: "Структура комиссии сделки" }, { title: "Курс доллара к сомони" },
    { title: "Сроки и лимиты по лидам" }, { title: "Сроки подготовки объекта, дни" },
    { title: "Резерв объекта на сделке" }, { title: "Пауза «не принимаю лиды»", aliases: ["Дисциплина"] },
    { title: "Бездействие по клиенту" }, { title: "Застой сделки" }, { title: "Светофор неактивных клиентов" },
    { title: "Возврат потерянного или неактивного клиента" }, { title: "Продавец без объекта" },
    { title: "Покупатель думает (медленный трек)" },
  ],
  leads: [
    { title: "Свой объект: свой клиент", aliases: ["Распределение клиентов"] },
    { title: "Занятость агента в раздаче" }, { title: "Передача как признак конфликта" },
    { title: "Лимит активных лидов", aliases: ["Лимиты агентов"] },
    { title: "Уведомления", aliases: ["Напоминания о показах"] },
    { title: "Когда агент уходит из компании" }, { title: "Реактивация старых клиентов" },
  ],
  matching: [
    { title: "Автоподбор" }, { title: "Допуски совпадения" },
    { title: "Радиус по карте" }, { title: "Отложенные клиенты" },
    { title: "Веса шкалы совпадения клиента и объекта" },
  ],
  team: [
    { title: "Люди", aliases: ["Сотрудники и права"] }, { title: "Распределение лидов" },
    { title: "Royal Score — рубильник модуля", aliases: ["RoyalScore"] },
    { title: "Из чего складывается KPI", aliases: ["Веса KPI"] }, { title: "Royal Score", aliases: ["События рейтинга"] },
  ],
  // ChannelsTab, WhatsAppTemplatesSection and SmsSection, as mounted by SettingsTabContent.
  channels: [
    { title: "Обложки для соцсетей", aliases: ["ChatGPT", "OpenAI"] },
    { title: "WhatsApp, Instagram и Messenger через Meta", aliases: ["Facebook", "Страница Facebook", "Группы Facebook"] },
    { title: "Telegram" }, { title: "Первое сообщение в WhatsApp", aliases: ["WhatsApp и шаблоны"] },
    { title: "Расходы по объектам" },
    { title: "Подключение к станции (ARI)", aliases: ["Телефония", "Asterisk", "Станция"] },
    { title: "Управление станцией из CRM (AMI)" }, { title: "Входящие звонки" },
    { title: "Подсказка агенту о звонящем" }, { title: "Нерабочее время" }, { title: "Звуки телефонии" },
    { title: "Передача монтажёру и кросспостинг", aliases: ["Публикации", "Сторис в Facebook"] },
    { title: "YouTube Shorts" }, { title: "TikTok" }, { title: "Threads" },
    { title: "Расписание выхода роликов" }, { title: "Фид каталога для рекламы Meta", aliases: ["Ссылка на фид"] },
    { title: "СМС через Payom", aliases: ["СМС SMS"] },
  ],
  // BotTab: ElevenLabs fields belong to LiveVoiceSection, not to telephony connection.
  bot: [
    { title: "Ключи моделей" }, { title: "Какие модели работают", aliases: ["Модели ИИ"] },
    { title: "Помощник внутри CRM" }, { title: "Рубильник и каналы" },
    { title: "Когда бот пишет" }, { title: "Бот на паузе — если забыли снять" },
    { title: "Как продавать" }, { title: "Промт диалога" }, { title: "Промт ответов на комментарии" },
    { title: "Шаблоны подписи под ролики" }, { title: "Личность живого голоса" },
    { title: "Комментарии под постами Instagram" },
    { title: "Живой голос по телефону", aliases: ["ElevenLabs", "Gemini Live", "Ключ ElevenLabs", "Код агента ElevenLabs"] },
    { title: "Манеры продажи" }, { title: "Тренировка ответов", aliases: ["Обучение бота"] },
    { title: "Бот спрашивает: как отвечать?" }, { title: "Чему бот научился" }, { title: "Куда уходят клиенты" },
  ],
  // SystemTab and the standalone sections explicitly mounted in SettingsTabContent.
  system: [
    { title: "Здоровье системы" }, { title: "Журнал ИИ-ассистента" },
    { title: "Пульт директора", aliases: ["Модули пульта"] },
    { title: "Диалоги без ответа сегодня" },
    { title: "Разбор проблемных мест", aliases: ["Проблемные отчёты", "Проблемные отчеты"] },
    { title: "Подтверждение личности" },
    { title: "Точки возврата настроек", aliases: ["Точки восстановления"] }, { title: "Импорт данных" },
    { title: "Админка сайта royalhome.tj", directorOnly: true },
  ],
};

export function settingsSectionsFor(tab: SettingsTabId, role?: string) {
  return SETTINGS_SECTIONS[tab].filter((section) => !section.directorOnly || role === "DIRECTOR");
}

export function normalizeSettingsSearch(text: string) {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е");
}
