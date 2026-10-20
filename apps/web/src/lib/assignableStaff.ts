import type { Role } from "@royal-home/shared";
import { ROLE_LABELS } from "./roles";

/**
 * КОМУ МОЖНО НАЗНАЧИТЬ КЛИЕНТА ВРУЧНУЮ (B13, решение владельца 02.10.2026) —
 * та же граница, что на сервере (apps/api/src/lib/manualAssignTarget.ts):
 * отключённых и замороженных (отпуск, больничный) в списке нет, сервер им не
 * даст. Не агенту (директору, менеджеру) назначить можно — владелец иногда сам
 * ведёт клиентов, — но экран подписывает его «не агент» и переспрашивает.
 */
type Staff = { id: string; fullName: string; role: Role; isActive: boolean; frozenAt?: string | null };

export function assignableStaff<T extends Staff>(list: readonly T[] | undefined): T[] {
  return (list ?? []).filter((a) => a.isActive && !a.frozenAt);
}

export function staffOptionLabel(a: Pick<Staff, "fullName" | "role">): string {
  return a.role === "AGENT" ? a.fullName : `${a.fullName} — ${ROLE_LABELS[a.role]}, не агент`;
}

/** Вопрос перед назначением не агенту; null — переспрашивать не нужно. */
export function notAgentConfirmText(a: Pick<Staff, "fullName" | "role"> | undefined): string | null {
  if (!a || a.role === "AGENT") return null;
  return `Точно назначить клиента: ${a.fullName}? Он(а) не агент (${ROLE_LABELS[a.role]}) — клиент будет в его личном списке.`;
}

/** Подпись под списком, пока выбран не агент. */
export function notAgentWarningText(a: Pick<Staff, "fullName" | "role"> | undefined): string | null {
  if (!a || a.role === "AGENT") return null;
  return `${a.fullName} — ${ROLE_LABELS[a.role].toLowerCase()}, не агент. Назначить можно, если он(а) сам(а) будет вести этого клиента.`;
}
