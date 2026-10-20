/**
 * Правило «что считается ссылкой на видео-обзор» переехало в @royal-home/shared —
 * его читает и экран одобрения материалов, а не только сервер (см. историю там).
 *
 * Файл оставлен реэкспортом: по коду сервера десяток импортов отсюда, и менять их
 * все ради переезда одной функции — лишний риск на ровном месте.
 */
import { INSTAGRAM_LINK_CONTAINS } from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";

export { isInstagramLink, INSTAGRAM_LINK_CONTAINS } from "@royal-home/shared";

/**
 * Условие для запроса в базу: у объекта НЕТ рабочей ссылки на Instagram (пусто, null
 * или ссылка не на instagram.com — например t.me). Парное к `isInstagramLink` для мест,
 * где объекты в памяти не перебрать (05.10.2026: счётчики «ждут публикации», кандидаты
 * на фото-пост). Нужно именно явное `instagramUrl: null`: голое NOT contains по
 * nullable-полю тихо отбрасывает строки с NULL.
 */
export const NO_INSTAGRAM_LINK_WHERE: Prisma.PropertyWhereInput = {
  OR: [
    { instagramUrl: null },
    { instagramUrl: "" },
    { NOT: { instagramUrl: { contains: INSTAGRAM_LINK_CONTAINS, mode: "insensitive" } } },
  ],
};

/** Обратное к `NO_INSTAGRAM_LINK_WHERE`: в карточке есть ссылка на Instagram. */
export const HAS_INSTAGRAM_LINK_WHERE: Prisma.PropertyWhereInput = {
  instagramUrl: { contains: INSTAGRAM_LINK_CONTAINS, mode: "insensitive" },
};
