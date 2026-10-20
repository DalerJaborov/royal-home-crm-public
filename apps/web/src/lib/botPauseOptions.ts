import { dushanbeDayKey } from "@royal-home/shared";

/** Пресеты длительности паузы бота — общие для карточки клиента (ClientDetail)
 *  и инбокса «Сообщения» (Messages), чтобы кнопки были одинаковыми в обоих местах. */
export const PAUSE_OPTIONS = [
  { label: "10 минут", minutesFromNow: () => 10 },
  { label: "20 минут", minutesFromNow: () => 20 },
  { label: "30 минут", minutesFromNow: () => 30 },
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
