import { beforeEach, describe, expect, it, vi } from "vitest";

/** Комментарий на «управляемой» ветке ядра (lane managed): номер тоже становится заявкой (17.11.2026). Без базы. */
const mocks = vi.hoisted(() => ({
  lane: vi.fn(), prepare: vi.fn(), finish: vi.fn(), createLead: vi.fn(), findOwners: vi.fn(), log: vi.fn(),
}));
vi.mock("../src/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db.js")>()), prisma: { $disconnect: async () => undefined },
}));
vi.mock("../src/lib/customerPublicAgentTurn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/customerPublicAgentTurn.js")>()),
  publicAgentCommentLane: mocks.lane, prepareCustomerPublicAgentDraft: mocks.prepare, finishPublicAgentDecision: mocks.finish,
}));
vi.mock("../src/services/leads/intake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/leads/intake.js")>()), createLeadFromChannel: mocks.createLead,
}));
vi.mock("../src/lib/clientPhones.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/clientPhones.js")>()), findPhoneOwners: mocks.findOwners,
}));
vi.mock("../src/lib/workingHours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/workingHours.js")>()), isWithinWorkingHours: async () => true,
}));
vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()), logSystemError: mocks.log,
}));

import { handleComment, type QueuedComment } from "../src/messengers/comments.js";

const row = (text: string) =>
  ({ id: "r1", channel: "INSTAGRAM", commentId: "c1", authorId: "a1", authorName: "t", text, mediaId: "m", status: "WORKING" }) as unknown as QueuedComment;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lane.mockResolvedValue("managed");
  mocks.prepare.mockResolvedValue({ status: "skip", reason: "no_reply_needed", principal: {} });
  mocks.finish.mockResolvedValue(true);
  mocks.findOwners.mockResolvedValue([]);
  mocks.createLead.mockResolvedValue({ clientId: "c", created: true });
});

describe("handleComment, lane managed", () => {
  it("номер в комментарии — заявка; повтор при известном номере дубля не даёт", async () => {
    expect(await handleComment(row("Нарх чанд? 900000001"))).toBe("skipped");
    expect(mocks.createLead).toHaveBeenCalledTimes(1);
    expect(mocks.createLead.mock.calls[0]![0]).toMatchObject({ phone: "+992900000001" });
    mocks.findOwners.mockResolvedValue([{ id: "c", deletedAt: null }]);
    await handleComment(row("Нарх чанд? 900000001"));
    expect(mocks.createLead).toHaveBeenCalledTimes(1);
  });

  it("модерация ядра (спам/реклама) номер клиентом не делает; номер компании тоже", async () => {
    mocks.prepare.mockResolvedValue({ status: "moderation_proposal", action: "hide", reason: "spam", principal: {} });
    await handleComment(row("Продам 900000001"));
    expect(mocks.createLead).not.toHaveBeenCalled();
    mocks.prepare.mockResolvedValue({ status: "skip", reason: "no_reply_needed", principal: {} });
    await handleComment(row("Звоните +992 44 650 14 14"));
    expect(mocks.createLead).not.toHaveBeenCalled();
  });
});
