/**
 * Что считается ЗАПОЛНЕННОЙ карточкой клиента.
 *
 * Один критерий на всю систему: по нему начисляются KPI-баллы, решается, горячий ли
 * отказной клиент, CRM напоминает агенту дозаполнить карточку, и карточка в браузере
 * показывает предупреждение. Копии этого условия в разных файлах разошлись бы через
 * месяц, и система начала бы противоречить сама себе на глазах у агента.
 *
 * Смысл набора: это ровно те поля, по которым работает подбор объектов. Бюджет —
 * чтобы отсечь неподходящее по цене, район — по географии, комнаты или заметки —
 * чтобы понимать сам запрос. Без них карточка есть, а работать с ней нельзя.
 */
export interface ClientCardFields {
  budgetMin: unknown;
  budgetMax: unknown;
  desiredDistrictId: string | null;
  desiredRooms: number | null;
  requirementsNotes: string | null;
}

export function isClientCardFilled(client: ClientCardFields): boolean {
  return (
    (client.budgetMin != null || client.budgetMax != null) &&
    client.desiredDistrictId != null &&
    (client.desiredRooms != null || (client.requirementsNotes ?? "").trim().length > 0)
  );
}
