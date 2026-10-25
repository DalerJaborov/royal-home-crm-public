import { parsePermissionOverrides, resolvePermissions } from "@royal-home/shared";
import { createHash, randomUUID } from 'node:crypto';
import { prisma, type TxClient } from '../db.js';
import { mediaRecipientHash } from './mediaExecution.js';
import { fullPhoneIdentity } from './clientPhoneFacts.js';
import { loadExposurePairEvidence } from './exposurePairEvidence.js';
import { checkClientExplainedPause } from '../ai/offCrmPauseCheck.js';
import { recordInvestigationSignal } from './investigationCases.js';
import { assignmentSourceEpochIsCurrent, resolveInvestigationAssignmentEpoch } from './investigationAssignmentEpoch.js';
export const sellerProbeSourcePhoneHash = (clientId: string, phone: string) => mediaRecipientHash(`owner-probe:${clientId}`, fullPhoneIdentity(phone));
export const newOwnerProbeMode = () => process.env.CRM_OWNER_VERIFICATION_EXECUTION_MODE === 'LIVE' ? 'LIVE' : 'PREVIEW';
const key = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
/** Even equal owner/date cannot revive a source after A→B→A. Same-ms source and
 * ownership transition have no trustworthy ordering and are rejected. */
export async function ownerProbeAssignmentCurrent(tx: TxClient, input: {
  clientId: string; subjectAgentId: string | null; assignmentAt: Date; sourceAt: Date | null | undefined; now: Date;
}): Promise<boolean> {
  if (!input.sourceAt || input.sourceAt < input.assignmentAt) return false;
  const transitions = await tx.$queryRaw<Array<{ id: string }>>`SELECT a.id FROM "AuditLog" a
    WHERE a.action='CLIENT_AGENT_CHANGE' AND a."entityType"='Client' AND a."entityId"=${input.clientId}
      AND a."createdAt">=${input.sourceAt} AND a."createdAt"<=${input.now}
      AND (a.meta->>'fromAgentId' IS DISTINCT FROM a.meta->>'toAgentId'
        OR EXISTS (SELECT 1 FROM "ClientWorkflowObservation" o WHERE o.kind='ASSIGNMENT_SNAPSHOT'
          AND o."sourceType"='OWNERSHIP_AUDIT' AND o."sourceId"=a.id AND o."clientId"=${input.clientId})) LIMIT 1`;
  return transitions.length === 0 && assignmentSourceEpochIsCurrent(tx, input);
}
/** Actual creation transaction only: no historical sweep, no external effect. */
export async function scheduleManualOwnerVerification(tx: TxClient, propertyId: string, actorId: string) {
  const property = await tx.property.findUnique({ where: { id: propertyId }, select: {
    id: true, sellerClientId: true, createdById: true, createdAt: true, deletedAt: true,
  } });
  if (!property?.sellerClientId || property.createdById !== actorId || property.deletedAt) return;
  const seller = await tx.client.findUnique({ where: { id: property.sellerClientId }, select: {
    id: true, source: true, phone: true, assignedAt: true, assignedAgentId: true, lastClientMessageAt: true, deletedAt: true,
  } });
  if (!seller || seller.deletedAt || seller.source !== 'WALK_IN' || !seller.phone || seller.lastClientMessageAt || !seller.assignedAgentId) return;
  const verifiedCall = await tx.interaction.findFirst({ where: { clientId: seller.id, investigationOnly: false,
    type: 'CALL', callAttempt: 'TALKED', recordingUrl: { not: null }, recordingDurationSec: { gt: 0 } }, select: { id: true } });
  if (verifiedCall) return;
  const epoch = await resolveInvestigationAssignmentEpoch(tx, { clientId: seller.id, subjectAgentId: seller.assignedAgentId, assignmentAt: seller.assignedAt, at: property.createdAt });
  if (!epoch) return;
  const sourceKey = key('MANUAL_OWNER', property.id, seller.id, epoch);
  await tx.sellerProbeCall.upsert({ where: { sourceKey }, update: {}, create: {
    sourceKind: 'MANUAL_OWNER', sourceId: property.id, sourceKey, anchorAt: property.createdAt,
    assignmentAt: seller.assignedAt, propertyId: property.id, sellerClientId: seller.id, agentId: seller.assignedAgentId,
    previewOnly: true, scheduledFor: property.createdAt,
    sourcePhoneHash: sellerProbeSourcePhoneHash(seller.id, seller.phone), signals: ['manual_owner_number_unverified'],
    evidence: { actorId, propertyCreatedAt: property.createdAt.toISOString(), basis: 'MANUAL_CREATION_NOT_SUSPICION' },
  } });
}
/** Bounded cursor scan: failed/unknown evidence stays unresolved, never becomes a false negative. */
export async function scheduleExposureOwnerVerifications(now = new Date(), afterId?: string, observationStart = now) {
  const rows = await prisma.propertyExposure.findMany({ where: { clientId: { not: null }, propertyId: { not: null },
    sentAt: { gte: new Date(Math.max(observationStart.getTime(), now.getTime() - 30 * 86_400_000)), lte: new Date(now.getTime() - 7 * 86_400_000) },
    ...(afterId ? { id: { gt: afterId } } : {}),
  }, orderBy: { id: 'asc' }, take: 50, select: { id: true } });
  let created = 0;
  for (const row of rows) {
    const before = await loadExposurePairEvidence(row.id, now);
    if (!before || !before.facts.isOffMarket || before.facts.hasNonCancelledDeal || before.facts.reserved
      || before.facts.lastBuyerSpeechAt && before.facts.lastBuyerSpeechAt > before.facts.sentAt) continue;
    if (!await ownerProbeAssignmentCurrent(prisma, { clientId: before.buyer.id, subjectAgentId: before.buyer.assignedAgentId,
      assignmentAt: before.buyer.assignedAt, sourceAt: before.exposure.sentAt, now })) continue;
    const epoch = await resolveInvestigationAssignmentEpoch(prisma, { clientId: before.buyer.id, subjectAgentId: before.buyer.assignedAgentId, assignmentAt: before.buyer.assignedAt, at: now });
    if (!epoch) continue;
    const sourceKey = key('EXPOSURE_PAIR', before.buyer.id, before.property.id, epoch);
    if (await prisma.sellerProbeCall.findUnique({ where: { sourceKey }, select: { id: true } })) continue;
    const pause = await checkClientExplainedPause(before.buyer.id, { since: before.buyer.assignedAt });
    const after = await loadExposurePairEvidence(row.id, now, pause.unchecked ? null : pause.explained);
    if (!after) continue;
    const fingerprint = (data: typeof after) => key(data.exposure, data.buyer, data.seller, data.property,
      data.sourceIds, data.withdrawalSourceId, { ...data.facts, buyerPauseExplained: null });
    if (fingerprint(before) !== fingerprint(after) || !['SUSPECTED', 'UNKNOWN'].includes(after.decision.state)) continue;
    await prisma.$transaction(async tx => {
      for (const id of [after.buyer.id, after.seller.id].sort()) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Property" WHERE id=${after.property.id} FOR UPDATE`;
      const [buyer, seller, property, deal] = await Promise.all([
        tx.client.findUnique({ where: { id: after.buyer.id }, select: { assignedAt: true, assignedAgentId: true, lastClientMessageAt: true, deletedAt: true } }),
        tx.client.findUnique({ where: { id: after.seller.id }, select: { assignedAt: true, phone: true, deletedAt: true } }),
        tx.property.findUnique({ where: { id: after.property.id }, select: { status: true, deletedAt: true, sellerClientId: true } }),
        tx.deal.count({ where: { propertyId: after.property.id, stage: { not: 'CANCELLED' } } }),
      ]);
      if (!buyer || buyer.deletedAt || buyer.assignedAt.getTime() !== after.buyer.assignedAt.getTime()
        || buyer.assignedAgentId !== after.buyer.assignedAgentId || (buyer.lastClientMessageAt?.getTime() ?? 0) !== (after.buyer.lastClientMessageAt?.getTime() ?? 0)
        || !seller || seller.deletedAt || seller.phone !== after.seller.phone || seller.assignedAt.getTime() !== after.seller.assignedAt.getTime()
        || !property || property.sellerClientId !== after.seller.id || property.status !== after.property.status || deal > 0) return;
      if (!await ownerProbeAssignmentCurrent(tx, { clientId: after.buyer.id, subjectAgentId: buyer.assignedAgentId,
        assignmentAt: buyer.assignedAt, sourceAt: after.exposure.sentAt, now })) return;
      await recordInvestigationSignal({ clientId: after.buyer.id, propertyId: after.property.id,
        subjectAgentId: buyer.assignedAgentId, assignmentAt: buyer.assignedAt, sourceType: 'exposure-pair', sourceId: after.exposure.id,
        independenceKey: `exposure:${after.exposure.id}`, kind: after.decision.state === 'UNKNOWN' ? 'assessment_unavailable' : 'off_market_after_sent', occurredAt: now,
        summary: after.decision.state === 'UNKNOWN' ? 'Проверка пары отложена: данных недостаточно либо объяснение клиента пока не проверено. Вывода о молчании и нарушении нет.' : 'Объект отправлен покупателю; подтверждённого ответа после отправки нет, объект снят, сделки в CRM нет. Требуется проверка.',
        payload: { exposureId: after.exposure.id, sentAt: after.exposure.sentAt.toISOString(),
          withdrawalAt: after.facts.leftSaleAt?.toISOString() ?? null, signals: after.decision.signals, reasons: after.decision.reasons, viewed: 'UNKNOWN' },
      }, tx);
      if (!after.decision.mayAskOwner || !seller.phone) return;
      const inserted = await tx.sellerProbeCall.createMany({ data: [{ sourceKind: 'EXPOSURE_PAIR', sourceId: after.exposure.id,
        sourceKey, anchorAt: after.exposure.sentAt, assignmentAt: seller.assignedAt, buyerClientId: after.buyer.id,
        propertyId: after.property.id, sellerClientId: after.seller.id, agentId: after.buyer.assignedAgentId!,
        scheduledFor: now, previewOnly: true, signals: after.decision.signals,
        sourcePhoneHash: sellerProbeSourcePhoneHash(after.seller.id, seller.phone),
        evidence: { buyerAssignedAt: buyer.assignedAt.toISOString(), sourceIds: after.sourceIds,
          withdrawalAt: after.facts.leftSaleAt?.toISOString() ?? null, viewed: 'UNKNOWN' },
      }], skipDuplicates: true });
      created += inserted.count;
    });
  }
  return { created, nextCursor: rows.length === 50 ? rows[rows.length - 1]!.id : null };
}

/** No model/provider call: recheck immutable seed against today's assignment, phone and object. */
export async function ownerVerificationSourceBlock(id: string, now = new Date(), allowPreview = false): Promise<string | null> {
  const row = await prisma.sellerProbeCall.findUnique({ where: { id }, include: { seller: true, property: true } });
  if (!row || !['EXPOSURE_PAIR', 'MANUAL_OWNER'].includes(row.sourceKind)) return 'invalid_source';
  if (!allowPreview && (row.previewOnly || newOwnerProbeMode() !== 'LIVE')) return 'preview_only';
  if (!allowPreview) {
    const stored = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence : {};
    const actor = typeof stored.approvedById === 'string' ? await prisma.agent.findUnique({ where: { id: stored.approvedById }, select: { role: true, isActive: true, permissions: true } }) : null;
    if (!actor?.isActive || !['ADMIN', 'DIRECTOR'].includes(actor.role) || !resolvePermissions(actor.role, parsePermissionOverrides(actor.permissions)).has('clients.securityReview')) return 'approval_no_longer_valid';
  }
  if (!row.assignmentAt || row.seller.assignedAt.getTime() !== row.assignmentAt.getTime()
    || row.seller.deletedAt || row.property.sellerClientId !== row.sellerClientId || !row.seller.phone
    || row.sourcePhoneHash !== sellerProbeSourcePhoneHash(row.sellerClientId, row.seller.phone)) return 'source_changed';
  if (!await ownerProbeAssignmentCurrent(prisma, { clientId: row.sellerClientId, subjectAgentId: row.seller.assignedAgentId,
    assignmentAt: row.assignmentAt, sourceAt: row.anchorAt ?? row.createdAt, now })) return 'assignment_epoch_changed';
  if (row.sourceKind === 'MANUAL_OWNER') {
    if (row.property.deletedAt || ['SOLD', 'WITHDRAWN', 'RESERVED'].includes(row.property.status)) return 'object_no_longer_available';
    if (row.seller.lastClientMessageAt) return 'owner_already_contacted';
    return null;
  }
  if (!row.sourceId || !row.buyerClientId) return 'missing_exposure_source';
  const current = await loadExposurePairEvidence(row.sourceId, now, false);
  const evidence = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence : {};
  if (!current || current.buyer.id !== row.buyerClientId || current.buyer.assignedAgentId !== row.agentId
    || current.buyer.assignedAt.toISOString() !== evidence.buyerAssignedAt || !current.decision.mayAskOwner) return 'pair_evidence_changed';
  if (!await ownerProbeAssignmentCurrent(prisma, { clientId: current.buyer.id, subjectAgentId: row.agentId,
    assignmentAt: current.buyer.assignedAt, sourceAt: row.anchorAt ?? row.createdAt, now })) return 'assignment_epoch_changed';
  return null;
}



/** First activation observes only future events. This never seeds the historical cleanup cohort. */
export async function runExposureOwnerPreviewTick(now = new Date()) {
  const checkpointKey = 'owner-exposure-verification-v1'; // gitleaks:allow -- public workflow checkpoint identifier, not a credential
  const checkpoint = await prisma.workflowCheckpoint.upsert({ where: { key: checkpointKey }, update: {}, create: { key: checkpointKey, createdAt: now } });
  const leaseToken = randomUUID();
  const claimed = await prisma.workflowCheckpoint.updateMany({ where: { key: checkpointKey, revision: checkpoint.revision,
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { leaseToken, leaseUntil: new Date(now.getTime() + 30 * 60_000), revision: { increment: 1 } } });
  if (claimed.count !== 1) return { created: 0, busy: true };
  try {
    const result = await scheduleExposureOwnerVerifications(now, checkpoint.cursor ?? undefined, checkpoint.createdAt);
    await prisma.workflowCheckpoint.updateMany({ where: { key: checkpointKey, leaseToken }, data: {
      cursor: result.nextCursor, leaseToken: null, leaseUntil: null, revision: { increment: 1 },
    } });
    return { created: result.created, busy: false };
  } catch (error) {
    await prisma.workflowCheckpoint.updateMany({ where: { key: checkpointKey, leaseToken }, data: { leaseToken: null, leaseUntil: null, revision: { increment: 1 } } });
    throw error;
  }
}

/** Internal approval boundary. A new LIVE row is made; an old preview is never promoted. */
export async function approveOwnerVerificationExecution(input: { previewId: string; actorId: string; expectedUpdatedAt: Date }, now = new Date()) {
  if (newOwnerProbeMode() !== 'LIVE') throw new Error('Исполнение не включено на сервере');
  const block = await ownerVerificationSourceBlock(input.previewId, now, true);
  if (block) throw new Error('Источник изменился или проверка пока недоступна');
  return prisma.$transaction(async tx => {
    const binding = await tx.sellerProbeCall.findUnique({ where: { id: input.previewId }, select: { sellerClientId: true, buyerClientId: true } });
    if (!binding) throw new Error('Предпросмотр устарел');
    const clientIds = [...new Set([binding.sellerClientId, binding.buyerClientId].filter((value): value is string => !!value))].sort();
    // Same order as scheduling: clients first, then source row.
    for (const clientId of clientIds) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${clientId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "SellerProbeCall" WHERE id=${input.previewId} FOR UPDATE`;
    const [actor, row] = await Promise.all([
      tx.agent.findUnique({ where: { id: input.actorId }, select: { role: true, isActive: true, permissions: true } }),
      tx.sellerProbeCall.findUnique({ where: { id: input.previewId }, include: { seller: true, property: true } }),
    ]);
    if (!actor?.isActive || !['ADMIN', 'DIRECTOR'].includes(actor.role) || !resolvePermissions(actor.role, parsePermissionOverrides(actor.permissions)).has('clients.securityReview')) throw new Error('Недостаточно прав');
    if (!row?.previewOnly || !row.sourceKey || row.status !== 'PENDING' || row.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
      || !row.assignmentAt || row.seller.assignedAt.getTime() !== row.assignmentAt.getTime() || row.seller.deletedAt
      || row.property.sellerClientId !== row.sellerClientId || !row.seller.phone
      || row.sourcePhoneHash !== sellerProbeSourcePhoneHash(row.sellerClientId, row.seller.phone)) throw new Error('Предпросмотр устарел');
    if (row.sellerClientId !== binding.sellerClientId || row.buyerClientId !== binding.buyerClientId) throw new Error('Предпросмотр устарел');
    const owners = await tx.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, assignedAgentId: true, assignedAt: true, phone: true, deletedAt: true } });
    if (owners.length !== clientIds.length || owners.some(owner => owner.deletedAt)) throw new Error('Предпросмотр устарел');
    const currentSeller = owners.find(owner => owner.id === row.sellerClientId)!;
    if (currentSeller.assignedAt.getTime() !== row.assignmentAt.getTime() || !currentSeller.phone
      || row.sourcePhoneHash !== sellerProbeSourcePhoneHash(currentSeller.id, currentSeller.phone)) throw new Error('Предпросмотр устарел');
    for (const owner of owners) if (!await ownerProbeAssignmentCurrent(tx, { clientId: owner.id, subjectAgentId: owner.assignedAgentId,
      assignmentAt: owner.assignedAt, sourceAt: row.anchorAt ?? row.createdAt, now })) throw new Error('Предпросмотр устарел: назначение изменилось');
    const evidence = row.evidence && typeof row.evidence === 'object' && !Array.isArray(row.evidence) ? row.evidence : {};
    const sourceKey = `${row.sourceKey}:execution:LIVE`;
    return tx.sellerProbeCall.upsert({ where: { sourceKey }, update: {}, create: {
      sourceKind: row.sourceKind, sourceId: row.sourceId, sourceKey, anchorAt: row.anchorAt,
      assignmentAt: row.assignmentAt, buyerClientId: row.buyerClientId, propertyId: row.propertyId,
      sellerClientId: row.sellerClientId, agentId: row.agentId, sourcePhoneHash: row.sourcePhoneHash,
      signals: row.signals, scheduledFor: now, previewOnly: false,
      evidence: { ...evidence, previewId: row.id, approvedById: input.actorId, approvedAt: now.toISOString() },
    } });
  });
}


