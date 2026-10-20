import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotTurnTracePayload } from "@royal-home/shared";
const db = vi.hoisted(() => ({ $disconnect: vi.fn(async () => {}), $executeRaw: vi.fn(), botTurnTrace: { deleteMany: vi.fn() } }));
// Complete replacements prevent construction of a real pool and dotenv reads.
vi.mock("../src/db.js", () => ({ prisma: db }));
vi.mock("../src/loadEnv.js", () => ({}));
vi.mock("../src/lib/livePublish.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/livePublish.js")>()), publishMessageNew: vi.fn() }));
vi.mock("../src/lib/sellerFacts.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/sellerFacts.js")>()), scheduleSellerFactsRefreshForConversation: vi.fn() }));
import { appendConversationMessages } from "../src/messengers/appendMessages.js";
import { cleanupBotTurnTraces, writeBotTurnTrace } from "../src/lib/botTurnTraceStore.js";
import { withBotTurnTrace } from "../src/lib/botTurnTrace.js";
import { parseTraceExportArgs, readTraceExport } from "../src/lib/botTurnTraceExport.js";

function recorder() {
  const rows: BotTurnTracePayload[] = [];
  return { rows, config: { enabled: true, secret: "fictional-trace-key-only-for-unit-tests-0000", text: false, write: (row: BotTurnTracePayload) => { rows.push(row); } } };
}
beforeEach(() => { vi.resetAllMocks(); db.$executeRaw.mockResolvedValue(1); });
afterEach(() => { vi.restoreAllMocks(); });
describe("actual persistence hooks without DB/network", () => {
  it("export boundary rejects missing/duplicate/non-ISO/out-of-range arguments before querying", async () => {
    const valid = ["--from=2031-01-01T00:00:00Z", "--to=2031-01-02T00:00:00Z", "--limit=10"];
    expect(parseTraceExportArgs(valid).limit).toBe(10);
    for (const args of [[], [...valid, "--limit=1"], ["--from=1", valid[1], valid[2]], [valid[0], "--to=2031-01-10T00:00:00Z", valid[2]], [valid[0], valid[1], "--limit=1001"]]) expect(() => parseTraceExportArgs(args)).toThrow();
    const findMany = vi.fn(); await expect(readTraceExport({ findMany }, { ...parseTraceExportArgs(valid), limit: 1001 })).rejects.toThrow(); expect(findMany).not.toHaveBeenCalled();
  });
  it("widget receipt follows the actual atomic append result, including delayed visibility", async () => {
    const { rows, config } = recorder();
    await withBotTurnTrace({ channel: "WEBSITE", conversation: "fake-web", peer: "fake-session" }, async () => {
      await appendConversationMessages("fake-web", [{ role: "assistant", content: "Ответ", by: { kind: "bot" }, visibleAt: "2031-01-01T10:00:00.000Z" }]);
    }, config);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(rows.at(-1)?.outgoing).toHaveLength(1);
    expect(rows.at(-1)?.outgoing[0]).toMatchObject({ stampOutcome: "success", providerOutcome: "available_to_widget", visibleAt: "2031-01-01T10:00:00.000Z" });
  });
  it("zero affected rows or failed append produce no false widget receipt", async () => {
    for (const fail of [false, true]) {
      const { rows, config } = recorder();
      db.$executeRaw.mockImplementation(async () => { if (fail) throw Error("fake DB error"); return 0; });
      await withBotTurnTrace({ channel: "WEBSITE", conversation: "fake-web" }, async () => { await appendConversationMessages("fake-web", [{ role: "assistant", content: "Ответ", by: { kind: "bot" } }]).catch(() => {}); }, config);
      expect(rows.at(-1)?.outgoing).toEqual([]);
    }
  });
  it("trace store uses parameterized sequence and terminal fences, preserving original expiry", async () => {
    const { rows, config } = recorder(); await withBotTurnTrace({ channel: "WEBSITE", conversation: "fake-web" }, async () => {}, config);
    await writeBotTurnTrace(rows.at(-1)!);
    const sql = db.$executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    expect(sql.strings.join("?")).toContain('"BotTurnTrace"."checkpointSeq" < EXCLUDED."checkpointSeq" AND "BotTurnTrace"."completedAt" IS NULL');
    expect(sql.strings.join("?")).not.toMatch(/DO UPDATE SET[^]*expiresAt/);
    expect(sql.values).toContain(rows.at(-1)!.traceId);
    // This verifies SQL construction; PostgreSQL concurrency is a separate gate.
  });
  it("TTL cleanup bounds only the dedicated diagnostic table by expiresAt", async () => {
    const now = new Date("2031-01-01T10:00:00.000Z"); db.botTurnTrace.deleteMany.mockResolvedValue({ count: 3 });
    expect(await cleanupBotTurnTraces(now)).toBe(3); expect(db.botTurnTrace.deleteMany).toHaveBeenCalledWith({ where: { expiresAt: { lte: now } } });
  });
});
