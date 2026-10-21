import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TxClient } from "../src/db.js";
import type { CustomerFence } from "@royal-home/shared";
import { readRecruitmentAnsweredFactTx } from "../src/lib/recruitmentAnsweredFact.js";
import { recruitmentRequiredQuestion } from "../src/ai/customerAgentRecruitmentProtocol.js";

vi.mock("../src/lib/customerOutboxCodec.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/customerOutboxCodec.js")>(),
  decodeCustomerOutboxPayload: vi.fn((row: { syntheticText: string }) => ({ kind: "text", text: row.syntheticText })),
}));
const fence: CustomerFence = { inquiryId: randomUUID(), nativeId: randomUUID(), ownerToken: randomUUID(),
  endpoint: { endpointScopeId: randomUUID(), channel: "INSTAGRAM", accountId: randomUUID(), peerId: "synthetic-peer", threadId: "synthetic-thread" },
  stateRevision: "5", intentRevision: "2", bindingRevision: "1", ownershipEpoch: "1", scopeRevision: "1", policyRevision: "1" };
const eventKey = "a".repeat(64), earlierEvent = "b".repeat(64), partId = randomUUID();
function fixture() {
  const text = recruitmentRequiredQuestion("age", "ru");
  const messages = [{ role: "assistant", customerOutboxPartId: partId, content: text },
    { role: "user", content: "29", customerPropertyAdmission: { eventKey } }];
  const row = { id: partId, ticketEventKey: earlierEvent, sourceKey: earlierEvent, fenceJson: fence,
    endpointScopeId: fence.endpoint.endpointScopeId, claimRevision: 1n, syntheticText: text,
    attempts: [{ endpointScopeId: fence.endpoint.endpointScopeId, claimRevision: 1n }] };
  const read = vi.fn().mockResolvedValue(row);
  return { messages, row, read, tx: { customerOutboxPart: { findFirst: read } } as unknown as TxClient,
    source: { fence, eventKey, order: "20" } };
}
describe("accepted recruitment question source", () => {
  it("reads only the exact immediately preceding own-inquiry accepted projected question", async () => {
    const f = fixture();
    expect(await readRecruitmentAnsweredFactTx(f.tx, f.source, f.messages)).toBe("age");
    expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      inquiryId: fence.inquiryId, status: "ACCEPTED", sourceKind: "BOT_TURN", mode: "LIVE",
      projectionRecordedAt: { not: null }, ticket: { is: { order: { lt: 20n } } },
    }) }));
  });
  it("does not infer a question from unaccepted/native-only text or an interrupted exchange", async () => {
    const f = fixture(); f.read.mockResolvedValue(null);
    expect(await readRecruitmentAnsweredFactTx(f.tx, f.source, f.messages)).toBeNull();
    f.messages.splice(1, 0, { role: "user", content: "other input" } as typeof f.messages[number]);
    expect(await readRecruitmentAnsweredFactTx(f.tx, f.source, f.messages)).toBeNull();
  });
  it.each(["binding", "endpoint", "owner", "receipt", "text", "source"])("holds mismatched %s evidence", async kind => {
    const f = fixture();
    if (kind === "binding") f.row.fenceJson = { ...fence, bindingRevision: "2" };
    if (kind === "endpoint") f.row.fenceJson = { ...fence, endpoint: { ...fence.endpoint, peerId: "foreign-peer" } };
    if (kind === "owner") f.row.fenceJson = { ...fence, ownerToken: randomUUID() };
    if (kind === "receipt") f.row.attempts = [];
    if (kind === "text") f.row.syntheticText = "arbitrary similar question";
    if (kind === "source") f.row.sourceKey = "c".repeat(64);
    expect(await readRecruitmentAnsweredFactTx(f.tx, f.source, f.messages)).toBeNull();
  });
});
