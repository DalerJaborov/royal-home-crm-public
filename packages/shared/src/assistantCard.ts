/**
 * КАРТОЧКА РЕЗУЛЬТАТА ИИ-ПОМОЩНИКА (SSE-событие `card`).
 *
 * Один договор между сервером (`ai/assistantFastPath.ts`, дальше — инструменты
 * помощника) и панелью на сайте: сервер отдаёт уже готовые к показу поля с учётом
 * ПРАВ вызвавшего (маска телефона, скрытые непринятые заявки), сайт только рисует.
 * Описание лежит здесь, а не в двух местах, чтобы поле нельзя было переименовать
 * на одной стороне (правило «одно правило — одно место»).
 *
 * Денежное поле — число и валюта, форматирует сайт. Ссылка `href` — путь внутри
 * CRM, начинается с «/»: панель открывает её роутером, внешних адресов не бывает.
 */
export type AssistantCardCurrency = "TJS" | "USD";

export interface AssistantPropertyCard {
  kind: "property";
  id: string;
  /** «ОБ-000088» — как номер печатает сама CRM. */
  code: string;
  title: string;
  price: number;
  currency: AssistantCardCurrency;
  status: string;
  district: string | null;
  rooms: number | null;
  areaSqm: number;
  /** Закреплённый агент (ФИО) или null. */
  agent: string | null;
  href: string;
}

export interface AssistantClientCard {
  kind: "client";
  id: string;
  /** «ПК-000042» / «ПР-000042» / «ПО-000042». */
  code: string;
  /** Имя с ролью впереди, номер внутри имени уже замаскирован по правам. */
  name: string;
  /** Телефон в том виде, в каком его вправе видеть вызвавший (маска без права). */
  phone: string;
  status: string;
  agent: string | null;
  /** ISO-время последнего контакта или null. */
  lastContactAt: string | null;
  href: string;
}

export type AssistantCard = AssistantPropertyCard | AssistantClientCard;

/** Сколько последних сообщений истории клиент отправляет помощнику (сервер принимает до 30). */
export const ASSISTANT_HISTORY_WINDOW = 12;
