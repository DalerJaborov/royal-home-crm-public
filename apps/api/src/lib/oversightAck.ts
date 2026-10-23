import { z } from "zod";
import { prisma } from "../db.js";

/**
 * «Принято» по красным флагам «Контроля руководителя» (23.10.2026). Флаги
 * вычисляются на лету в routes/oversight.ts; здесь — только словарь срезов, у
 * которых есть кнопка «Принято», и чтение/запись отметок. Одно место для ключей:
 * его же зовёт Zod роутов, лента `/oversight/flags` и пометка `acked` в срезах.
 */
export const OVERSIGHT_FLAG_SLICES = [
  "stalled-clients",
  "silent-after-showing",
  "refused-high-score",
  "seller-property-missing",
  "endless-negotiations",
] as const;

export type OversightFlagSlice = (typeof OVERSIGHT_FLAG_SLICES)[number];

export const oversightAckBodySchema = z.object({
  sliceKey: z.enum(OVERSIGHT_FLAG_SLICES),
  subjectId: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).optional(),
});

/** Множество принятых subjectId одного среза. Отметок мало (по числу разобранных флагов). */
export async function loadAckedSubjects(sliceKey: OversightFlagSlice): Promise<Set<string>> {
  const rows = await prisma.oversightAck.findMany({ where: { sliceKey }, select: { subjectId: true }, take: 20_000 });
  return new Set(rows.map((r) => r.subjectId));
}

/** Помечает `acked: true` у принятых элементов среза; остальные не трогает, ничего не прячет. */
export async function markAcked<T>(sliceKey: OversightFlagSlice, items: T[], subjectOf: (item: T) => string): Promise<(T | (T & { acked: true }))[]> {
  if (items.length === 0) return items;
  const acked = await loadAckedSubjects(sliceKey);
  if (acked.size === 0) return items;
  return items.map((it) => (acked.has(subjectOf(it)) ? { ...it, acked: true as const } : it));
}
