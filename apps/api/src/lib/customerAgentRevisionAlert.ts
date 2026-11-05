import { prisma } from "../db.js";
import { enqueueDirectorAlert } from "./directorAlertQueue.js";
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
    return;
  }
  await alertDirectorsOnce(revisionId);
}

/**
 * Пуш директору и администратору — один на версию (05.11.2026).
 *
 * Общая рассылка об ошибках убрана владельцем 02.10.2026 как спам, и строка в
 * журнале попадала к нему только утренним отчётом: 03–05.11 бот молчал двое
 * суток во всех каналах ядра (комментарии и директ Instagram, WhatsApp, Facebook),
 * пока владелец не заметил сам. Остановленное ядро — это «теряем клиента», а не
 * шум: тревога уровня CRITICAL со ссылкой прямо на кнопку. Повтор гасит метка за
 * сутки (api и worker проверяют версию при старте оба); отказ очереди ход не роняет.
 */
async function alertDirectorsOnce(revisionId: string): Promise<void> {
  const tag = `customer-agent-held:${revisionId.slice(0, 12)}`;
  try {
    const already = await prisma.pendingDirectorAlert.findFirst({
      where: { tag, createdAt: { gte: new Date(Date.now() - DAY) } }, select: { id: true },
    });
    if (already) return;
    await enqueueDirectorAlert({
      title: "Новый бот остановлен — клиенты без ответа",
      body: "После обновления CRM бот ждёт подтверждения версии. Настройки → Новый бот → «Обновить версию бота».",
      url: "/settings?tab=bot&task=rollout",
      level: "CRITICAL",
      tag,
      recipientRoles: ["DIRECTOR", "ADMIN"],
    });
  } catch {
    // Строка в журнале уже есть; пуш — второй канал, ход из-за него не падает.
  }
}

/** Test seam: the per-process memo is module state. */
export function resetCustomerAgentRevisionAlertMemo(): void { reported.clear(); }
