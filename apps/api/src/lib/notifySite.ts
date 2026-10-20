import type { ClientStatus } from "@royal-home/shared";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * Notifies the public site when a WEBSITE-sourced client's status changes in
 * the CRM, so the site's own leads list stays in sync. Reuses the existing
 * CRM→site channel (SITE_SYNC_URL/SITE_SYNC_API_KEY — same one siteSync.ts
 * uses for property publish/unpublish) rather than a new secret.
 * Best-effort: a site outage must never fail the status update in the CRM.
 */
const SITE_SYNC_URL = process.env.SITE_SYNC_URL;
const SITE_SYNC_API_KEY = process.env.SITE_SYNC_API_KEY;

/** CRM has 7 granular statuses, the site's own lead tracker only has 3 —
 * collapse the CRM's richer pipeline down to "new / being worked / done". */
const STATUS_TO_SITE: Record<ClientStatus, "new" | "contacted" | "closed"> = {
  NEW: "new",
  CONTACTED: "contacted",
  HOT: "contacted",
  COLD: "contacted",
  UNRESPONSIVE: "contacted",
  // Для сайта «потерянный» — закрытая заявка: работа по ней прекращена, и
  // показывать её как «в работе» значило бы обещать посетителю несуществующее.
  LOST: "closed",
  DEAL_CLOSED: "closed",
  ARCHIVED: "closed",
};

export function notifySiteLeadStatus(crmClientId: string, status: ClientStatus): void {
  if (!SITE_SYNC_URL || !SITE_SYNC_API_KEY) return;

  fetch(`${SITE_SYNC_URL}/lead-status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": SITE_SYNC_API_KEY,
    },
    body: JSON.stringify({ crmClientId, status: STATUS_TO_SITE[status] }),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => {
    // Отказ не роняет смену статуса в CRM — она уже сохранена. Но и молчать нельзя:
    // «Здоровье системы» построено на ErrorLog, и при недоступном сайте оно показывало
    // бы зелёное, пока заявки на сайте тихо расходятся со статусами в CRM. Все прочие
    // необязательные вызовы наружу (Meta, Telegram, R2, курс, siteSync) уже пишут отказ
    // сюда же — этот модуль был единственным исключением.
    void logSystemError("site-sync", `Сайт не уведомлён о смене статуса лида: ${describeError(err)}`);
  });
}
