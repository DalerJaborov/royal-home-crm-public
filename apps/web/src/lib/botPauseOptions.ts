import { dushanbeDayKey } from "@royal-home/shared";

/** Пресеты длительности паузы бота — общие для карточки клиента (ClientDetail)
 *  и инбокса «Сообщения» (Messages), чтобы кнопки были одинаковыми в обоих местах. */
export const PAUSE_OPTIONS = [
  { label: "10 минут", minutesFromNow: () => 10 },
  { label: "20 минут", minutesFromNow: () => 20 },
  { label: "30 минут", minutesFromNow: () => 30 },
  { label: "1 час", minutesFromNow: () => 60 },
  { label: "2 часа", minutesFromNow: () => 120 },
  {
    label: "До конца дня",
    // Конец дня ПО ДУШАНБЕ, а не по часам устройства (F16, 02.10.2026): из
    // Стамбула `setHours(23, 59…)` растягивал паузу до 01:59 следующего дня.
    minutesFromNow: () => {
      const end = new Date(`${dushanbeDayKey(new Date())}T23:59:59.999+05:00`);
      return Math.max(1, Math.round((end.getTime() - Date.now()) / 60000));
    },
  },
  // Бессрочно — не буквально «навсегда», а на 10 лет вперёд: снимается только
  // кнопкой «Вернуть боту», но не оставляет в БД магического null-like значения.
  //
  // ПОСЛЕДНИЙ пресет — он же длительность по умолчанию при ручном ответе (решение
  // владельца 18.08.2026: любой ручной ответ = полная передача диалога агенту), и
  // он обязан совпадать с OPERATOR_REPLY_PAUSE_MS на сервере (lib/conversationDelivery.ts).
  { label: "Бессрочно", minutesFromNow: () => 60 * 24 * 365 * 10 },
] as const;

export function pausedUntilIso(minutesFromNow: number): string {
  return new Date(Date.now() + minutesFromNow * 60000).toISOString();
}

/**
 * СРОК ПАУЗЫ БОТА ПРИ ОТВЕТЕ В НОВОМ ВИДЕ ЧАТА (владелец 26.11.2026: «вернуть выбор срока, по умолчанию час»).
 * Раньше окно слало «Бессрочно» молча, и каждый ответ человека глушил бота навсегда, пока кто-то не вернёт его
 * кнопкой. Теперь по умолчанию час, а последний выбор сотрудника помнит браузер. Хранится ПОДПИСЬ варианта, а не
 * номер: список можно дополнять, а «До конца дня» пересчитывается на момент отправки.
 */
export const DEFAULT_REPLY_PAUSE_LABEL = "1 час";
const REPLY_PAUSE_STORAGE_KEY = "rh.chat.replyPauseLabel";

function optionIndexByLabel(label: string | null | undefined): number {
  return PAUSE_OPTIONS.findIndex((option) => option.label === label);
}

/** Номер варианта для нового вида: запомненный, иначе час. Хранилище может быть закрыто — тогда час. */
export function initialReplyPauseIndex(): number {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(REPLY_PAUSE_STORAGE_KEY);
  } catch {
    /* хранилище закрыто (приватное окно, запрет) — страница работает и без него */
  }
  const found = optionIndexByLabel(stored);
  return found >= 0 ? found : optionIndexByLabel(DEFAULT_REPLY_PAUSE_LABEL);
}

export function rememberReplyPauseIndex(index: number): void {
  const option = PAUSE_OPTIONS[index];
  if (!option) return;
  try {
    window.localStorage.setItem(REPLY_PAUSE_STORAGE_KEY, option.label);
  } catch {
    /* не вышло запомнить — выбор действует до перезагрузки */
  }
}
