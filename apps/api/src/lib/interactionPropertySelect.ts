import type { Prisma } from "../generated/prisma/client.js";

/**
 * `Interaction.property` — общий select для хронологии клиента и общей ленты
 * (`GET /clients/:shortId` → `interactions`, `GET /interactions`).
 *
 * 17.09.2026 (docs/match-policy-plan-17-09.md, раздел 6, «Одна функция «Подбор»»,
 * строка «Хронология клиента»): раньше запись хронологии называла объект текстом
 * («Автоподбор: объект №X») без единого способа показать его как карточку — было
 * четыре одинаковые копии `{ id, shortId, title }` в разных роутах, и расширить
 * одну означало вручную найти остальные три. Один объект: мини-карточка объекта
 * в хронологии получает фото и цену, не открывая объект отдельно.
 *
 * thumbUrl — обязательное поле PropertyPhoto (schema.prisma), а не url:
 * превью для списка, не полноразмерный снимок.
 */
export const interactionPropertySelect = {
  id: true,
  shortId: true,
  title: true,
  price: true,
  currency: true,
  photos: { take: 1, orderBy: { order: "asc" }, select: { thumbUrl: true } },
} satisfies Prisma.PropertySelect;
