import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTurnTracePayload } from "@royal-home/shared";
const db = vi.hoisted(() => ({
  $disconnect: vi.fn(async () => {}), settings: { findUnique: vi.fn(async () => null) },
  street: { findMany: vi.fn(async () => []) }, landmark: { findMany: vi.fn(async () => []) },
  district: { findMany: vi.fn(async () => []) },
  microdistrict: { findMany: vi.fn(async () => []) }, livingArea: { findMany: vi.fn(async () => []) }, geoAlias: { findMany: vi.fn(async () => []) },
  styleExample: { findMany: vi.fn(async () => []) }, botLesson: { findMany: vi.fn(async () => []) }, guardHit: { upsert: vi.fn() },
}));
const fake = vi.hoisted(() => ({ raw: {} as unknown, callAi: vi.fn(), logError: vi.fn() }));
// Complete DB/dotenv replacements intentionally avoid pools and local keys.
vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/lib/recruitmentPositions.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/recruitmentPositions.js")>(),
  readCustomerOpenVacancies: async () => {
    const { recruitmentCatalogHash } = await import("../src/ai/customerAgentRecruitmentProtocol.js");
    const facts = { collecting: true, positions: [] };
    return { kind: "open_vacancies", ...facts, sourceHash: recruitmentCatalogHash(facts) };
  },
}));
vi.mock("../src/ai/client.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/ai/client.js")>()), callAiText: fake.callAi }));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: fake.logError }));
import { runQualifyTurn } from "../src/ai/leadQualifier.js";
import { traceModelStart, traceModelFinish, withBotTurnTrace } from "../src/lib/botTurnTrace.js";
const caps = { showings: true, askOwner: true, vacancies: true, promptEconomy: true, callback: false, links: true, cautious: false };
const valid = { reply: ["Могу помочь с квартирой."], ready: false, confident: true, topic: "other", openQuestion: "", clientAnsweredOpenQuestion: false };
async function qualify(raw: unknown, text = false) {
  const rows: BotTurnTracePayload[] = []; fake.raw = raw;
  const result = await withBotTurnTrace({ channel: "WEBSITE", source: "website", event: "fake-event" }, () => runQualifyTurn([{ role: "user", content: "Здравствуйте" }], {}, { abilities: caps, topic: { settings: { enabled: true, driftTurns: 1 } } }), {
    enabled: true, text, secret: "fictional-contract-trace-key-only-test-0000", write: (row) => { rows.push(row); },
  });
  return { rows, result };
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.callAi.mockImplementation(async () => { const index = traceModelStart("gemini-unit", null); traceModelFinish(index, "parsed", performance.now(), fake.raw); return fake.raw; });
  vi.stubGlobal("fetch", vi.fn(async () => { throw Error("external fetch forbidden"); }));
});
afterEach(() => { vi.unstubAllGlobals(); });
describe("actual runQualifyTurn schema trace integration", () => {
  it("a valid whole result records schema success before qualifier guard deltas", async () => {
    const { rows, result } = await qualify(valid);
    expect(result?.reply).toEqual(valid.reply); expect(fake.callAi).toHaveBeenCalledTimes(1);
    const final = rows.at(-1)!; expect(final.modelAttempts[0].outcome).toBe("parsed"); expect(final.modelAttempts[0].schemaIssues).toEqual([]);
    expect(final.filterDeltas.map((item) => item.guard)).toEqual(["price", "discount", "availability", "media_apology"]);
    const firstGuards = rows.find((row) => row.filterDeltas.length > 0);
    expect(firstGuards?.modelAttempts[0].schemaIssues).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("malformed action data rejects the entire result before guards and produces closed path/code metadata", async () => {
    const { rows, result } = await qualify({ ...valid, ready: "false", showing: { action: "cancel" }, jobApplication: { phone: "+992900000001", hasCar: "false" } });
    expect(result).toBeNull(); const final = rows.at(-1)!;
    expect(final.modelAttempts[0].outcome).toBe("invalid"); expect(final.modelAttempts[0].schemaIssues).toEqual(expect.arrayContaining([{ path: "ready", code: "invalid_type" }, { path: "jobApplication", code: "invalid_type" }]));
    expect(final.filterDeltas).toEqual([]); expect(db.guardHit.upsert).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("unknown key names and nested phone/name/notes never enter trace or existing schema diagnostics", async () => {
    const { rows, result } = await qualify({ ...valid, PRIVATE_DYNAMIC_KEY: { credential: "FAKE_PRIVATE_CREDENTIAL" }, lead: { notes: "FAKE_PRIVATE_NOTE" }, jobApplication: { name: "FAKE_PRIVATE_NAME", phone: "+992900000001" } }, true);
    expect(result).toBeNull(); const serialized = JSON.stringify({ rows, logs: fake.logError.mock.calls });
    expect(serialized).not.toMatch(/PRIVATE_DYNAMIC_KEY|FAKE_PRIVATE_CREDENTIAL|FAKE_PRIVATE_NOTE|FAKE_PRIVATE_NAME|992900000001/);
    expect(rows.at(-1)?.modelAttempts[0].schemaIssues).toContainEqual({ path: "other", code: "unrecognized_keys" });
  });
  it("disabled action capability remains rejected at the same boundary", async () => {
    const rows: BotTurnTracePayload[] = []; fake.raw = { ...valid, showing: { action: "cancel" } };
    const result = await withBotTurnTrace({ channel: "WEBSITE" }, () => runQualifyTurn([{ role: "user", content: "Здравствуйте" }], {}, { abilities: { ...caps, showings: false }, topic: { settings: { enabled: true, driftTurns: 1 } } }), { enabled: true, text: false, secret: "fictional-contract-trace-key-only-test-0000", write: (row) => { rows.push(row); } });
    expect(result).toBeNull(); expect(rows.at(-1)?.modelAttempts[0]).toMatchObject({ outcome: "invalid", schemaIssues: [{ path: "showing", code: "invalid_type" }] });
    expect(rows.at(-1)?.filterDeltas).toEqual([]);
  });
});
