import { clientNameParts, type ClientDisplayNameInput } from "@royal-home/shared";

/**
 * Имя и вторая строка в строке клиента «Нового вида» (пачка D1, ревью PR 331).
 *
 * Имя — из ОБЩЕГО правила `clientNameParts` (@royal-home/shared, решение владельца
 * 21.09: «Имя · Якорь»), а не из сырого fullName: заглушки «Продавец ПР-000388»,
 * «Клиент Instagram» превращаются в «Продавец из WhatsApp». Сервер отдаёт части уже
 * посчитанными (`displayNameParts`, с адресом объекта продавца, которого на клиенте
 * нет); где списка-ответа с ними нет (Корзина и т.п.) — считаем здесь тем же правилом.
 *
 * Вторая строка: у продавца — его якорь (ориентир/адрес объекта: «Джахонгир ·
 * Маяковский»), у покупателя — запрос, который строка и так собирает.
 */
export interface RoyalRowTextInput extends ClientDisplayNameInput {
  displayNameParts?: { name: string; anchor: string | null } | null;
}

export function royalClientRowText(c: RoyalRowTextInput, request: string): { name: string; request: string } {
  const parts = c.displayNameParts ?? clientNameParts(c);
  if (c.kind === "SELLER") return { name: parts.name, request: parts.anchor ?? "Адрес объекта не указан" };
  return { name: parts.name, request };
}
