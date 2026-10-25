import { beforeEach, describe, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ settings: vi.fn(), interactions: vi.fn(), episodes: vi.fn(), clients: vi.fn(), outages: vi.fn() }));
vi.mock("../src/db.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: { $disconnect: vi.fn(), settings: { findUniqueOrThrow: s.settings }, interaction: { findMany: s.interactions }, postShowingCall: { findMany: s.episodes }, client: { findMany: s.clients } } }));
vi.mock("../src/lib/stationOutage.js", async (importOriginal) => ({ ...await importOriginal<typeof import("../src/lib/stationOutage.js")>(), outagesBetween: s.outages }));
import { collectPostShowingCohort } from "../src/lib/postShowingCohort.js";
const from = new Date("2026-10-01T00:00:00Z"), to = new Date("2026-10-25T12:00:00Z"), at = new Date("2026-10-10T10:00:00Z");
const showing = { id: "show", clientId: "client", nextActionDate: at, completedAt: at, createdAt: at, buyerIntentAtCreation: true };
const episode = { id: "episode", showingId: "show", agentId: "historical-agent", agent: { fullName: "Historical Agent" }, previewOnly: false, status: "DONE", outcome: "REFUSED", talkedAt: new Date("2026-10-10T12:00:00Z"), skipReason: null, updatedAt: new Date("2026-10-10T12:01:00Z"), createdAt: at };
describe("cohort evidence provenance before statistical definition", () => {
  beforeEach(() => { vi.clearAllMocks(); s.settings.mockResolvedValue({ postShowingCohortConfig: {}, leadCallMinSeconds: 30 }); s.interactions.mockImplementation(async args => args.where.type === "SHOWING" ? [showing] : []); s.episodes.mockResolvedValue([episode]); s.clients.mockResolvedValue([{ id: "client", lastClientMessageAt: null }]); s.outages.mockResolvedValue([]); });
  it("retains agent-at-enrolment and does not label REFUSED as physical silence", async () => {
    const result = await collectPostShowingCohort(from, to, to);
    expect(result.agents[0]).toMatchObject({ agentId: "historical-agent", robotResponses: 1, unresolvedSurvey: 1, silent: 0, ratePercent: 0 });
    expect(result.evaluation).toBe("OBSERVED_FOLLOWUP_COMPARISON");
  });
  it("only accepts bounded public TALKED evidence with configured real duration", async () => {
    s.interactions.mockImplementation(async args => args.where.type === "SHOWING" ? [showing] : [{ id: "call", clientId: "client", createdAt: new Date("2026-10-11T12:00:00Z") }]);
    const result = await collectPostShowingCohort(from, to, to); expect(result.agents[0].publicResponses).toBe(1);
    expect(s.interactions.mock.calls[1][0].where).toMatchObject({ investigationOnly: false, type: "CALL", callAttempt: "TALKED", recordingDurationSec: { gte: 30 }, createdAt: { gte: from, lte: to } });
  });
  it("an overwritten future incoming timestamp is historical uncertainty, not no-response proof", async () => {
    s.clients.mockResolvedValue([{ id: "client", lastClientMessageAt: new Date("2026-11-01T00:00:00Z") }]);
    const result = await collectPostShowingCohort(from, to, to); expect(result.coverage.historicalContactUnknown).toBe(1); expect(result.agents[0].publicResponses).toBe(0); expect(result.agents[0].silent).toBe(0);
  });
  it("counts unobserved showings separately without assigning them to current client owner", async () => {
    s.episodes.mockResolvedValue([]); const result = await collectPostShowingCohort(from, to, to);
    expect(result.coverage).toMatchObject({ recordedShowings: 1, unobserved: 1, withEpisodeSnapshot: 0 }); expect(result.agents).toEqual([]);
  });
  it("preview, pending and outage remain quality flags, never positive denominator values", async () => {
    s.episodes.mockResolvedValue([{ ...episode, previewOnly: true, status: "NO_ANSWER", outcome: null, talkedAt: null }]); s.outages.mockResolvedValue([{ startedAt: at, endedAt: null }]);
    const result = await collectPostShowingCohort(from, to, to); expect(result.coverage).toMatchObject({ preview: 1, pending: 1, stationOutage: 1 }); expect(result.agents[0].eligible).toBe(0);
  });
  it("counts completed unsuccessful attempts separately from answered unclear surveys", async () => {
    s.episodes.mockResolvedValue([{...episode,status:"GIVEN_UP",outcome:null,talkedAt:null,attempts:2,lastAttemptAt:new Date("2026-10-11T12:00:00Z")}]);
    const result=await collectPostShowingCohort(from,to,to);
    expect(result.agents[0]).toMatchObject({eligible:1,silent:1,ratePercent:100,unresolvedSurvey:0,evaluation:"INSUFFICIENT_SAMPLE",aboveDescriptiveThreshold:false});
  });
});
