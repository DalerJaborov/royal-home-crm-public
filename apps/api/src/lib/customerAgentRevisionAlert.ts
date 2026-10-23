import { logSystemError } from "./systemError.js";

/** A stale core stays silent in every connected dialog until an administrator
 * presses «Обновить версию бота», so the stop must be loud. One journal line per
 * revision per process (this set) plus a long DB dedup window across processes
 * and restarts; the model/provider never see this path and nothing here refreshes
 * the revision — the manual refresh is a deliberate decision. */
const reported = new Set<string>();
const DAY = 24 * 60 * 60_000;

export type CustomerAgentRevisionHeldReason = "current_artifact_revision_mismatch" | "current_artifact_verification_unavailable";

/** Error text only, never the stack or provider/customer data; bounded. */
function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).replace(/\s+/g, " ").slice(0, 200);
}

export async function reportCustomerAgentRevisionHeld(revisionId: string, reason: CustomerAgentRevisionHeldReason, error?: unknown): Promise<void> {
  const key = `${reason}:${revisionId}`;
  if (reported.has(key)) return;
  reported.add(key);
  const short = revisionId.slice(0, 12);
  const message = reason === "current_artifact_revision_mismatch"
    ? `Ядро нового бота остановлено: установленный код не совпадает с активной версией ${short}. Откройте Настройки → Новый бот → «Обновить версию бота». Пока это не сделано, бот не отвечает в подключённых диалогах`
    : `Ядро нового бота остановлено: не удалось проверить установленный код против активной версии ${short} (${errorText(error)}). Откройте Настройки → Новый бот → «Обновить версию бота». Пока это не сделано, бот не отвечает в подключённых диалогах`;
  try {
    await logSystemError("ai", message, { dedupKey: `customer-agent-revision-held:${revisionId}`, dedupWindowMs: DAY });
  } catch {
    // The journal itself must never turn a held turn into an exception.
    reported.delete(key);
  }
}

/** Test seam: the per-process memo is module state. */
export function resetCustomerAgentRevisionAlertMemo(): void { reported.clear(); }
