import { z } from "zod";
import { phoneDigits } from "./tajikPhone.js";

/**
 * ПЕРВОЕ СООБЩЕНИЕ КЛИЕНТУ В WHATSAPP (24.09.2026, просьба владельца).
 *
 * Клиент разрешил написать ему в WhatsApp, но сам первым не пишет (номер
 * агентства не помнит), а свободный текст Meta даёт отправить только в течение
 * суток после его сообщения. Единственный законный способ написать первыми —
 * текст, заранее одобренный Meta («шаблон»). Здесь оба текста целиком: сервер
 * отправляет их в Meta на одобрение и шлёт клиенту, сайт показывает агенту
 * предпросмотр ровно того, что уйдёт. Одно место — чтобы предпросмотр и
 * настоящее сообщение не разошлись ни на букву.
 *
 * Правила Meta к тексту: переменная не может стоять первой или последней,
 * две переменные подряд нельзя, у каждой — пример. Меняешь текст — меняй и
 * имя шаблона: одобренный текст Meta править не даёт, новый уходит на проверку
 * заново.
 */

export const WA_FIRST_CONTACT_LANGUAGE = "ru";

/** Кнопка под сообщением: одно нажатие открывает переписку, печатать не нужно. */
export const WA_FIRST_CONTACT_BUTTON = "Да, присылайте";

export type WaFirstContactTemplateKey = "general" | "property";

export interface WaFirstContactTemplate {
  key: WaFirstContactTemplateKey;
  /** Имя у Meta: латиница, цифры и «_». */
  name: string;
  /** Текст с {{1}}, {{2}} — как его видит Meta. */
  body: string;
  /** Что подставляется вместо {{N}}, по порядку — для экрана настроек. */
  params: string[];
  /** Примеры значений — Meta без них текст не принимает. */
  examples: string[];
}

export const WA_FIRST_CONTACT_TEMPLATES: Record<WaFirstContactTemplateKey, WaFirstContactTemplate> = {
  general: {
    key: "general",
    name: "royalhome_first_contact",
    body:
      "Здравствуйте! Это {{1}}, агентство недвижимости Royal Home. Как договорились, пишу вам в WhatsApp. " +
      "Нажмите кнопку ниже или ответьте на это сообщение, и я пришлю видео, фото и подробности.",
    params: ["имя сотрудника"],
    examples: ["Сурайё"],
  },
  property: {
    key: "property",
    name: "royalhome_first_contact_object",
    body:
      "Здравствуйте! Это {{1}}, агентство недвижимости Royal Home. Как договорились, пишу вам в WhatsApp " +
      "по объекту №{{2}}. Нажмите кнопку ниже или ответьте на это сообщение, и я пришлю видео, фото и подробности.",
    params: ["имя сотрудника", "номер объекта"],
    examples: ["Сурайё", "475"],
  },
};

/** Текст, который увидит клиент, с подставленными значениями. */
export function renderWaFirstContactText(key: WaFirstContactTemplateKey, params: string[]): string {
  return WA_FIRST_CONTACT_TEMPLATES[key].body.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}

/**
 * Номер для WhatsApp: цифры с кодом страны, без плюса.
 *
 * Таджикский номер в любой из трёх записей (с 992, с нулём, девять цифр)
 * приводится к 992XXXXXXXXX. Иностранный принимается как есть, если в нём
 * хватает цифр на код страны — WhatsApp, в отличие от СМС и станции, работает
 * по всему миру. Короче десяти цифр без кода страны — не номер.
 */
export function toWhatsAppRecipient(phone: string | null | undefined): string | null {
  const digits = phoneDigits(phone ?? "");
  if (digits.length === 12 && digits.startsWith("992")) return digits;
  if (digits.length === 10 && digits.startsWith("0")) return `992${digits.slice(1)}`;
  if (digits.length === 9) return `992${digits}`;
  if (digits.length >= 10 && digits.length <= 15 && !digits.startsWith("0")) return digits;
  return null;
}

/** Состояние кнопки «Написать первым в WhatsApp» в карточке клиента. */
export type WaFirstContactState =
  /** Можно отправлять. */
  | "ready"
  /** WhatsApp в CRM не подключён или выключен. */
  | "not_connected"
  /** Тексты ещё не отправлены в Meta на одобрение. */
  | "texts_missing"
  /** Тексты на проверке у Meta. */
  | "texts_pending"
  /** Meta тексты отклонила. */
  | "texts_rejected"
  /** Клиент сам писал в WhatsApp меньше суток назад — одобренный текст не нужен. */
  | "window_open"
  /** Первое сообщение уже ушло недавно, ждём ответа. */
  | "recently_sent"
  /** У клиента нет номера, который годится для WhatsApp. */
  | "no_phone";

export interface WaFirstContactStatus {
  state: WaFirstContactState;
  /** Понятная фраза для агента — что происходит и что делать. */
  hint: string;
  /** Имя сотрудника, которое подставится в текст. */
  agentName: string;
  /** Одобрен ли текст «про объект». Нет — с номером объекта уйдёт общий текст,
   *  а ссылка на объект всё равно придёт клиенту после его ответа. */
  propertyTextReady: boolean;
  /** Последняя отправка этому клиенту, если была. */
  last: {
    sentAt: string;
    status: "SENT" | "DELIVERED" | "READ" | "FAILED" | "REPLIED";
    failReason: string | null;
    propertyShortId: number | null;
    agentName: string | null;
  } | null;
}

export const waFirstContactSendSchema = z.object({
  /** Номер объекта (как в CRM, №475) — если клиент просил про конкретный. */
  propertyShortId: z.number().int().positive().nullable().optional(),
});
export type WaFirstContactSendInput = z.infer<typeof waFirstContactSendSchema>;

/** Статус текста у Meta — то, что показывает раздел в Настройках. */
export type WaTemplateReviewState = "missing" | "pending" | "approved" | "rejected" | "paused" | "disabled";

export interface WaTemplateReview {
  key: WaFirstContactTemplateKey;
  name: string;
  body: string;
  state: WaTemplateReviewState;
  /** Причина отказа словами Meta, если отклонён. */
  reason: string | null;
  /** Категория, которую в итоге дала Meta (от неё зависит цена). */
  category: string | null;
}

export interface WaTemplatesOverview {
  /** WhatsApp подключён и включён. */
  connected: boolean;
  /** CRM знает, в каком кабинете WhatsApp лежат тексты (приходит само с первым сообщением клиента). */
  accountKnown: boolean;
  templates: WaTemplateReview[];
  /** Если запрос к Meta не удался — почему, словами. */
  error: string | null;
}
