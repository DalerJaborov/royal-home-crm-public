import type { Prisma } from "../../generated/prisma/client.js";
import { prisma, type TxClient } from "../../db.js";
import { PROPERTY_DRAFT_TTL_DAYS, type PropertyDraftView } from "@royal-home/shared";
import { DRAFT_MEDIA_ORDER } from "./shared.js";

export const DRAFT_INCLUDE = { media: { orderBy: DRAFT_MEDIA_ORDER } } satisfies Prisma.PropertyDraftInclude;
export type DraftRecord = Prisma.PropertyDraftGetPayload<{ include: typeof DRAFT_INCLUDE }>;
export interface DraftReference { draftId?: string; revision?: number }

export function presentDraftSnapshot(draft: DraftRecord): PropertyDraftView {
  return {
    id: draft.id,
    revision: draft.revision,
    values: (draft.values && typeof draft.values === "object" && !Array.isArray(draft.values) ? draft.values : {}) as PropertyDraftView["values"],
    step: draft.step,
    updatedAt: draft.updatedAt.toISOString(),
    expiresAt: draft.expiresAt.toISOString(),
    media: draft.media.map(({ id, kind, status, uploadKey, filename, contentType, sizeBytes, order, url, thumbUrl }) =>
      ({ id, kind, status, uploadKey, filename, contentType, sizeBytes, order, url, thumbUrl })),
  };
}

export class DraftConflictError extends Error {
  readonly status = 409;
  readonly code = "DRAFT_CONFLICT";
  constructor(readonly current: DraftRecord | null, message = "Черновик изменён или удалён. Обновите его перед продолжением") { super(message); }
  response() {
    return { error: this.message, code: this.code, draft: this.current && !this.current.closedAt ? presentDraftSnapshot(this.current) : null,
      currentRevision: this.current?.revision ?? 0 };
  }
}

/** All instances and the cleanup worker use the same transaction-scoped PostgreSQL lock. */
export async function lockOwnDraft(tx: TxClient, agentId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`property-draft:${agentId}`}, 0))`;
}

export function withDraftLock<T>(agentId: string, action: (tx: TxClient) => Promise<T>, timeout = 30_000): Promise<T> {
  return prisma.$transaction(async (tx) => { await lockOwnDraft(tx, agentId); return action(tx); }, { timeout });
}

export function draftExpiry(): Date { return new Date(Date.now() + PROPERTY_DRAFT_TTL_DAYS * 86400000); }

export function checkDraftReference(draft: DraftRecord | null, reference: DraftReference, allowLegacy = true): asserts draft is DraftRecord {
  if (!draft || draft.closedAt || (reference.draftId !== undefined && reference.draftId !== draft.id) ||
    (reference.revision !== undefined && reference.revision !== draft.revision) ||
    (draft.revision > 0 && !reference.draftId && reference.revision === undefined) ||
    (!allowLegacy && (!reference.draftId || reference.revision === undefined))) throw new DraftConflictError(draft);
}

export async function assertActiveDraft(tx: TxClient, agentId: string, reference: DraftReference, allowLegacy = true): Promise<DraftRecord> {
  const draft = await tx.propertyDraft.findUnique({ where: { agentId }, include: DRAFT_INCLUDE });
  checkDraftReference(draft, reference, allowLegacy);
  return draft;
}

/** Delete only media rows. The retained generation prevents old PUT/START requests from recreating it. */
export async function closeDraftRows(tx: TxClient, draft: DraftRecord): Promise<DraftRecord> {
  await tx.propertyDraftMedia.deleteMany({ where: { draftId: draft.id } });
  return tx.propertyDraft.update({ where: { id: draft.id }, data: { closedAt: new Date(), revision: { increment: 1 }, values: {}, step: 0 }, include: DRAFT_INCLUDE });
}
