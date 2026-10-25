import { buildPropertyDeleteDossiers } from "./propertyDeleteDossier.js";
import { randomUUID } from "node:crypto";
import { PROPERTY_DELETE_REQUEST_REASON_LABELS, type PropertyRemovalInput } from "@royal-home/shared";
import type { TxClient } from "../db.js";
import { recordInvestigationSignal } from "./investigationCases.js";

export async function recordPropertyRemoval(tx: TxClient, input: PropertyRemovalInput & {
  propertyId: string; actorId: string; operation: "trash" | "withdraw"; requestId?: string;
}) {
  const property = await tx.property.findUniqueOrThrow({ where: { id: input.propertyId },
    select: { id: true, createdAt: true, assignedAgentId: true, sellerClientId: true } });
  // sellerClientId is a legacy scalar, not a relation; it may reference a removed card.
  const seller = property.sellerClientId ? await tx.client.findUnique({ where: { id: property.sellerClientId },
    select: { id: true, assignedAt: true, assignedAgentId: true } }) : null;
  const reason = input.removalReason ?? "OTHER";
  const legacy = !input.removalReason;
  const now = new Date();
  const dossier = (await buildPropertyDeleteDossiers([property.id], now, tx)).get(property.id);
  await recordInvestigationSignal({ clientId: seller?.id ?? null, propertyId: property.id,
    subjectAgentId: seller?.assignedAgentId ?? property.assignedAgentId,
    assignmentAt: seller?.assignedAt ?? property.createdAt,
    sourceType: "property-removal", sourceId: input.requestId ?? randomUUID(),
    kind: legacy ? "legacy_reason_missing" : input.operation,
    independenceKey: `manual:${input.actorId}`, occurredAt: now,
    summary: legacy ? "Причина снятия не указана: операция выполнена старым клиентом CRM. Это не признак нарушения."
      : `${PROPERTY_DELETE_REQUEST_REASON_LABELS[reason]}${input.removalComment ? `: ${input.removalComment}` : ""}`,
    payload: { reason, legacyReasonMissing: legacy, operation: input.operation, actorId: input.actorId,
      dossier: dossier ? JSON.parse(JSON.stringify(dossier)) : null },
  }, tx);
}
