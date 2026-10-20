/**
 * Prisma-условие «карточка НЕ заполнена» — зеркало isClientCardFilled из
 * @royal-home/shared для выборок джоба напоминаний и дашборда.
 *
 * Почему не переиспользуется сама функция: она работает с уже загруженной записью,
 * а здесь нужно отфильтровать в БД, не поднимая всех клиентов в память. Условие
 * обязано совпадать с функцией — при правке критерия менять оба места.
 */
export const CARD_INCOMPLETE_WHERE = {
  OR: [
    { budgetMin: null, budgetMax: null },
    { desiredDistrictId: null },
    { desiredRooms: null, requirementsNotes: null },
    { desiredRooms: null, requirementsNotes: "" },
  ],
};
