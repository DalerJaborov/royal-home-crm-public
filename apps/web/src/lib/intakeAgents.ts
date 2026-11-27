/**
 * КТО МОЖЕТ БЫТЬ В «КТО ПРИНЯЛ ОБЪЕКТ» (владелец 27.11.2026, живой кадр с iPhone:
 * в списке мастера стояли директор и учредитель).
 *
 * Одно правило — одно место: его держат и мастер (`property-wizard/StepSeller`), и
 * обычная форма (`PropertyFormModal`). Сервер всё равно отвергает не-агента
 * (`assignableAgentError`, routes/properties/shared.ts), так что лишнее имя в списке
 * не просто «некрасиво» — выбор такого имени кончается отказом при сохранении.
 *
 * Берём только действующих агентов, не замороженных (отпуск, больничный): долю за
 * приём объекта получает тот, кто принял продавца, а не руководство.
 */
export interface IntakeAgentLike {
  id: string;
  role: string;
  isActive: boolean;
  frozenAt?: string | null;
}

export function intakeAgentCandidates<T extends IntakeAgentLike>(agents: readonly T[] | undefined): T[] {
  return (agents ?? []).filter((a) => a.isActive && a.role === "AGENT" && !a.frozenAt);
}
