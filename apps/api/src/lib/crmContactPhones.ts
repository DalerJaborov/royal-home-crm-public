import type { Request } from "express";
import { can } from "../auth/middleware.js";
import { prisma } from "../db.js";
import { PHONE_TAIL_LEN, phoneTail } from "./clientPhones.js";

/**
 * НОМЕР С ПЛОЩАДКИ, КОТОРЫЙ УЖЕ ЕСТЬ В НАШЕЙ БАЗЕ (владелец 18.11.2026).
 *
 * Номера клиентов, продавцов и собственников видит только директор («кроме
 * директора, ни у кого вообще не будет доступа к номерам телефона вообще»).
 * Номер из публичного объявления Somon/Paydo агенту по-прежнему открыт (решение
 * 02.11.2026) — кроме случая, когда этот же номер записан у нас: контакт
 * владельца любого объекта или ЛЮБОЙ номер карточки клиента (основной, WhatsApp,
 * запасные). Иначе объявление — обходной путь к закрытому номеру: агент видит
 * хвост «•••57» в карточке продавца и полный номер с тем же хвостом в блоке рынка.
 *
 * До 18.11.2026 сверка шла только по `Property.ownerContact` и только для «чужих»
 * объектов: второй номер продавца из его карточки (WhatsApp, запасной) проходил
 * насквозь, а на своём объекте номер не прятался вовсе.
 *
 * Сверка — по последним 9 цифрам (общее правило CRM, lib/clientPhones.ts). Склейку
 * двух номеров в одном ownerContact ловит LIKE по цифрам: лишнее совпадение лишь
 * спрячет номер, а не откроет — для закрытия это безопасная сторона.
 */

/** Может ли сотрудник видеть номера людей из нашей базы — и владельцев, и клиентов. */
export function canSeeCrmContactPhones(req: Pick<Request, "agent">): boolean {
  return can(req, "properties.viewOwners") && can(req, "clients.viewPhone");
}

/** Какие из номеров уже записаны у нас (хвосты по 9 цифр). Один запрос на любой набор. */
export async function crmContactTails(phones: Iterable<string | null | undefined>): Promise<Set<string>> {
  const tails = [...new Set([...phones].map((p) => phoneTail(p ?? "")).filter((t) => t.length === PHONE_TAIL_LEN))];
  if (tails.length === 0) return new Set();
  const rows = await prisma.$queryRaw<Array<{ tail: string }>>`
    SELECT t AS "tail"
    FROM unnest(${tails}::text[]) AS t
    WHERE EXISTS (
        SELECT 1 FROM "Property" p
        WHERE p."ownerContact" IS NOT NULL
          AND regexp_replace(p."ownerContact", '[^0-9]', '', 'g') LIKE '%' || t || '%'
      )
      OR EXISTS (
        SELECT 1 FROM "Client" c
        WHERE right(regexp_replace(coalesce(c."phone", ''), '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = t
          OR right(regexp_replace(coalesce(c."whatsappPhone", ''), '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = t
          OR EXISTS (
            SELECT 1 FROM unnest(coalesce(c."extraPhones", ARRAY[]::text[])) AS x
            WHERE right(regexp_replace(x, '[^0-9]', '', 'g'), ${PHONE_TAIL_LEN}::int) = t
          )
      )`;
  return new Set(rows.map((r) => r.tail));
}

/** Закрыт ли этому сотруднику номер с площадки: он есть у нас, а права на номера нет. */
export async function isHiddenCrmPhone(req: Pick<Request, "agent">, phone: string): Promise<boolean> {
  if (canSeeCrmContactPhones(req)) return false;
  return (await crmContactTails([phone])).size > 0;
}

export const CRM_PHONE_HIDDEN_ERROR = "Этот номер уже есть в CRM. Звоните и пишите из карточки — номер видит только директор";
