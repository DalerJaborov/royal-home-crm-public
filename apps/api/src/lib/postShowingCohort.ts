import { postShowingCohortConfigSchema, type PostShowingCohortView } from "@royal-home/shared";
import { prisma } from "../db.js";
import { showingMomentOf } from "./postShowingCall.js";
import { hasScenarioCallMark } from "./postShowingCalls.js";
import { COUNTED_SHOWING_WHERE } from "./tasks.js";
import { outagesBetween } from "./stationOutage.js";
import { classifyPostShowingFollowup } from "./postShowingCohortClassification.js";
import { compareRecordedCohorts } from "./postShowingCohortRates.js";

const MAX_SHOWINGS = 10000, MAX_CONTACTS = 20000;
/** Agreed split: unanswered completed survey attempts vs answered but unresolved survey. */
export async function collectPostShowingCohort(from: Date, to: Date, asOf = new Date()): Promise<PostShowingCohortView> {
  if (!(from < to) || to > asOf) throw new Error("Invalid cohort observation interval");
  const settings = await prisma.settings.findUniqueOrThrow({ where: { id: "singleton" }, select: { postShowingCohortConfig: true, leadCallMinSeconds: true } });
  const config = postShowingCohortConfigSchema.parse(settings.postShowingCohortConfig ?? {});
  const period = { gte: from, lt: to };
  const candidates = await prisma.interaction.findMany({ where: { investigationOnly: false, type: "SHOWING", ...COUNTED_SHOWING_WHERE,
    OR: [{ nextActionDate: period }, { completedAt: period }, { createdAt: period }] },
    select: { id: true, clientId: true, nextActionDate: true, completedAt: true, createdAt: true, buyerIntentAtCreation: true }, take: MAX_SHOWINGS + 1 });
  const showingRows = candidates.filter(s => { const at = showingMomentOf(s); return at >= from && at < to; });
  const ids = showingRows.map(s => s.id), clientIds = [...new Set(showingRows.map(s => s.clientId))];
  const [episodes, clients, contacts, outages] = await Promise.all([
    prisma.postShowingCall.findMany({ where: { showingId: { in: ids } }, select: { id: true, showingId: true, agentId: true, previewOnly: true, status: true, outcome: true, attempts: true, lastAttemptAt: true, skipReason: true, createdAt: true, updatedAt: true, talkedAt: true, agent: { select: { fullName: true } } } }),
    prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, lastClientMessageAt: true } }),
    prisma.interaction.findMany({ where: { clientId: { in: clientIds }, investigationOnly: false, type: "CALL", callAttempt: "TALKED", recordingDurationSec: { gte: settings.leadCallMinSeconds }, createdAt: { gte: from, lte: asOf } }, select: { id: true, clientId: true, createdAt: true }, take: MAX_CONTACTS + 1 }),
    outagesBetween(from, asOf),
  ]);
  const coverage: Record<string, number> = { recordedShowings: showingRows.length, withEpisodeSnapshot: 0, unobserved: 0, preview: 0, pending: 0, wrongPerson: 0, stationOutage: 0, historicalContactUnknown: 0, occurrenceUnconfirmed: 0, episodeUpdatedAfterAsOf: 0 };
  const episodeByShowing = new Map(episodes.map(e => [e.showingId, e]));
  const clientById = new Map(clients.map(c => [c.id, c]));
  const contactsByClient = new Map<string, Date[]>();
  for (const contact of contacts) { const times = contactsByClient.get(contact.clientId) ?? []; times.push(contact.createdAt); contactsByClient.set(contact.clientId, times); }
  const groups = new Map<string, PostShowingCohortView["agents"][number]>();
  const classified: Array<{ agentId: string; eligible: boolean; signal: boolean }> = [];
  for (const showing of showingRows) {
    const at = showingMomentOf(showing), episode = episodeByShowing.get(showing.id);
    if (!episode) { coverage.unobserved++; continue; }
    coverage.withEpisodeSnapshot++;
    const group = groups.get(episode.agentId) ?? { agentId: episode.agentId, agentName: episode.agent.fullName, recorded: 0, publicResponses: 0, robotResponses: 0, unresolvedSurvey: 0, unknown: 0, eligible: null, silent: null, ratePercent: null, peerEligible: null, peerRatePercent: null };
    group.recorded++;
    const lastMessage = clientById.get(showing.clientId)?.lastClientMessageAt;
    const publicResponse = !!lastMessage && lastMessage > at && lastMessage <= asOf || (contactsByClient.get(showing.clientId) ?? []).some(atContact => atContact > at && atContact <= asOf);
    const robotResponse = !!episode.talkedAt && episode.talkedAt > at && episode.talkedAt <= asOf;
    const flags = {
      preview: episode.previewOnly,
      pending: ["PENDING", "CALLING", "NO_ANSWER"].includes(episode.status),
      wrongPerson: hasScenarioCallMark(episode.skipReason, "wrong_person"),
      stationOutage: episode.skipReason === "station_down" || outages.some(o => o.startedAt < asOf && (o.endedAt ?? asOf) > at),
      historicalContactUnknown: !!lastMessage && lastMessage > asOf,
      occurrenceUnconfirmed: !showing.completedAt || showing.completedAt > asOf,
      episodeUpdatedAfterAsOf: episode.updatedAt > asOf,
    };
    for (const [key, present] of Object.entries(flags)) if (present) coverage[key]++;
    const result = classifyPostShowingFollowup({ excluded: Object.values(flags).some(Boolean), publicResponse, robotResponse,
      status: episode.status, outcome: episode.outcome, attempts: episode.attempts, lastAttemptAt: episode.lastAttemptAt, showingAt: at, asOf, skipReason: episode.skipReason });
    classified.push({ agentId: episode.agentId, eligible: result.eligible, signal: result.signal });
    if (result.eligible && publicResponse) group.publicResponses++;
    if (result.eligible && robotResponse) group.robotResponses++;
    if (result.eligible && robotResponse && episode.status === "DONE" && ["REFUSED", "UNCLEAR"].includes(episode.outcome ?? "")) group.unresolvedSurvey++;
    if (!result.eligible) group.unknown++;
    groups.set(episode.agentId, group);
  }
  const truncated = candidates.length > MAX_SHOWINGS || contacts.length > MAX_CONTACTS;
  for (const comparison of compareRecordedCohorts(classified, config)) {
    const group = groups.get(comparison.agentId)!;
    Object.assign(group, { eligible: comparison.eligible, silent: comparison.signal, ratePercent: comparison.ratePercent,
      peerEligible: comparison.peerEligible, peerRatePercent: comparison.peerRatePercent, evaluation: comparison.evaluation,
      aboveDescriptiveThreshold: comparison.aboveDescriptiveThreshold, automaticVerdict: false });
  }
  return { version: 2, from: from.toISOString(), to: to.toISOString(), asOf: asOf.toISOString(), source: "RECORDED_SHOWINGS_WITH_POST_SHOWING_AGENT_SNAPSHOT", config,
    evaluation: truncated ? "TRUNCATED" : "OBSERVED_FOLLOWUP_COMPARISON", coverage,
    limitations: ["Агент взят из снимка при постановке опроса; текущий владелец карточки не используется.", "Доля: отсутствие ответа на завершённые попытки опроса среди завершённых наблюдаемых случаев. Это не молчание во всех каналах.", "Известный ответ в CRM или роботу исключает случай из числа неответивших. REFUSED и UNCLEAR учитываются отдельно как неуточнённый итог.", "Исторические пропуски, незавершённые опросы, предварительные записи и пересечение простоя исключены из знаменателя.", "Период наблюдения каждого случая: от даты показа до указанного среза. Текущая история не восстанавливает утраченные события.", "Малая выборка и нулевая база остальных отмечаются отдельно. Пороги не устанавливают виновность и не создают C4."],
    agents: truncated ? [] : [...groups.values()] };
}
