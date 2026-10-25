import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ timeline: vi.fn(), episode: null as any, events: [] as any[], tasks: vi.fn(),
  client: {} as any, settings: {} as any, properties: [] as any[] }));
vi.mock("../src/db.js", async importOriginal => {
  const prisma: any = {
    $disconnect: vi.fn(), $queryRaw: vi.fn(async () => []),
    client: { findUniqueOrThrow: vi.fn(async () => mock.client) },
    settings: { findUniqueOrThrow: vi.fn(async () => mock.settings) },
    property: { findMany: vi.fn(async () => mock.properties) },
    agent: { findUnique: vi.fn(async () => ({ role: "MANAGER", isActive: true })) },
    interaction: { updateMany: mock.tasks },
    sellerControlEpisode: {
      findUnique: vi.fn(async () => mock.episode), findUniqueOrThrow: vi.fn(async () => mock.episode),
      create: vi.fn(async ({ data }: any) => (mock.episode = { id: "episode", revision: 1, status: "AGENT_TASK", ropReceiptAt: null,
        createdAt: new Date("2026-10-25T10:00:00Z"), ropReceiptDueAt: null, ropActionDueAt: null, resolvedAt: null, ...data })),
      update: vi.fn(async ({ data }: any) => (mock.episode = { ...mock.episode, ...data,
        revision: data.revision?.increment ? mock.episode.revision + data.revision.increment : mock.episode.revision })),
      findMany: vi.fn(async () => mock.episode ? [mock.episode] : []),
    },
    sellerControlEvent: { findUnique: vi.fn(async ({ where }: any) => mock.events.find(event => event.requestKey === where.requestKey)),
      findMany: vi.fn(async () => mock.events.filter(event => ["CONTROL_PAUSED", "CONTROL_RESUMED"].includes(event.type))),
      create: vi.fn(async ({ data }: any) => { mock.events.push(data); return data; }) },
  };
  prisma.$transaction = async (callback: any) => callback(prisma);
  return { ...await importOriginal<typeof import("../src/db.js")>(), prisma };
});
vi.mock("../src/lib/timeline.js", async importOriginal => ({ ...(await importOriginal<typeof import("../src/lib/timeline.js")>()), logTimeline: mock.timeline }));
import { commandSellerControl, runSellerControlTick, startSellerControl } from "../src/lib/sellerControlEpisodes.js";
const now = new Date("2026-10-25T10:00:00Z");
const start = { clientId: "client", ropAgentId: "rop", actorId: "admin", requestKey: "start" };

describe("seller control execution boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks(); vi.unstubAllEnvs(); mock.episode = null; mock.events = [];
    mock.client = { id: "client", kind: "SELLER", status: "NEW", workStatus: "ACTIVE", assignedAgentId: "agent",
      assignedAt: now, sellerDeclaredPropertyCount: 3, sellerDeclaredPropertyCountAt: now };
    mock.settings = { sellerControlConfig: { agentDueWorkingDays: 1, ropReceiptDueWorkingDays: 1, ropActionDueWorkingDays: 1 }, companyDaysOff: [] };
    mock.properties = [{ status: "AVAILABLE" }, { status: "AVAILABLE" }, { status: "AWAITING_PHOTOS" }];
    mock.timeline.mockResolvedValue({ id: "ordinary-task" });
    mock.tasks.mockResolvedValue({ count: 0 });
  });
  it("preview creates a durable episode with 2 accepted objects, no ordinary task", async () => {
    const episode = await startSellerControl(start, now);
    expect(episode.baselineAccepted).toBe(2);
    expect(episode.executionMode).toBe("PREVIEW");
    expect(episode.events.create.type).toBe("SIMULATED_STARTED");
    expect(mock.timeline).not.toHaveBeenCalled();
    expect(await startSellerControl({ ...start, requestKey: "retry" }, now)).toBe(episode);
  });
  it("unset configuration and absent trusted gate cannot execute", async () => {
    mock.settings.sellerControlConfig = {};
    await expect(startSellerControl(start, now)).rejects.toThrow("NOT_CONFIGURED");
    await expect(startSellerControl({ ...start, live: true }, now)).rejects.toThrow("Исполнение не включено");
    expect(await runSellerControlTick(now)).toEqual({ mode: "PREVIEW", processed: 0 });
    expect(mock.timeline).not.toHaveBeenCalled();
  });
  it("stale revisions cannot change stage; retry returns its recorded event once", async () => {
    await startSellerControl(start, now);
    await expect(commandSellerControl("episode", { requestKey: "a", revision: 2, action: "RECEIPT" }, "admin", { simulated: true }, now)).rejects.toThrow("Данные изменились");
    mock.episode.status = "ROP_RECEIPT";
    const command = { requestKey: "a", revision: 1, action: "RECEIPT" as const };
    const result = await commandSellerControl("episode", command, "admin", { simulated: true }, now);
    expect(result.event).toBe("SIMULATED_ROP_RECEIVED");
    expect((await commandSellerControl("episode", command, "admin", { simulated: true }, now)).replay).toBe(true);
    expect(mock.events).toHaveLength(1);
    expect(mock.timeline).not.toHaveBeenCalled();
  });
  it("simulated history never counts as real receipt", async () => {
    await startSellerControl(start, now);
    await expect(commandSellerControl("episode", { requestKey: "a", revision: 1, action: "RECEIPT" }, "rop", { taskId: "fake" }, now)).rejects.toThrow("Задача не назначена вам");
  });
  it("trusted isolated LIVE execution creates only neutral tasks, and rejects foreign assignee", async () => {
    vi.stubEnv("SELLER_CONTROL_INTERNAL_LIVE", "explicitly-approved");
    await startSellerControl({ ...start, live: true }, now);
    expect(mock.timeline.mock.calls[0][0]).toMatchObject({ actor: { subjectAgentId: "agent" }, notes: "Уточните план работы с клиентом и дополните сведения об объектах" });
    await commandSellerControl("episode", { requestKey: "tick", revision: 1, action: "TICK" }, null, {}, new Date("2026-10-27T10:00:00Z"));
    expect(mock.timeline.mock.calls[1][0].actor.subjectAgentId).toBe("rop");
    await expect(commandSellerControl("episode", { requestKey: "foreign", revision: 2, action: "RECEIPT" }, "other-manager", { taskId: "ordinary-task" }, now)).rejects.toThrow("Задача не назначена вам");
  });
});
