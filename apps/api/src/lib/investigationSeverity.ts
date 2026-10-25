import { prisma } from "../db.js";
import { InvestigationConflict } from "./investigationCases.js";

/** Separate human severity decision: never changes fact status, ownership,
 * legacy review mirror, score or notifications. Historical C4 is not migrated. */
export async function setInvestigationSeverity(input: { caseId: string; actorId: string; requestKey: string; revision: number;
  level: "C1" | "C2" | "C3" | "C4"; note: string; confirmC4?: boolean }) {
  if (input.level === "C4" && input.confirmC4 !== true) throw new InvestigationConflict("Требуется отдельное подтверждение уровня C4");
  return prisma.$transaction(async tx => {
    const identity = await tx.investigationCase.findUnique({ where: { id: input.caseId }, select: { clientId: true } });
    if (identity?.clientId) await tx.$queryRaw`SELECT id FROM "Client" WHERE id=${identity.clientId} FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${input.requestKey}, 0))`;
    await tx.$queryRaw`SELECT id FROM "InvestigationCase" WHERE id=${input.caseId} FOR UPDATE`;
    const previous = await tx.investigationDecision.findUnique({ where: { requestKey: input.requestKey } });
    if (previous) {
      if (previous.caseId !== input.caseId || previous.actorId !== input.actorId || previous.action !== "SET_SEVERITY"
        || previous.level !== input.level || previous.note !== input.note || previous.caseRevision !== input.revision + 1)
        throw new InvestigationConflict("Ключ решения уже использован");
      return previous;
    }
    const current = await tx.investigationCase.findUnique({ where: { id: input.caseId } });
    if (!current || current.revision !== input.revision) throw new InvestigationConflict("Дело изменилось — обновите страницу");
    if (current.status === "CLEARED") throw new InvestigationConflict("Подозрение снято; уровень нельзя повысить без отдельного пересмотра факта");
    if (input.level === "C4" && current.status !== "CONFIRMED") throw new InvestigationConflict("Сначала отдельно подтвердите факт; затем примите решение об уровне C4");
    const changed = await tx.investigationCase.updateMany({ where: { id: input.caseId, revision: input.revision }, data: { level: input.level, revision: { increment: 1 } } });
    if (changed.count !== 1) throw new InvestigationConflict("Дело изменилось — обновите страницу");
    return tx.investigationDecision.create({ data: { caseId: input.caseId, actorId: input.actorId, requestKey: input.requestKey,
      action: "SET_SEVERITY", note: input.note, level: input.level, previousStatus: current.status, newStatus: current.status, caseRevision: current.revision + 1 } });
  });
}
