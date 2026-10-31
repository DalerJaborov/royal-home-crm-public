/**
 * ПОИСК ОБЪЕКТА ПО «ССЫЛКЕ» ЛЮБОГО ВИДА — для ИИ-помощника (П3, группа «read»,
 * 31.10.2026, docs/design/internal-assistant-architecture-2026-10-31.md §3).
 *
 * Агент говорит «ОБ-000088», «88», кидает ссылку на пост Instagram или называет адрес.
 * Один разбор на всё:
 *  - номер карточки — `parseShortCode` (@royal-home/shared), тот же, что у списка
 *    объектов (routes/properties/list.ts) и поиска клиентов;
 *  - ссылка Instagram — по КОДУ поста (`instagramPostCode`, lib/instagramPostLead.ts):
 *    один пост приходит десятком разных ссылок (www, /reel/ и /p/, хвост `?igsh=`);
 *    ищется и в `Property.instagramUrl`, и в фото-постах (PropertyPhotoPost.permalink);
 *  - иначе слова — по названию/адресу, каждое слово должно найтись (`toSearchTokens`).
 *
 * В отличие от `findAgentByInstagramPost` БЕЗ фильтра «в продаже»: проданный или
 * снятый объект находится и показывается со своим статусом. Корзина (`deletedAt`) —
 * скрыта, как у REST-списка.
 *
 * Ссылок Somon в карточке объекта НЕТ (поля в схеме нет): отдельный признак
 * `somonLink`, чтобы помощник честно сказал «в карточке не хранится».
 */
import { parseShortCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { instagramPostCode, instagramPostCodesIn } from "./instagramPostLead.js";
import { toSearchTokens, toTokenVariants } from "./searchTokens.js";

/** То, что нужно карточке-превью и полной карточке помощника. Без вектора embedding. */
export const PROPERTY_REF_INCLUDE = {
  district: { select: { name: true } },
  assignedAgent: { select: { id: true, fullName: true } },
  intakeAgent: { select: { id: true, fullName: true } },
} satisfies Prisma.PropertyInclude;

export type PropertyRefRecord = Prisma.PropertyGetPayload<{
  include: typeof PROPERTY_REF_INCLUDE;
  omit: { embedding: true };
}>;

export type PropertyRefKind = "id" | "shortId" | "instagram" | "text" | "somon" | "empty";

export interface PropertyRefResult {
  kind: PropertyRefKind;
  properties: PropertyRefRecord[];
}

const SOMON_RE = /somon\.tj/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @param ref  что сказал человек
 * @param scope.hideOwnPendingDeleteFor  id автора, чьи объекты с висящей заявкой на
 *   удаление прячем (REST: тому, у кого нет `properties.delete`, — routes/properties/list.ts)
 */
export async function findPropertiesByRef(
  ref: string,
  scope: { hideOwnPendingDeleteFor?: string; limit?: number } = {}
): Promise<PropertyRefResult> {
  const text = ref.trim();
  const limit = Math.min(Math.max(scope.limit ?? 5, 1), 20);
  if (!text) return { kind: "empty", properties: [] };
  if (SOMON_RE.test(text)) return { kind: "somon", properties: [] };

  const base: Prisma.PropertyWhereInput = {
    deletedAt: null,
    ...(scope.hideOwnPendingDeleteFor
      ? { deleteRequests: { none: { status: "PENDING", requestedById: scope.hideOwnPendingDeleteFor } } }
      : {}),
  };
  const load = (where: Prisma.PropertyWhereInput, take = limit) =>
    prisma.property.findMany({
      where: { ...base, ...where },
      include: PROPERTY_REF_INCLUDE,
      omit: { embedding: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
    });

  // 0. Внутренний id (из прежнего ответа find_property).
  if (UUID_RE.test(text)) return { kind: "id", properties: await load({ id: text.toLowerCase() }, 1) };

  // 1. Ссылка Instagram: код поста в карточке (ролик) или в фото-посте (карусель).
  const codes = instagramPostCodesIn(text);
  if (codes.length === 0) {
    const single = instagramPostCode(text);
    if (single) codes.push(single);
  }
  if (codes.length > 0) {
    const photoPosts = await prisma.propertyPhotoPost.findMany({
      where: { channel: "INSTAGRAM", OR: codes.map((c) => ({ permalink: { contains: c } })) },
      select: { propertyId: true },
      take: 20,
    });
    const found = await load({
      OR: [
        ...codes.map((c) => ({ instagramUrl: { contains: c } })),
        ...(photoPosts.length ? [{ id: { in: photoPosts.map((p) => p.propertyId) } }] : []),
      ],
    });
    return { kind: "instagram", properties: found };
  }

  // 2. Номер карточки. «ОБ-000088» с префиксом — только номер; голое «88» — сперва
  // карточка №88, затем объекты со словом «88» в названии/адресу.
  const shortId = parseShortCode(text);
  const hasPrefix = shortId !== null && !/^\d+$/.test(text.trim());
  const exact = shortId !== null ? await load({ shortId }, 1) : [];
  if (hasPrefix) return { kind: "shortId", properties: exact };

  // 3. Слова — название и адрес (описание не трогаем: адрес, а не «евроремонт»).
  const tokens = toSearchTokens(text);
  const byText =
    tokens.length > 0
      ? await load({
          ...(exact[0] ? { id: { not: exact[0].id } } : {}),
          AND: tokens.map((token) => ({
            OR: toTokenVariants(token).flatMap((variant) => [
              { title: { contains: variant, mode: "insensitive" as const } },
              { address: { contains: variant, mode: "insensitive" as const } },
            ]),
          })),
        })
      : [];
  const properties = [...exact, ...byText].slice(0, limit);
  return { kind: exact.length > 0 ? "shortId" : "text", properties };
}

/**
 * РОВНО ОДИН ОБЪЕКТ — для ЗАПИСЫВАЮЩИХ инструментов помощника (группа «prop»).
 * Тот же разбор, что `findPropertiesByRef` (одна реализация на оба случая, сведено
 * при сборке П3), но для записи строже: неоднозначность и «не найден» — понятный
 * отказ со списком кандидатов, выбирать за человека нельзя (изменится не тот объект).
 *  - номер («ОБ-000088» или голое «88») — только карточка с этим номером; нет её —
 *    «не найден», а не объект со словом «88» в адресе;
 *  - слова короче трёх букв — «не найден» (слишком широко для записи);
 *  - Somon — «в карточке не хранится».
 * Корзина не находится; проданный/снятый — находится, инструмент сам скажет, что с ним можно.
 */
export interface PropertyRefCandidate {
  id: string;
  shortId: number;
  title: string;
  address: string | null;
}

export type PropertyRefResolution =
  | { ok: true; id: string; shortId: number }
  | { ok: false; reason: "NOT_FOUND" | "AMBIGUOUS" | "EMPTY"; message: string; candidates: PropertyRefCandidate[] };

/** Предел кандидатов в ответе человеку. */
const CANDIDATES_LIMIT = 5;
const NOT_FOUND_MESSAGE = "Такой объект не найден. Укажите номер ОБ- из карточки.";

export async function resolvePropertyRef(rawRef: string): Promise<PropertyRefResolution> {
  const ref = rawRef.trim();
  if (!ref) return { ok: false, reason: "EMPTY", message: "Укажите номер объекта (например, ОБ-000088).", candidates: [] };
  const notFound = (message = NOT_FOUND_MESSAGE): PropertyRefResolution => ({
    ok: false,
    reason: "NOT_FOUND",
    message,
    candidates: [],
  });

  const found = await findPropertiesByRef(ref, { limit: CANDIDATES_LIMIT });
  if (found.kind === "somon") return notFound("Ссылки Somon в карточке объекта не хранятся — укажите номер ОБ-.");
  if (found.kind === "id" || found.kind === "shortId") {
    const exact = found.properties[0];
    return exact ? { ok: true, id: exact.id, shortId: exact.shortId } : notFound();
  }
  // Номер без такой карточки и слишком короткие слова — не угадываем по адресу.
  if (parseShortCode(ref) !== null || (found.kind === "text" && ref.length < 3)) return notFound();

  const rows = found.properties;
  if (rows.length === 1) return { ok: true, id: rows[0].id, shortId: rows[0].shortId };
  if (rows.length > 1) {
    return {
      ok: false,
      reason: "AMBIGUOUS",
      message: "Подходит несколько объектов — уточните номер ОБ-.",
      candidates: rows.map((p) => ({ id: p.id, shortId: p.shortId, title: p.title, address: p.address })),
    };
  }
  return notFound(found.kind === "instagram" ? "По этой ссылке на Instagram объект в CRM не найден." : NOT_FOUND_MESSAGE);
}
