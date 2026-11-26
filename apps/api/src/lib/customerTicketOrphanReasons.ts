// Error codes of tickets released by the orphan sweep (customerAgentOrphanClaims.ts).
// Separate tiny module: the inbox consumer reads them without importing the sweep.
// Such a ticket is final — a staff member was already told once; a stale queue
// job that runs it again must neither overwrite the code nor report it twice.
export const CLAIM_ORPHANED_REASON = "claim_orphaned_after_deadline";
export const RECEIVED_ORPHANED_REASON = "received_orphaned_after_deadline";
export const CUSTOMER_TICKET_ORPHAN_REASONS: readonly string[] = [CLAIM_ORPHANED_REASON, RECEIVED_ORPHANED_REASON];
