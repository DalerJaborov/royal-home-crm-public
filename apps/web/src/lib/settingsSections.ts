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
    { title: "Сроки и лимиты по заявкам" }, { title: "Сроки подготовки объекта, дни" },
    { title: "Резерв объекта на сделке" }, { title: "Пауза «не принимаю заявки»", aliases: ["Дисциплина"] },
    { title: "Застой сделки" }, { title: "Светофор неактивных клиентов" },
    { title: "Возврат потерянного или неактивного клиента" }, { title: "Продавец без объекта" },
    { title: "Покупатель думает (медленный трек)" },
  ],
  leads: [
    { title: "Свой объект: свой клиент", aliases: ["Распределение клиентов"] },
    { title: "Занятость агента в раздаче" }, { title: "Передача как признак конфликта" },
    { title: "Уведомления", aliases: ["Напоминания о показах"] },
    { title: "Когда агент уходит из компании" }, { title: "Реактивация старых клиентов" },
  ],
  matching: [
    { title: "Автоподбор" }, { title: "Допуски совпадения" },
    { title: "Радиус по карте" }, { title: "Отложенные клиенты" },
  ],
  team: [
    { title: "Люди", aliases: ["Сотрудники и права"] }, { title: "Распределение заявок" },
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
    { title: "Ключи моделей" },
    { title: "Помощник внутри CRM" }, { title: "Рубильник и каналы" },
    { title: "Когда бот пишет" }, { title: "Бот на паузе — если забыли снять" },
    { title: "Как продавать" }, { title: "Промт диалога" }, { title: "Промт ответов на комментарии" },
    { title: "Шаблоны подписи под ролики" }, { title: "Личность живого голоса" },
    { title: "Комментарии под постами Instagram" },
    { title: "Живой голос по телефону", aliases: ["ElevenLabs", "Gemini Live", "Ключ ElevenLabs", "Код агента ElevenLabs", "Потолок минут робота", "Расход робота"] },
    { title: "Манеры продажи" }, { title: "Тренировка ответов", aliases: ["Обучение бота"] },
    { title: "Бот спрашивает: как отвечать?" }, { title: "Чему бот научился" }, { title: "Куда уходят клиенты" },
  ],
  // SystemTab and the standalone sections explicitly mounted in SettingsTabContent.
  system: [
    { title: "Здоровье системы" }, { title: "Журнал ИИ-ассистента" },
    { title: "Пульт директора", aliases: ["Модули пульта"] },
    { title: "Диалоги без ответа сегодня" },
    { title: "Разбор проблемных мест", aliases: ["Проблемные отчёты", "Проблемные отчеты"] },
    { title: "Вход по отпечатку или лицу" },
    { title: "Точки возврата настроек", aliases: ["Точки восстановления"] }, { title: "Импорт данных" },
    { title: "Админка сайта royalhome.tj", directorOnly: true },
  ],
};

export function settingsSectionsFor(tab: SettingsTabId, role?: string) {
  return SETTINGS_SECTIONS[tab].filter((section) => !section.directorOnly || role === "DIRECTOR");
}

/**
 * Поиск по настройкам понимает старое слово: «лиды», «лидов» находят то же, что «заявки», «заявок» (владелец 20.11.2026: слово
 * «лид» из экранов убрано, но привычка осталась). И запрос, и текст приводятся к одной основе «заявк».
 */
// Без «взгляда назад» (Safari до 16.4 его не понимает): начало слова ловим группой и возвращаем её обратно.
const OLD_WORD = new RegExp("(^|[^а-яё])ли" + "д(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?![а-яё])", "g");
export function normalizeSettingsSearch(text: string) {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(OLD_WORD, "$1заявк").replace(/заявок/g, "заявк");
}
