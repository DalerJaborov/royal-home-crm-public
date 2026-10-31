import { parseShortCode } from "@royal-home/shared";
import { prisma } from "../db.js";
import { instagramPostCodesIn } from "./instagramPostLead.js";

/**
 * КАКОЙ ОБЪЕКТ ИМЕЛ В ВИДУ ЧЕЛОВЕК — ОДНА ФУНКЦИЯ ДЛЯ ЗАПИСЫВАЮЩИХ ИНСТРУМЕНТОВ
 * ИИ-ПОМОЩНИКА (31.10.2026, П3 «prop»).
 *
 * «ОБ-000088», «88», id, ссылка на пост в Instagram или кусок адреса. Для
 * ЗАПИСИ нужен ровно один объект: неоднозначность и «не найден» — понятный
 * отказ со списком кандидатов, выбирать за человека нельзя (изменится не тот
 * объект). Удалённые (Корзина) не находятся. Проданный/снятый находится —
 * инструмент сам скажет, что с ним можно.
 */
export interface PropertyRefCandidate {
  id: string;
  shortId: number;
  title: string;
  address: string | null;
}

export type PropertyRefResult =
  | { ok: true; id: string; shortId: number }
  | { ok: false; reason: "NOT_FOUND" | "AMBIGUOUS" | "EMPTY"; message: string; candidates: PropertyRefCandidate[] };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Предел кандидатов в ответе человеку. */
const CANDIDATES_LIMIT = 5;
const SELECT = { id: true, shortId: true, title: true, address: true } as const;

export async function resolvePropertyRef(rawRef: string): Promise<PropertyRefResult> {
  const ref = rawRef.trim();
  if (!ref) return { ok: false, reason: "EMPTY", message: "Укажите номер объекта (например, ОБ-000088).", candidates: [] };

  const pick = (rows: PropertyRefCandidate[]): PropertyRefResult | null => {
    if (rows.length === 1) return { ok: true, id: rows[0].id, shortId: rows[0].shortId };
    if (rows.length > 1) {
      return {
        ok: false,
        reason: "AMBIGUOUS",
        message: "Подходит несколько объектов — уточните номер ОБ-.",
        candidates: rows.slice(0, CANDIDATES_LIMIT),
      };
    }
    return null;
  };

  if (UUID_RE.test(ref)) {
    const row = await prisma.property.findFirst({ where: { id: ref, deletedAt: null }, select: SELECT });
    return pick(row ? [row] : []) ?? notFound();
  }

  const shortId = parseShortCode(ref);
  if (shortId !== null) {
    const row = await prisma.property.findFirst({ where: { shortId, deletedAt: null }, select: SELECT });
    return pick(row ? [row] : []) ?? notFound();
  }

  const codes = instagramPostCodesIn(ref);
  if (codes.length > 0) {
    const rows = await prisma.property.findMany({
      where: { deletedAt: null, OR: codes.map((c) => ({ instagramUrl: { contains: c } })) },
      select: SELECT,
      take: CANDIDATES_LIMIT + 1,
    });
    return pick(rows) ?? notFound("По этой ссылке на Instagram объект в CRM не найден.");
  }

  if (ref.length < 3) return notFound();
  const rows = await prisma.property.findMany({
    where: { deletedAt: null, OR: [{ address: { contains: ref, mode: "insensitive" } }, { title: { contains: ref, mode: "insensitive" } }] },
    select: SELECT,
    orderBy: { shortId: "desc" },
    take: CANDIDATES_LIMIT + 1,
  });
  return pick(rows) ?? notFound();
}

function notFound(message = "Такой объект не найден. Укажите номер ОБ- из карточки."): PropertyRefResult {
  return { ok: false, reason: "NOT_FOUND", message, candidates: [] };
}
