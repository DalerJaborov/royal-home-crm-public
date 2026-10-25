import { createHash, randomUUID } from "node:crypto";
import { confirmedClientIntents, type SellerControlCommand } from "@royal-home/shared";
import { prisma, type TxClient } from "../db.js";
import { classifySellerInventory } from "./sellerControlPreview.js";
import { planSellerControl, readSellerControlConfig } from "./sellerControlMachine.js";
import { addAlarmWorkingDays } from "./alarmCalendar.js";
import { logTimeline } from "./timeline.js";
import { recordSellerControlDirectorNotice } from "./investigationNotifications.js";
import { assignmentSourceEpochIsCurrent, resolveInvestigationAssignmentEpoch } from "./investigationAssignmentEpoch.js";
import { buyerCandidateControlFacts, buyerCandidateLiveEnabled, newBuyerCandidateMode } from "./buyerCandidateControl.js";
import { newSellerIntakeMode } from "./sellerIntakeExecution.js";
import { applyControlAvailability, controlRecipientAvailable } from "./sellerControlAvailability.js";

export class SellerControlConflict extends Error {}
const neutralTask = "Уточните план работы с клиентом и дополните сведения об объектах";
async function facts(tx: TxClient, clientId: string) {
  const client = await tx.client.findUniqueOrThrow({ where: { id: clientId } });
  const properties = await tx.property.findMany({ where: { sellerClientId: clientId, deletedAt: null }, select: { status: true } });
  return { client, inventory: classifySellerInventory({ expected: client.sellerDeclaredPropertyCount,
    declaredAt: client.sellerDeclaredPropertyCountAt, assignedAt: client.assignedAt, statuses: properties.map(p => p.status) }) };
}
function currentSeller(client: Awaited<ReturnType<typeof facts>>["client"]) {
  return !client.deletedAt && !client.assignmentCompletedAt && client.workStatus === "ACTIVE"
    && !["LOST", "ARCHIVED", "DEAL_CLOSED"].includes(client.status) && confirmedClientIntents(client).sells;
}
async function context(tx: TxClient, recipientId?: string | null) {
  // Fail closed on database/calendar failure, never fabricate a shorter deadline.
  const settings = await tx.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { sellerControlConfig: true, companyDaysOff: true } });
  const recipient = recipientId ? await tx.agent.findUnique({ where: { id: recipientId }, select: { weeklyDaysOff: true } }) : null;
  return { config: readSellerControlConfig(settings.sellerControlConfig), calendar: { companyDaysOff: settings.companyDaysOff, agentDaysOff: recipient?.weeklyDaysOff ?? [] } };
}
/** Only an explicit selected current card starts an episode. No historical sweep. */
export async function startSellerControl(input: { clientId: string; ropAgentId: string; actorId: string | null; requestKey: string; live?: boolean; buyerCandidateId?: string; candidateRevision?: number; sellerIntakeEvidenceId?: string }, now = new Date()) {
  const live = input.live === true;
  if (live && process.env.SELLER_CONTROL_INTERNAL_LIVE !== "explicitly-approved") throw new SellerControlConflict("Исполнение не включено");
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${input.clientId} FOR UPDATE`;
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${input.requestKey}, 0))`;
    const replay = await tx.sellerControlEvent.findUnique({ where: { requestKey: input.requestKey } });
    if (replay) {
      const prior = await tx.sellerControlEpisode.findUniqueOrThrow({ where: { id: replay.episodeId } });
      const payload = replay.payload as { candidateRevision?: number | null };
      if (replay.actorId !== input.actorId || prior.clientId !== input.clientId || prior.ropAgentId !== input.ropAgentId
        || prior.buyerCandidateId !== (input.buyerCandidateId ?? null) || prior.executionMode !== (live ? "LIVE" : "PREVIEW")
        || prior.sellerIntakeEvidenceId !== (input.sellerIntakeEvidenceId ?? null)
        || !["STARTED", "SIMULATED_STARTED"].includes(replay.type) || (payload.candidateRevision ?? null) !== (input.candidateRevision ?? null))
        throw new SellerControlConflict("Ключ запроса уже использован");
      return prior;
    }
    const { client, inventory } = await facts(tx, input.clientId);
    const { config, calendar } = await context(tx, client.assignedAgentId);
    if (!config) throw new SellerControlConflict("NOT_CONFIGURED");
    const buyer = input.buyerCandidateId ? await buyerCandidateControlFacts(tx, input.buyerCandidateId, now) : null;
    if (buyer) {
      if (!live || !buyerCandidateLiveEnabled() || buyer.candidate.executionMode !== "LIVE" || !buyer.candidate.sourceOccurredAt
        || newBuyerCandidateMode(buyer.candidate.sourceOccurredAt) !== "LIVE") throw new SellerControlConflict("Реальное исполнение кандидата не разрешено");
      if (buyer.candidate.clientId !== client.id || !buyer.current || buyer.inventory !== "MISSING"
        || buyer.candidate.reviewDueAt > now
        || buyer.candidate.status !== "OPEN" || buyer.candidate.revision !== input.candidateRevision || !config.buyerCandidateFollowupWorkingDays)
        throw new SellerControlConflict("Договорённость изменилась или повторный срок не настроен");
    } else if (!currentSeller(client) || !client.assignedAgentId || inventory.state !== "MISSING") throw new SellerControlConflict("Нет подтверждённого текущего недостатка объектов");
    const intake = input.sellerIntakeEvidenceId ? await tx.sellerIntakeAppointmentEvidence.findUniqueOrThrow({ where: { id: input.sellerIntakeEvidenceId } }) : null;
    if (intake) {
      const owner = client.assignedAgentId ? await tx.agent.findUnique({ where: { id: client.assignedAgentId }, select: { isActive: true, absenceUntil: true } }) : null;
      if (buyer || !live || intake.executionMode !== "LIVE" || newSellerIntakeMode(intake.sourceOccurredAt) !== "LIVE"
        || !owner?.isActive || (owner.absenceUntil && owner.absenceUntil > now)
        || intake.clientId !== client.id || intake.agentId !== client.assignedAgentId || !client.acceptedAt || client.assignmentRefusedAt
        || intake.assignmentAt.getTime() !== client.assignedAt.getTime()
        || addAlarmWorkingDays(intake.proposedAt, config.agentDueWorkingDays, calendar) > now
        || !await assignmentSourceEpochIsCurrent(tx, { clientId: client.id, subjectAgentId: intake.agentId,
          assignmentAt: intake.assignmentAt, sourceAt: intake.sourceOccurredAt, now })) throw new SellerControlConflict("Приёмка ещё не требует текущей рабочей задачи");
      const latest = await tx.sellerIntakeAppointmentEvidence.findMany({ where: { clientId: client.id, agentId: intake.agentId,
        assignmentAt: intake.assignmentAt }, orderBy: { sourceOccurredAt: "desc" }, take: 2 });
      if (latest[0]?.id !== intake.id || (latest[1] && latest[1].sourceOccurredAt.getTime() === intake.sourceOccurredAt.getTime()))
        throw new SellerControlConflict("Дата приёмки обновлена или неоднозначна");
      const prior = await tx.sellerControlEpisode.findMany({ where: { clientId: client.id, agentId: client.assignedAgentId!,
        assignmentAt: client.assignedAt, buyerCandidateId: null, executionMode: "LIVE" } });
      for (const old of prior) {
        if (!await assignmentSourceEpochIsCurrent(tx, { clientId: client.id, subjectAgentId: old.agentId,
          assignmentAt: old.assignmentAt, sourceAt: old.createdAt, now })) continue;
        if (!["CANCELLED", "RESOLVED"].includes(old.status)) {
          await tx.sellerIntakeAppointmentEvidence.update({ where: { id: intake.id }, data: { controlEpisodeId: old.id } });
          return old;
        }
        if (old.resolvedAt && intake.sourceOccurredAt <= old.resolvedAt) {
          const rescheduled = await tx.sellerControlEvent.findFirst({ where: { episodeId: old.id, type: "SOURCE_RESCHEDULED",
            payload: { path: ["replacementSourceId"], equals: intake.id } }, select: { id: true } });
          if (!rescheduled) throw new SellerControlConflict("Предыдущая работа закрыта; требуется новая договорённость");
        }
      }
    }
    if (!buyer && !intake && live) {
      const active = await tx.sellerControlEpisode.findMany({ where: { clientId: client.id, agentId: client.assignedAgentId!,
        assignmentAt: client.assignedAt, executionMode: "LIVE", buyerCandidateId: null, status: { in: ["AGENT_TASK", "ROP_RECEIPT", "ROP_ACTION", "DIRECTOR"] } } });
      for (const episode of active) if (await assignmentSourceEpochIsCurrent(tx, { clientId: client.id, subjectAgentId: episode.agentId,
        assignmentAt: episode.assignmentAt, sourceAt: episode.createdAt, now })) {
        if (episode.ropAgentId !== input.ropAgentId) throw new SellerControlConflict("Рабочий эпизод уже назначен руководителю");
        return episode;
      }
    }
    const rop = await tx.agent.findUnique({ where: { id: input.ropAgentId }, select: { role: true, isActive: true, frozenAt: true, absenceUntil: true } });
    if (!rop?.isActive || !["MANAGER", "ADMIN", "DIRECTOR"].includes(rop.role)) throw new SellerControlConflict("Укажите действующего руководителя");
    if (live) {
      const owner = await tx.agent.findUnique({ where: { id: client.assignedAgentId! }, select: { isActive: true, frozenAt: true, absenceUntil: true } });
      if (!controlRecipientAvailable(owner, now) || !controlRecipientAvailable(rop, now)) throw new SellerControlConflict("Ответственный временно недоступен; рабочая задача не создана");
    }
    const executionMode = live ? "LIVE" : "PREVIEW";
    const epoch = await resolveInvestigationAssignmentEpoch(tx, { clientId: client.id, subjectAgentId: client.assignedAgentId,
      assignmentAt: client.assignedAt, at: now });
    if (!epoch) throw new SellerControlConflict("ASSIGNMENT_EPOCH_UNKNOWN");
    const identity = [client.id, client.assignedAt.toISOString(), client.assignedAgentId, executionMode, epoch, input.buyerCandidateId ?? null];
    if (intake) identity.push(intake.id);
    const episodeKey = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const existing = await tx.sellerControlEpisode.findUnique({ where: { episodeKey } });
    if (existing) {
      if (existing.ropAgentId !== input.ropAgentId) throw new SellerControlConflict("Эпизод уже назначен другому руководителю");
      return existing;
    }
    const episode = await tx.sellerControlEpisode.create({ data: { episodeKey, clientId: client.id, assignmentAt: client.assignedAt,
      agentId: client.assignedAgentId!, ropAgentId: input.ropAgentId, buyerCandidateId: input.buyerCandidateId,
      sellerIntakeEvidenceId: input.sellerIntakeEvidenceId,
      expectedCount: buyer ? 1 : inventory.expected, baselineAccepted: buyer ? 0 : inventory.accepted, executionMode,
      agentDueAt: buyer ? addAlarmWorkingDays(new Date(Math.max(now.getTime(), buyer.candidate.reviewDueAt.getTime())), config.buyerCandidateFollowupWorkingDays!, calendar) : addAlarmWorkingDays(now, config.agentDueWorkingDays, calendar),
      sourceFingerprint: createHash("sha256").update(JSON.stringify([inventory.expected, client.sellerDeclaredPropertyCountAt])).digest("hex"),
      events: { create: { requestKey: input.requestKey, type: live ? "STARTED" : "SIMULATED_STARTED", actorId: input.actorId, occurredAt: now,
        payload: { config, candidateRevision: input.candidateRevision ?? null } } } } });
    if (intake) await tx.sellerIntakeAppointmentEvidence.update({ where: { id: intake.id }, data: { controlEpisodeId: episode.id } });
    if (live) {
      const wording = buyer ? "Уточнить и записать договорённость о показе" : neutralTask;
      const task = await logTimeline({ actor: { kind: "system", source: "client-plan", subjectAgentId: client.assignedAgentId },
        clientId: client.id, type: "SYSTEM", notes: wording, nextAction: wording, nextActionDate: episode.agentDueAt, tx });
      return tx.sellerControlEpisode.update({ where: { id: episode.id }, data: { agentTaskId: task.id } });
    }
    return episode;
  });
}

export async function commandSellerControl(id: string, command: SellerControlCommand, actorId: string | null,
  options: { taskId?: string; simulated?: boolean } = {}, now = new Date()) {
  const initial = await prisma.sellerControlEpisode.findUniqueOrThrow({ where: { id } });
  return prisma.$transaction(async tx => {
    // Same Client → Episode order as ownership changes and task creation.
    await tx.$queryRaw`SELECT id FROM "Client" WHERE id = ${initial.clientId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "SellerControlEpisode" WHERE id = ${id} FOR UPDATE`;
    const episode = await tx.sellerControlEpisode.findUniqueOrThrow({ where: { id } });
    const replay = await tx.sellerControlEvent.findUnique({ where: { requestKey: command.requestKey } });
    if (replay) {
      const payload = replay.payload as { action?: string; note?: string | null };
      if (replay.episodeId !== id || replay.actorId !== actorId || payload.action !== command.action || (payload.note ?? null) !== (command.note ?? null))
        throw new SellerControlConflict("Ключ запроса уже использован");
      return { episode, event: replay.type, replay: true };
    }
    if (episode.revision !== command.revision) throw new SellerControlConflict("Данные изменились. Обновите страницу");
    if (options.taskId && (episode.executionMode !== "LIVE" || episode.ropTaskId !== options.taskId || episode.ropAgentId !== actorId))
      throw new SellerControlConflict("Задача не назначена вам");
    if (episode.executionMode === "PREVIEW" && !options.simulated) throw new SellerControlConflict("Требуется режим моделирования");
    if (episode.executionMode === "LIVE" && options.simulated) throw new SellerControlConflict("Нельзя подменять реальные действия моделированием");
    if (episode.executionMode === "LIVE" && process.env.SELLER_CONTROL_INTERNAL_LIVE !== "explicitly-approved")
      throw new SellerControlConflict("Исполнение не включено");
    if (episode.buyerCandidateId && !buyerCandidateLiveEnabled()) throw new SellerControlConflict("Исполнение кандидатов выключено");
    if (["RESOLVED", "CANCELLED"].includes(episode.status)) return { episode, event: "ALREADY_CLOSED", replay: false };
    const { client, inventory } = await facts(tx, episode.clientId);
    const buyer = episode.buyerCandidateId ? await buyerCandidateControlFacts(tx, episode.buyerCandidateId, now) : null;
    const intakeSources = episode.sellerIntakeEvidenceId ? await tx.sellerIntakeAppointmentEvidence.findMany({ where: {
      clientId: episode.clientId, agentId: episode.agentId, assignmentAt: episode.assignmentAt,
    }, orderBy: { sourceOccurredAt: "desc" }, take: 2 }) : [];
    const intakeAmbiguous = intakeSources.length > 1 && intakeSources[0].sourceOccurredAt.getTime() === intakeSources[1].sourceOccurredAt.getTime();
    const { config, calendar } = await context(tx, episode.ropAgentId);
    const rop = episode.ropAgentId ? await tx.agent.findUnique({ where: { id: episode.ropAgentId }, select: { isActive: true, role: true, frozenAt: true, absenceUntil: true, weeklyDaysOff: true } }) : null;
    const eligibleRop = !!rop?.isActive && ["MANAGER", "ADMIN", "DIRECTOR"].includes(rop.role);
    if (options.taskId && !eligibleRop) throw new SellerControlConflict("Задача больше не назначена действующему руководителю");
    const plan = planSellerControl({ state: episode, config, calendar, now, action: command.action,
      assignmentCurrent: (buyer ? buyer.current : currentSeller(client)) && client.assignedAgentId === episode.agentId && client.assignedAt.getTime() === episode.assignmentAt.getTime()
        && await assignmentSourceEpochIsCurrent(tx, { clientId: episode.clientId, subjectAgentId: episode.agentId,
          assignmentAt: episode.assignmentAt, sourceAt: episode.createdAt, now }),
      inventory: buyer ? buyer.inventory : inventory.state as "COMPLETE" | "MISSING" | "UNCERTAIN", hasRop: eligibleRop, dataAvailable: !intakeAmbiguous });
    if (episode.executionMode === "LIVE" && !["RESOLVE", "CANCEL"].includes(command.action)
      && !["RESOLVED", "CANCELLED"].includes(plan.patch.status ?? "") && episode.status !== "DIRECTOR") {
      const recipient = episode.status === "AGENT_TASK"
        ? episode.agentId ? await tx.agent.findUnique({ where: { id: episode.agentId }, select: { isActive: true, frozenAt: true, absenceUntil: true, weeklyDaysOff: true } }) : null : rop;
      const unavailable = !controlRecipientAvailable(recipient, now);
      if (unavailable && command.action !== "TICK") throw new SellerControlConflict("Контроль приостановлен: ответственный временно недоступен");
      const availability = await applyControlAvailability(tx, { episode, unavailable,
        recipientId: episode.status === "AGENT_TASK" ? episode.agentId : episode.ropAgentId,
        weeklyDaysOff: recipient?.weeklyDaysOff ?? [], companyDaysOff: calendar.companyDaysOff ?? [],
        config, now, requestKey: command.requestKey, actorId, action: command.action, note: command.note });
      if (availability) {
        if (command.action !== "TICK") throw new SellerControlConflict("Дождитесь возобновления контрольного срока и повторите действие");
        return availability;
      }
      if (episode.status === "AGENT_TASK" && plan.patch.status === "ROP_RECEIPT" && (!eligibleRop || !controlRecipientAvailable(rop, now)))
        return { episode, event: "ROP_TEMPORARILY_UNAVAILABLE", replay: false };
    }
    const event = `${episode.executionMode === "PREVIEW" ? "SIMULATED_" : ""}${plan.event}`;
    if (command.action === "TICK" && Object.keys(plan.patch).length === 0) return { episode, event, replay: false };
    const directorNotices = episode.executionMode === "LIVE" && plan.patch.status === "DIRECTOR"
      ? await recordSellerControlDirectorNotice(tx, episode.id, !!buyer) : [];
    await tx.sellerControlEvent.create({ data: { episodeId: id, requestKey: command.requestKey, actorId, type: event, occurredAt: now,
      payload: { action: command.action, note: command.note ?? null, expected: inventory.expected, accepted: inventory.accepted,
        directorNotices, noticeMeaning: "INBOX_RECORDED_READ_MEANS_OPENED_NOT_RESOLVED" } } });
    const updated = await tx.sellerControlEpisode.update({ where: { id }, data: { ...plan.patch, revision: { increment: 1 } } });
    if (episode.executionMode === "LIVE" && plan.patch.status === "ROP_RECEIPT" && episode.ropAgentId) {
      const wording = buyer ? "Уточнить и записать договорённость о показе" : neutralTask;
      const task = await logTimeline({ actor: { kind: "system", source: "client-plan", subjectAgentId: episode.ropAgentId },
        clientId: episode.clientId, type: "SYSTEM", notes: wording, nextAction: wording, nextActionDate: updated.ropReceiptDueAt, tx });
      await tx.sellerControlEpisode.update({ where: { id }, data: { ropTaskId: task.id } });
    }
    if (["RESOLVED", "CANCELLED"].includes(updated.status)) await tx.interaction.updateMany({
      where: { id: { in: [episode.agentTaskId, episode.ropTaskId].filter((value): value is string => !!value) }, completedAt: null, taskCancelledAt: null },
      data: { taskCancelledAt: now } });
    return { episode: updated, event, replay: false };
  });
}

/** Disabled unless separately approved by server deployment configuration. Never enrolls old cards. */
export async function runSellerControlTick(now = new Date()) {
  if (process.env.SELLER_CONTROL_INTERNAL_LIVE !== "explicitly-approved") return { mode: "PREVIEW", processed: 0 };
  await enrollDueBuyerCandidates(now);
  await enrollDueSellerIntakes(now);
  let processed = 0;
  let afterId: string | undefined;
  while (true) {
    // Stable pages: unchanged waiting/director rows must not starve later episodes.
    const rows = await prisma.sellerControlEpisode.findMany({ where: { executionMode: "LIVE", createdAt: { lte: now },
      ...(afterId ? { id: { gt: afterId } } : {}), status: { in: ["AGENT_TASK", "ROP_RECEIPT", "ROP_ACTION", "DIRECTOR"] } },
      take: 100, orderBy: { id: "asc" } });
    for (const row of rows) {
      try { await commandSellerControl(row.id, { requestKey: randomUUID(), revision: row.revision, action: "TICK" }, null, {}, now); processed++; }
      catch (error) { if (!(error instanceof SellerControlConflict)) throw error; }
    }
    if (rows.length < 100) break;
    afterId = rows[rows.length - 1].id;
  }
  return { mode: "LIVE", processed };
}

/** Only explicitly LIVE future appointment evidence is scanned, never old sellers. */
export async function enrollDueSellerIntakes(now = new Date()) {
  const from = Date.parse(process.env.SELLER_CONTROL_LIVE_FROM ?? "");
  if (process.env.SELLER_CONTROL_INTERNAL_LIVE !== "explicitly-approved" || !Number.isFinite(from)) return { state: "EXECUTION_DISABLED", created: 0 };
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerControlConfig: true } });
  const config = readSellerControlConfig(settings?.sellerControlConfig);
  if (!config?.defaultRopAgentId) return { state: "NOT_CONFIGURED", created: 0 };
  const rop = await prisma.agent.findUnique({ where: { id: config.defaultRopAgentId }, select: { isActive: true, role: true } });
  if (!rop?.isActive || !["MANAGER", "ADMIN", "DIRECTOR"].includes(rop.role)) return { state: "ROP_UNAVAILABLE", created: 0 };
  let afterId: string | undefined, created = 0;
  while (true) {
    const rows = await prisma.sellerIntakeAppointmentEvidence.findMany({ where: { executionMode: "LIVE", controlEpisodeId: null, sourceOccurredAt: { gte: new Date(from), lte: now },
      proposedAt: { lte: now }, ...(afterId ? { id: { gt: afterId } } : {}) }, orderBy: { id: "asc" }, take: 100 });
    for (const row of rows) {
      if (await prisma.sellerControlEpisode.findUnique({ where: { sellerIntakeEvidenceId: row.id }, select: { id: true } })) continue;
      try {
        const episode = await startSellerControl({ clientId: row.clientId, sellerIntakeEvidenceId: row.id, ropAgentId: config.defaultRopAgentId,
          actorId: null, requestKey: randomUUID(), live: true }, now);
        if (episode.sellerIntakeEvidenceId === row.id) created++;
      } catch (error) { if (!(error instanceof SellerControlConflict)) throw error; }
    }
    if (rows.length < 100) break;
    afterId = rows[rows.length - 1].id;
  }
  return { state: "EVALUATED", created };
}

/** Future LIVE sources only. PREVIEW rows can never be promoted by changing settings. */
export async function enrollDueBuyerCandidates(now = new Date()) {
  const from = Date.parse(process.env.BUYER_CANDIDATE_LIVE_FROM ?? "");
  if (!buyerCandidateLiveEnabled() || !Number.isFinite(from)) return { state: "EXECUTION_DISABLED", created: 0 };
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { sellerControlConfig: true } });
  const config = readSellerControlConfig(settings?.sellerControlConfig);
  if (!config?.defaultRopAgentId || !config.buyerCandidateFollowupWorkingDays) return { state: "NOT_CONFIGURED", created: 0 };
  const rop = await prisma.agent.findUnique({ where: { id: config.defaultRopAgentId }, select: { isActive: true, role: true } });
  if (!rop?.isActive || !["MANAGER", "ADMIN", "DIRECTOR"].includes(rop.role)) return { state: "ROP_UNAVAILABLE", created: 0 };
  let afterId: string | undefined, created = 0;
  while (true) {
    const rows = await prisma.buyerShowingCandidate.findMany({ where: { executionMode: "LIVE", status: "OPEN",
      sourceOccurredAt: { gte: new Date(from), lte: now }, reviewDueAt: { lte: now }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" }, take: 100 });
    for (const row of rows) {
      if (await prisma.sellerControlEpisode.findUnique({ where: { buyerCandidateId: row.id }, select: { id: true } })) continue;
      try {
        await startSellerControl({ clientId: row.clientId, buyerCandidateId: row.id, candidateRevision: row.revision,
          ropAgentId: config.defaultRopAgentId, actorId: null, requestKey: randomUUID(), live: true }, now);
        created++;
      } catch (error) { if (!(error instanceof SellerControlConflict)) throw error; }
    }
    if (rows.length < 100) break;
    afterId = rows[rows.length - 1].id;
  }
  return { state: "EVALUATED", created };
}
