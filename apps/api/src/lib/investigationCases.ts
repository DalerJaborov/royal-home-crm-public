import { createHash, randomUUID } from "node:crypto";
import { prisma, type TxClient } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import { investigationEpochIsCurrent, resolveInvestigationAssignmentEpoch } from "./investigationAssignmentEpoch.js";

export type InvestigationStatus = "OPEN" | "REVIEWING" | "CLEARED" | "CONFIRMED";
export class InvestigationConflict extends Error {}

export interface InvestigationSignal {
  clientId: string | null;
  propertyId?: string | null;
  showingId?: string | null;
  subjectAgentId?: string | null;
  assignmentAt: Date;
  sourceType: string;
  sourceId: string;
  kind: string;
  independenceKey: string;
  summary: string;
  occurredAt: Date;
  payload?: Prisma.InputJsonValue;
}

export function investigationCaseKey(signal: Pick<InvestigationSignal, "clientId" | "propertyId" | "showingId" | "subjectAgentId" | "assignmentAt"> & { assignmentEpochKey?: string | null }): string {
  const identity = [signal.clientId, signal.propertyId ?? null, signal.showingId ?? null, signal.subjectAgentId ?? null, signal.assignmentAt.toISOString()];
  if (signal.assignmentEpochKey != null) identity.push(signal.assignmentEpochKey);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** Merge can move the readable link, never the original assignment identity. */
export function investigationCaseHasOriginalClient(row: { caseKey: string; clientId: string | null; propertyId: string | null; showingId: string | null; subjectAgentId: string | null; assignmentAt: Date | null; assignmentEpochKey?: string | null }): boolean {
  return !!row.clientId && !!row.assignmentAt && row.caseKey === investigationCaseKey({ ...row, assignmentAt: row.assignmentAt });
}

/** Called only for newly recorded private evidence. Never scans historical records or sends alerts. */
export async function recordInvestigationSignal(signal: InvestigationSignal, tx?: TxClient): Promise<{ caseId: string; inserted: boolean; reopened: boolean }> {
  if (!tx) return prisma.$transaction(inner => recordInvestigationSignal(signal, inner));
  if (signal.clientId) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${signal.clientId} FOR UPDATE`;
  const resolvedEpoch = signal.clientId ? await resolveInvestigationAssignmentEpoch(tx, { clientId: signal.clientId,
    subjectAgentId: signal.subjectAgentId ?? null, assignmentAt: signal.assignmentAt, at: signal.occurredAt }) : null;
  const assignmentEpochKey = resolvedEpoch ?? `UNKNOWN:${signal.sourceType}:${signal.sourceId}`;
  const caseKey = investigationCaseKey({ ...signal, assignmentEpochKey });
  const row = await tx.investigationCase.upsert({ where: { caseKey }, update: {}, create: {
    caseKey, clientId: signal.clientId, propertyId: signal.propertyId ?? null, showingId: signal.showingId ?? null,
    subjectAgentId: signal.subjectAgentId ?? null, title: "Проверка обстоятельств работы с клиентом",
    assignmentAt: signal.assignmentAt, assignmentEpochKey,
    source: signal.sourceType, firstOccurredAt: signal.occurredAt, lastSignalAt: signal.occurredAt,
  } });
  await tx.$queryRaw`SELECT id FROM "InvestigationCase" WHERE id=${row.id} FOR UPDATE`;
  const current = await tx.investigationCase.findUniqueOrThrow({ where: { id: row.id } });
  const priorIndependent = await tx.investigationEvidence.findFirst({
    where: { caseId: row.id, independenceKey: signal.independenceKey }, select: { id: true },
  });
  const inserted = await tx.investigationEvidence.createMany({ data: [{
    caseId: row.id, sourceType: signal.sourceType, sourceId: signal.sourceId, kind: signal.kind,
    independenceKey: signal.independenceKey, summary: signal.summary, occurredAt: signal.occurredAt,
    ...(signal.payload !== undefined ? { payload: signal.payload } : {}),
  }], skipDuplicates: true });
  if (!inserted.count) return { caseId: row.id, inserted: false, reopened: false };
  const reopened = current.status === "CLEARED" && current.resolvedAt !== null
    && signal.occurredAt > current.resolvedAt && !priorIndependent;
  await tx.investigationCase.update({ where: { id: row.id }, data: {
    revision: { increment: 1 },
    lastSignalAt: signal.occurredAt > current.lastSignalAt ? signal.occurredAt : current.lastSignalAt,
    ...(reopened ? { status: "OPEN", level: "C1", resolvedAt: null } : {}),
  } });
  return { caseId: row.id, inserted: true, reopened };
}

export async function decideInvestigation(input: {
  caseId: string; actorId: string; requestKey: string; revision: number; status: InvestigationStatus; note: string; level?: "C1" | "C2" | "C3";
}) {
  return prisma.$transaction(async tx => {
    const identity = await tx.investigationCase.findUnique({ where: { id: input.caseId }, select: { clientId: true } });
    if (identity?.clientId) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${identity.clientId} FOR UPDATE`;
    // Serialize a request key even when accidentally submitted against two different cases.
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${input.requestKey}, 0))`;
    await tx.$queryRaw`SELECT id FROM "InvestigationCase" WHERE id=${input.caseId} FOR UPDATE`;
    const previous = await tx.investigationDecision.findUnique({ where: { requestKey: input.requestKey } });
    if (previous) {
      if (previous.caseId !== input.caseId || previous.actorId !== input.actorId || previous.action !== input.status
        || previous.note !== input.note || (input.level !== undefined && previous.level !== input.level)
        || (input.status === "CLEARED" && previous.level !== "C0") || previous.caseRevision !== input.revision + 1) throw new InvestigationConflict("Ключ решения уже использован");
      return { ...previous, mirrorWarning: "Повторное решение: синхронизация карточки заново не выполнялась." };
    }
    const current = await tx.investigationCase.findUnique({ where: { id: input.caseId } });
    if (!current || current.revision !== input.revision) throw new InvestigationConflict("Дело изменилось — обновите страницу");
    const level = input.status === "CLEARED" ? "C0" : input.level ?? current.level;
    const changed = await tx.investigationCase.updateMany({ where: { id: input.caseId, revision: input.revision }, data: {
      status: input.status, level, revision: { increment: 1 },
      resolvedAt: input.status === "CLEARED" || input.status === "CONFIRMED" ? new Date() : null,
    } });
    if (changed.count !== 1) throw new InvestigationConflict("Дело изменилось — обновите страницу");
    const decision = await tx.investigationDecision.create({ data: {
      caseId: input.caseId, actorId: input.actorId, requestKey: input.requestKey, action: input.status,
      note: input.note, level, previousStatus: current.status, newStatus: input.status, caseRevision: input.revision + 1,
    } });
    let mirrorWarning: string | null = null;
    if (input.status === "CLEARED" || input.status === "CONFIRMED") {
      const client = current.clientId ? await tx.client.findUnique({ where: { id: current.clientId } }) : null;
      if (!client || !investigationCaseHasOriginalClient(current) || !current.assignmentAt || client.assignedAt.getTime() !== current.assignmentAt.getTime()
        || client.assignedAgentId !== current.subjectAgentId || !await investigationEpochIsCurrent(tx, current)) mirrorWarning = "Решение сохранено в деле. Назначение клиента изменилось или неизвестно; карточка клиента не изменена.";
      else if (client.securityReview !== "PENDING") mirrorWarning = "Решение сохранено в деле. Карточка не ожидает проверки либо уже имеет отдельный итог; её состояние не перезаписано.";
      else if (input.status === "CLEARED" && (await tx.investigationCase.findMany({ where: { clientId: client.id,
        assignmentAt: current.assignmentAt, assignmentEpochKey: current.assignmentEpochKey, subjectAgentId: current.subjectAgentId, status: { in: ["OPEN", "REVIEWING"] } } })).some(investigationCaseHasOriginalClient)) {
        mirrorWarning = "Решение сохранено. По текущему назначению остаются другие открытые дела; проверка карточки продолжается.";
      } else await tx.client.update({ where: { id: client.id }, data: { securityReview: input.status,
        securityReviewedAt: new Date(), securityReviewedById: input.actorId, securityNote: input.note } });
    }
    return { ...decision, mirrorWarning };
  });
}

/** Caller holds Client lock and has validated the legacy human verdict. Never opens a new case. */
export async function syncLegacyInvestigationVerdict(tx: TxClient, input: {
  clientId: string; assignmentAt: Date; subjectAgentId: string | null; actorId: string; verdict: "CLEARED" | "CONFIRMED"; note: string;
}) {
  const rows = await tx.investigationCase.findMany({ where: { clientId: input.clientId, assignmentAt: input.assignmentAt,
    subjectAgentId: input.subjectAgentId, status: { in: ["OPEN", "REVIEWING"] } }, orderBy: { id: "asc" } });
  for (const row of rows) {
    await tx.$queryRaw`SELECT id FROM "InvestigationCase" WHERE id=${row.id} FOR UPDATE`;
    const current = await tx.investigationCase.findUniqueOrThrow({ where: { id: row.id } });
    if (!investigationCaseHasOriginalClient(current) || !await investigationEpochIsCurrent(tx, current) || (current.status !== "OPEN" && current.status !== "REVIEWING")) continue;
    const level = input.verdict === "CLEARED" ? "C0" : current.level;
    await tx.investigationCase.update({ where: { id: row.id }, data: { status: input.verdict, level, revision: { increment: 1 }, resolvedAt: new Date() } });
    await tx.investigationDecision.create({ data: { caseId: row.id, requestKey: randomUUID(), actorId: input.actorId,
      action: input.verdict, note: input.note, previousStatus: current.status, newStatus: input.verdict, level, caseRevision: current.revision + 1 } });
  }
}
