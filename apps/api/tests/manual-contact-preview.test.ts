import { beforeEach, describe, expect, it, vi } from "vitest";
const db = vi.hoisted(() => ({ $disconnect: vi.fn(), $queryRaw: vi.fn(), client: { findMany: vi.fn(), count: vi.fn() }, smsMessage: { count: vi.fn() }, customerOutboxPart: { count: vi.fn() }, botConversation: { findMany: vi.fn() } }));
vi.mock("../src/db.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/db.js")>(), prisma: db }));
import { previewManualContactOnly } from "../src/lib/manualContactPreview.js";
const now = new Date("2026-10-25T10:00:00Z");
const client = { id: "client", assignedAgentId: "agent", assignedAt: new Date("2026-09-01T10:00:00Z"),
  interactions: [{ id: "note", type: "CALL", actorKind: "AGENT", callAttempt: null, recordingUrl: null }] };
beforeEach(() => { vi.clearAllMocks(); db.$queryRaw.mockResolvedValue([]); db.client.findMany.mockResolvedValue([client]); db.client.count.mockResolvedValue(1); db.smsMessage.count.mockResolvedValue(0); db.customerOutboxPart.count.mockResolvedValue(0); db.botConversation.findMany.mockResolvedValue([]); });
describe("manual-only contact read-only context", () => {
  it("reports local manual notes with explicitly unknown channel coverage, no escalation", async () => {
    expect(await previewManualContactOnly(1, now)).toMatchObject({ escalation: "DISABLED", items: [{ evaluation: "MANUAL_ONLY_LOCAL_RECORDS", coverage: "UNKNOWN", assessment: "NOT_A_VERDICT" }] });
  });
  it("station attempt or accepted CRM message disproves an only-manual local history", async () => {
    db.client.findMany.mockResolvedValue([{ ...client, interactions: [...client.interactions, { id: "station", type: "CALL", actorKind: "AGENT", callAttempt: "NO_ANSWER", recordingUrl: null }] }]);
    expect((await previewManualContactOnly(1, now)).items[0].evaluation).toBe("ELECTRONIC_ACTIVITY_FOUND");
    db.client.findMany.mockResolvedValue([client]); db.smsMessage.count.mockResolvedValue(1);
    expect((await previewManualContactOnly(1, now)).items[0].evaluation).toBe("ELECTRONIC_ACTIVITY_FOUND");
  });
  it("does not assign a prior owner's history to a new owner or treat truncated data as complete", async () => {
    db.client.findMany.mockResolvedValue([{ ...client, assignedAt: now }]);
    expect((await previewManualContactOnly(1, now)).items[0].evaluation).toBe("INSUFFICIENT_WINDOW");
    db.client.findMany.mockResolvedValue([{ ...client, interactions: Array.from({ length: 501 }, () => client.interactions[0]) }]);
    expect((await previewManualContactOnly(1, now)).items[0].evaluation).toBe("TRUNCATED_UNKNOWN");
  });
});

it("excludes a returned owner even when assignedAt was restored", async () => {
  db.$queryRaw.mockResolvedValue([{ clientId: client.id }]);
  expect((await previewManualContactOnly(1, now)).items[0].evaluation).toBe("ASSIGNMENT_CHANGED_IN_WINDOW");
});
it("manual API input cannot fabricate station call fields", async () => {
  const { interactionCreateSchema } = await import("@royal-home/shared");
  const parsed = interactionCreateSchema.parse({ type: "CALL", notes: "Staff declaration", callAttempt: "TALKED", recordingUrl: "fake-recording" });
  expect(parsed).not.toHaveProperty("callAttempt"); expect(parsed).not.toHaveProperty("recordingUrl");
});

it.each([undefined, "invalid-date"])("treats provider MID without valid date as unknown (%s)", async at => {
  db.botConversation.findMany.mockResolvedValue([{ messages: [{ mid: "real-provider-mid", role: "user", content: "Message", at }] }]);
  expect((await previewManualContactOnly(1, now)).items[0].evaluation).toBe("SOURCE_DATES_UNKNOWN");
  db.botConversation.findMany.mockResolvedValue([{ messages: [{ mid: "silent-mid", silentCapture: true, at }] }]);
  expect((await previewManualContactOnly(1, now)).items[0].evaluation).toBe("MANUAL_ONLY_LOCAL_RECORDS");
});
