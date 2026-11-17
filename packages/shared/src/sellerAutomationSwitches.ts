import { z } from "zod";

/**
 * ВЫКЛЮЧАТЕЛИ АВТОМАТИКИ «РАБОТА С ПРОДАВЦАМИ» (владелец 14.11.2026).
 *
 * Владелец хочет иметь возможность остановить из Настроек любую автоматику,
 * которая сама что-то делает с продавцами: тревоги, задачи агенту, звонок
 * робота, сообщения после сделки, разбор ИИ, строки утренней сводки. До этой
 * правки ни у одной из них не было рубильника — выключить можно было только
 * правкой кода.
 *
 * ОДНО МЕСТО ДЛЯ ВСЕГО ПРО ВЫКЛЮЧАТЕЛИ: список полей, схема сохранения (её
 * встраивает в себя PATCH /settings), правило «главный И свой» и подписи для
 * экрана. Сервер (apps/api/src/lib/sellerSwitches.ts) и экран
 * (apps/web/src/pages/settings/SellerAutomationSection.tsx) берут всё отсюда,
 * своих копий списка нет.
 *
 * По умолчанию ВСЁ ВКЛЮЧЕНО (`@default(true)` в базе, `?? true` здесь):
 * выкат миграции не меняет поведение ни на минуту — выключает только человек.
 */

/** Главный выключатель: выключен — выключено всё из списка ниже разом. */
export const SELLER_AUTOMATION_MASTER_KEY = "sellerAutomationMasterEnabled" as const;

/** Свои выключатели, по одному на механизм. Порядок — порядок строк на экране. */
export const SELLER_SWITCH_KEYS = [
  "sellerNoPropertyAlarmEnabled",
  "sellerPropertyMissingAntifraudEnabled",
  "agentUnansweredAlarmEnabled",
  "dealStaleSellersEnabled",
  "sellerProbeCallEnabled",
  "dealAfterCloseMessagesEnabled",
  "sellerAiAnalysisEnabled",
  "morningSellerLinesEnabled",
  "sellerWorkStalledAlarmEnabled",
  "clientPropertyCountAlarmEnabled",
] as const;

export type SellerSwitchKey = (typeof SELLER_SWITCH_KEYS)[number];
export type SellerAutomationSwitchField = typeof SELLER_AUTOMATION_MASTER_KEY | SellerSwitchKey;

/** Все поля Settings этой темы — главный первым. */
export const SELLER_AUTOMATION_FIELDS: readonly SellerAutomationSwitchField[] = [
  SELLER_AUTOMATION_MASTER_KEY,
  ...SELLER_SWITCH_KEYS,
];

/** Как поля лежат в ответе GET /settings (и в строке Settings базы). */
export type SellerAutomationSwitches = Record<SellerAutomationSwitchField, boolean>;

/**
 * Часть схемы PATCH /settings: каждое поле — необязательный boolean. Встраивается
 * в settingsUpdateSchema через `.shape`, а не переписывается там руками.
 */
export const sellerAutomationSwitchesUpdateSchema = z.object(
  Object.fromEntries(SELLER_AUTOMATION_FIELDS.map((key) => [key, z.boolean().optional()])) as Record<
    SellerAutomationSwitchField,
    z.ZodOptional<z.ZodBoolean>
  >
);

/**
 * ДЕЙСТВУЮЩЕЕ ЗНАЧЕНИЕ = главный И свой. Нет строки настроек или поля — включено
 * (то же умолчание, что у колонки в базе).
 */
export function isSellerSwitchOn(
  settings: Partial<Record<SellerAutomationSwitchField, boolean | null | undefined>> | null | undefined,
  key: SellerSwitchKey
): boolean {
  const master = settings?.[SELLER_AUTOMATION_MASTER_KEY] ?? true;
  const own = settings?.[key] ?? true;
  return master && own;
}

export interface SellerSwitchLabel {
  /** Название строки на экране. */
  title: string;
  /** Что происходит, пока выключатель ВКЛЮЧЁН (правило SwitchRow: пояснение — про текущее положение). */
  on: string;
  /** Что происходит, пока выключатель ВЫКЛЮЧЕН. */
  off: string;
}

export const SELLER_AUTOMATION_MASTER_LABEL: SellerSwitchLabel = {
  title: "Вся автоматика по продавцам",
  on: "Система сама следит за продавцами. Каждую часть ниже можно выключить отдельно.",
  off: "Всё, что ниже, остановлено разом. Отдельные выключатели запомнены и вернутся, когда включите.",
};

export const SELLER_SWITCH_LABELS: Record<SellerSwitchKey, SellerSwitchLabel> = {
  sellerNoPropertyAlarmEnabled: {
    title: "Съёмка была, объект не принят",
    on: "Через 2 дня после встречи с продавцом без принятого объекта вам приходит уведомление.",
    off: "Это уведомление не приходит.",
  },
  sellerPropertyMissingAntifraudEnabled: {
    title: "Продавец без объекта — на проверку",
    on: "После срока «Критично» (ниже, «Продавец без объекта») случай уходит в «Контроль руководителя».",
    off: "Случаи на проверку не передаются.",
  },
  agentUnansweredAlarmEnabled: {
    title: "Агент не отвечает продавцу",
    on: "Продавец написал, а агент 2 рабочих дня не ответил — агенту приходит напоминание и задача. Покупателей не касается.",
    off: "По продавцам напоминания нет. По покупателям — как раньше.",
  },
  dealStaleSellersEnabled: {
    title: "Застой: продавец без объекта",
    on: "Продавцу без объекта дольше срока из «Застой сделки» агенту ставится задача. Покупателей не касается.",
    off: "По продавцам задача не ставится. По покупателям — как раньше.",
  },
  sellerProbeCallEnabled: {
    title: "Робот звонит собственнику для проверки",
    on: "Если похоже на сделку в обход, робот звонит собственнику. Работает, только когда включены звонки робота.",
    off: "Робот собственникам не звонит.",
  },
  dealAfterCloseMessagesEnabled: {
    title: "Сообщения после сделки",
    on: "Через 3 дня покупателю и продавцу уходит вопрос «как всё прошло», агенту — уведомление, что его объект продан.",
    off: "Вопрос и уведомление не отправляются. Сделка закрывается и объект снимается с сайта как обычно.",
  },
  sellerAiAnalysisEnabled: {
    title: "ИИ разбирает фото и переписку продавца",
    on: "ИИ оценивает присланные фото и собирает факты об объекте из переписки и звонков.",
    off: "Фото и сообщения принимаются как обычно, но ИИ их не разбирает.",
  },
  morningSellerLinesEnabled: {
    title: "Продавцы в утренней сводке",
    on: "В утренней сводке есть строки «продавцы без объекта дольше недели» и «объект снят из-за потерянного продавца».",
    off: "Этих строк в утренней сводке нет.",
  },
  sellerWorkStalledAlarmEnabled: {
    title: "Работа с продавцом встала",
    on: "Сейчас ничего не присылает: эту рассылку убрали 2 октября. Выключатель на случай, если её вернут.",
    off: "Не проверяется.",
  },
  clientPropertyCountAlarmEnabled: {
    title: "Заявлено объектов больше, чем добавлено",
    on: "Сейчас ничего не присылает: эту рассылку убрали 2 октября. Выключатель на случай, если её вернут.",
    off: "Не проверяется.",
  },
};
