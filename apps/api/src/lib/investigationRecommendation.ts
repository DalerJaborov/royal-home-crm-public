import { prisma } from "../db.js";
import { clientSpeechOf } from "../ai/callQuoteCheck.js";

type Evidence = { id: string; sourceType: string; sourceId: string; kind: string; independenceKey: string; payload: unknown };
type Verified = Evidence & { verifiedRedQuote?: boolean };
/** Read-only recommendation. Provenance groups are not votes, and never imply C4. */
export function recommendInvestigationLevel(status: string, evidence: Verified[]) {
  if (status === "CLEARED") return { level: "C0", basis: "HUMAN_CLEARED", evidenceIds: [] as string[], mode: "PREVIEW" };
  const quoted = evidence.find(item => item.verifiedRedQuote);
  if (quoted) return { level: "C3", basis: "RECORDED_RED_OUTCOME_WITH_VERIFIED_QUOTE", evidenceIds: [quoted.id], mode: "PREVIEW" };
  // Only these server producers establish a concrete trace. Generic notes, absence,
  // model hypotheses, duplicate derivatives and manually asserted guilt do not qualify.
  const traces = evidence.filter(item => !item.independenceKey.startsWith("manual:") && item.independenceKey !== "unverified-origin"
    && ((item.sourceType === "SHOWING" && item.kind === "late-cancellation")
      || (item.sourceType === "CALL" && item.kind === "SELLER_INTAKE_DATE_CHANGES")));
  const distinct = traces.filter((item, index) => traces.findIndex(other => other.independenceKey === item.independenceKey) === index);
  if (distinct.length >= 2 && new Set(distinct.map(item => `${item.sourceType}:${item.kind}`)).size >= 2)
    return { level: "C2", basis: "DISTINCT_RECORDED_TRACES_REQUIRE_REVIEW", evidenceIds: distinct.map(item => item.id), mode: "PREVIEW" };
  return { level: "C1", basis: "UNCONFIRMED_TRACE_OR_INSUFFICIENT_PROVENANCE", evidenceIds: distinct.map(item => item.id), mode: "PREVIEW" };
}

export async function loadInvestigationRecommendation(row: { status: string; clientId: string | null; evidence: Evidence[] }) {
  const verified = await Promise.all(row.evidence.map(async item => {
    const payload = item.payload && typeof item.payload === "object" ? item.payload as Record<string, unknown> : {};
    if (item.kind !== "outcome" || payload.unconfirmedOutcome === true) return item;
    const call = item.sourceType === "post-showing-call"
      ? await prisma.postShowingCall.findUnique({ where: { id: item.sourceId }, select: { clientId: true, channelId: true, quote: true, outcome: true, outcomeConfidence: true } })
      : item.sourceType === "seller-probe-call"
        ? await prisma.sellerProbeCall.findUnique({ where: { id: item.sourceId }, select: { sellerClientId: true, channelId: true, quote: true, outcome: true } }) : null;
    if (!call || !call.channelId || !call.quote || ("outcomeConfidence" in call && (call.outcomeConfidence ?? 0) < 0.7)
      || ("clientId" in call ? call.clientId : call.sellerClientId) !== row.clientId
      || !["NO_MEETING", "AGENT_COMPLAINT", "BYPASS", "SOLD_ELSEWHERE"].includes(call.outcome ?? "")) return item;
    const sessions = await prisma.liveVoiceSession.findMany({ where: { channelId: call.channelId, clientId: row.clientId, investigationOnly: true },
      select: { transcript: true, recordingUrl: true }, take: 10 });
    const literal = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru").replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
    if (literal(call.quote).split(" ").length < 3) return item;
    return { ...item, verifiedRedQuote: sessions.some(session => !!session.recordingUrl && !!session.transcript
      && session.transcript.split("\n").filter(line => line.startsWith("Клиент:")).some(line => literal(clientSpeechOf([line])) === literal(call.quote!))) };
  }));
  return recommendInvestigationLevel(row.status, verified);
}
