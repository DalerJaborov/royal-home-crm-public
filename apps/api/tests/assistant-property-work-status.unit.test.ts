import { describe, expect, it, vi } from "vitest";
import { getPropertyWorkStatusTool, summarizePropertyWork } from "../src/ai/assistant/tools/getPropertyWorkStatus.js";
import type { AssistantActor } from "../src/ai/assistant/actor.js";

const db = vi.hoisted(() => ({
  count: vi.fn(async () => 12),
  findMany: vi.fn(async (_query: unknown): Promise<unknown[]> => []),
  transaction: vi.fn((queries: Promise<unknown>[], _options: unknown) => Promise.all(queries)),
}));
vi.mock("../src/db.js", () => ({ prisma: { property: db, $transaction: db.transaction, $disconnect: async () => {} } }));

const now = new Date("2026-11-04T13:00:00Z");
const sent = new Date("2026-10-28T12:00:00Z");
const delivered = new Date("2026-11-02T12:00:00Z");
const row: Parameters<typeof summarizePropertyWork>[0] = {
  id: "p1",
  shortId: 132,
  title: "Дом",
  status: "EDITING",
  stageEnteredAt: sent,
  videoHandoffStatus: "SENT_TO_EDITOR",
  videoHandoffSentAt: sent,
  videoHandoffDeliveredAt: null,
  videoHandoffReceivedAt: null,
  videoHandoffFinalPath: null,
  videoHandoffDispatchStartedAt: null,
  videoHandoffDispatchAttempts: 0,
  videoHandoffManualSince: null,
  videoHandoffHeldAt: null,
  videoHandoffRemakeReason: null,
  scheduledPublishAt: null,
  clipReviewStatus: "NONE",
  clipReviewRequestedAt: null,
  clipReviewDecidedAt: null,
  autoMontageStatus: "NONE",
  autoMontageUpdatedAt: null,
};

describe("property work status evidence", () => {
  it("uses actual delivery for time with the editor and distinguishes slot reservation and manual upload", () => {
    expect(summarizePropertyWork(row, now)).toMatchObject({ phase: "EDITOR_DELIVERY_UNCONFIRMED", elapsed: { elapsedDays: 7 } });
    expect(summarizePropertyWork({ ...row, videoHandoffDeliveredAt: delivered }, now)).toMatchObject({
      phase: "WITH_EDITOR", elapsed: { elapsedDays: 2, sinceDushanbe: "2026-11-02 17:00" },
    });
    expect(summarizePropertyWork({ ...row, videoHandoffManualSince: delivered }, now).phase).toBe("WAITING_FOR_MANUAL_UPLOAD");
    expect(summarizePropertyWork({ ...row, videoHandoffDispatchStartedAt: new Date("2026-11-04T12:55:00Z") }, now).phase).toBe("SENDING_TO_EDITOR");
  });

  it("does not call synthetic receipt publication or reuse an old automontage", () => {
    const received = { ...row, videoHandoffStatus: "RECEIVED" } as const;
    expect(summarizePropertyWork(received, now).phase).toBe("EDITING_PATH_UNCONFIRMED");
    const old = { ...received, autoMontageStatus: "READY", autoMontageUpdatedAt: new Date("2026-10-27") } as const;
    expect(summarizePropertyWork(old, now).phase).toBe("EDITING_PATH_UNCONFIRMED");
    expect(summarizePropertyWork({ ...received, videoHandoffReceivedAt: delivered, videoHandoffFinalPath: "/private/video" }, now, "GIVEN_UP").phase)
      .toBe("PUBLICATION_FAILED");
  });

  it("limits queue listing to the agent’s own properties when the company queue is restricted", async () => {
    const agent = { id: "agent-1", role: "AGENT", permissions: new Set() } as AssistantActor;
    db.count.mockResolvedValueOnce(12).mockResolvedValueOnce(1).mockResolvedValueOnce(6);
    expect(await getPropertyWorkStatusTool.run({ scope: "queue" }, { actor: agent })).toMatchObject({
      scope: "MY_QUEUE", total: 12, shown: 0, withEditor: 1, waitingForEditor: 6,
    });
    expect(db.transaction).toHaveBeenLastCalledWith(expect.any(Array), { isolationLevel: "RepeatableRead" });
    const ownScope = {
      AND: [{ OR: [{ status: "EDITING" }, { videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] } }] }],
      OR: expect.any(Array),
      deleteRequests: { none: { status: "PENDING", requestedById: "agent-1" } },
    };
    expect(db.count).toHaveBeenNthCalledWith(1, { where: expect.objectContaining(ownScope) });
    expect(db.count).toHaveBeenNthCalledWith(2, { where: expect.objectContaining({
      ...ownScope, videoHandoffStatus: "SENT_TO_EDITOR", videoHandoffDeliveredAt: { not: null }, videoHandoffManualSince: null,
    }) });
    expect(db.count).toHaveBeenNthCalledWith(3, { where: expect.objectContaining({ ...ownScope, videoHandoffStatus: "QUEUED" }) });
    const director = { ...agent, role: "DIRECTOR" };
    expect(await getPropertyWorkStatusTool.run({ scope: "queue" }, { actor: director })).toMatchObject({ scope: "COMPANY_QUEUE" });
    const where = (db.count.mock.lastCall as unknown as [{ where: object }])[0].where;
    expect(where).not.toHaveProperty("OR");
  });

  it("includes an active remake even while the owned listing remains available", async () => {
    const publishedRemake = {
      ...row, status: "AVAILABLE", videoHandoffStatus: "QUEUED", videoHandoffRemakeReason: "CARD_DATA_CHANGED",
    } as const;
    const actor = { id: "agent-1", role: "AGENT", permissions: new Set() } as AssistantActor;
    for (const scope of ["queue", "mine"] as const) {
      db.findMany.mockResolvedValueOnce([publishedRemake]);
      expect(await getPropertyWorkStatusTool.run({ scope }, { actor })).toMatchObject({
        items: [{ phase: "WAITING_FOR_EDITOR", remake: true }],
      });
      expect(db.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          AND: [{ OR: expect.arrayContaining([{ videoHandoffStatus: { in: ["QUEUED", "SENT_TO_EDITOR"] } }]) }],
          OR: expect.any(Array),
        }),
      }));
    }
  });
});
