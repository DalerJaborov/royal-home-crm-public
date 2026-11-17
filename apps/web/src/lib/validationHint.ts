/**
 * «НЕВЕРНЫЕ ДАННЫЕ» — С НАЗВАНИЕМ ПОЛЯ (17.11.2026, аудит F3-4).
 *
 * На любую ошибку проверки сервер отвечает `{ error: "Неверные данные", details:
 * err.flatten() }` (apps/api/src/app.ts, общий обработчик ZodError), а сайт
 * читал только `error`: форма не сохранялась, сверху «Неверные данные» — какое
 * поле исправить, не сказано. Формы проверяют руками не всё, что проверяет
 * общая схема (пример: целые положительные «комнат» и «площадь от», этажи 0–200).
 *
 * Одно место на все формы: `api()` дописывает к тексту ошибки 400 подписи полей
 * из `details.fieldErrors`. Поле без подписи в словаре не называем вовсе —
 * английское имя из кода человеку не поможет.
 */
const FIELD_LABELS: Record<string, string> = {
  fullName: "Имя",
  lastName: "Фамилия",
  phone: "Телефон",
  whatsappPhone: "WhatsApp",
  extraPhones: "Дополнительные телефоны",
  email: "Почта",
  budgetMin: "Бюджет от",
  budgetMax: "Бюджет до",
  desiredRooms: "Комнат",
  desiredAreaMin: "Площадь от",
  desiredFloorMin: "Этаж от",
  desiredFloorMax: "Этаж до",
  desiredTotalFloors: "Этажей в доме",
  address: "Адрес",
  title: "Название",
  description: "Описание",
  price: "Цена",
  areaSqm: "Площадь",
  rooms: "Комнат",
  floor: "Этаж",
  totalFloors: "Этажей в доме",
  soldPrice: "Цена продажи",
  commissionRealtorAmount: "Комиссия агента",
  commissionCompanyAmount: "Комиссия агентства",
  nextActionDate: "Дата",
  text: "Текст",
};

export function withFieldHint(message: string, data: unknown): string {
  const fieldErrors = (data as { details?: { fieldErrors?: unknown } } | null | undefined)?.details?.fieldErrors;
  if (!fieldErrors || typeof fieldErrors !== "object") return message;
  const labels = [...new Set(Object.keys(fieldErrors).map((key) => FIELD_LABELS[key]).filter(Boolean))];
  if (labels.length === 0) return message;
  const base = message.replace(/[.\s]+$/, "");
  return `${base}. Проверьте ${labels.length === 1 ? "поле" : "поля"}: ${labels.slice(0, 3).join(", ")}`;
}
