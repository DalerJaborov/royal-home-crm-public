import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/ai/client.js", async importOriginal => ({ ...await importOriginal<typeof import("../src/ai/client.js")>(), callAiText: vi.fn() }));
import { callAiText } from "../src/ai/client.js";
import { prisma } from "../src/db.js";
import { resolveCurrentClientIntents, resolveClientIntentsAutomatically } from "../src/lib/clientIntentResolution.js";

const buyQuote = "Я сейчас ищу квартиру для покупки";
const sellQuote = "Я сейчас продаю свою квартиру";
const text = `Клиент: ${buyQuote}. ${sellQuote}.`;
const extraction = (id = "call:test") => ({
  buying: { state: "ACTIVE" as const, sourceId: id, quote: buyQuote },
  selling: { state: "ACTIVE" as const, sourceId: id, quote: sellQuote }, ambiguous: false,
});

describe("current role evidence", () => {
  it("requires actual quoted sources instead of a historical role flag", () => {
    expect(resolveCurrentClientIntents({ extraction: extraction(), sources: [], activeSellerProperty: false, currentBuyerRequest: true }))
      .toMatchObject({ dualIntent: false });
  });
  it("accepts explicit current client facts and flags contradictory current records", () => {
    const sources = [{ id: "call:test", text, kind: "CALL" as const, at: new Date().toISOString() }];
    expect(resolveCurrentClientIntents({ extraction: extraction(), sources, activeSellerProperty: false, currentBuyerRequest: false }))
      .toMatchObject({ dualIntent: true, needsReview: false });
    expect(resolveCurrentClientIntents({ extraction: { ...extraction(), ambiguous: true }, sources, activeSellerProperty: true, currentBuyerRequest: true }))
      .toMatchObject({ dualIntent: false, needsReview: true });
  });
  it("can use simultaneous active purchase and sale records without model guesses", () => {
    expect(resolveCurrentClientIntents({ extraction: null, sources: [], activeSellerProperty: true, currentBuyerRequest: true }))
      .toMatchObject({ dualIntent: true, needsReview: false });
  });
  it("rejects an agent quotation or an unattributed call even if the model claims confidence", () => {
    for (const text of [`Агент: ${buyQuote}. ${sellQuote}.`, `${buyQuote}. ${sellQuote}.`]) {
      expect(resolveCurrentClientIntents({ extraction: extraction(), sources: [{ id: "call:test", text, kind: "CALL", at: new Date().toISOString() }], activeSellerProperty: false, currentBuyerRequest: true }))
        .toMatchObject({ dualIntent: false, needsReview: true });
    }
  });
  it("does not accept an older affirmative quote over a later explicit client withdrawal", () => {
    const sources = [{ id: "call:test", text, kind: "CALL" as const, at: "2026-10-24T10:00:00Z" },
      { id: "new", text: "Я больше не продаю квартиру.", kind: "MESSAGE" as const, at: "2026-10-25T10:00:00Z" }];
    expect(resolveCurrentClientIntents({ extraction: extraction(), sources, activeSellerProperty: true, currentBuyerRequest: true }))
      .toMatchObject({ dualIntent: false, needsReview: true, selling: "INACTIVE" });
  });
});

const run = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const clients: string[] = [];
const propertyIds: string[] = [];
let agentId: string;
async function fixture() {
  const c = await prisma.client.create({ data: { fullName: `Intent fixture ${run}`, phone: `test-intent-${run}-${clients.length}`,
    source: "PHONE_CALL", kind: "BUYER", desiredRooms: 2, requirementsFieldsKind: "BUYER", assignedAgentId: agentId, acceptedAt: new Date() } });
  clients.push(c.id);
  const call = await prisma.interaction.create({ data: { clientId: c.id, agentId, type: "CALL", notes: "Role evidence fixture",
    transcript: text, recordingDurationSec: 45, callAttempt: "TALKED" } });
  return { c, call };
}
beforeAll(async () => { agentId = (await prisma.agent.create({ data: { fullName: "Intent fixture agent", phone: `test-intent-agent-${run}`, role: "AGENT", passwordHash: "test-unused" } })).id; });
beforeEach(() => { vi.mocked(callAiText).mockReset(); });
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clients } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clients } } });
  await prisma.agent.delete({ where: { id: agentId } });
});

describe("automatic roles preserve human decisions", () => {
  async function property(clientId: string) {
    const row = await prisma.property.create({ data: { title: `Intent property ${run}`, type: "APARTMENT", areaSqm: 60, rooms: 2, price: 500000, currency: "TJS", address: "Synthetic fixture", condition: "GOOD", status: "AVAILABLE", sellerClientId: clientId } });
    propertyIds.push(row.id); return row;
  }
  it("adds both roles automatically without switching primary kind, owner or repeating the model call", async () => {
    const { c, call } = await fixture();
    vi.mocked(callAiText).mockResolvedValue(extraction(`call:${call.id}`));
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("updated");
    const saved = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved).toMatchObject({ kind: "BUYER", assignedAgentId: agentId, dualIntent: true, dualIntentDecisionSource: "AUTO" });
    expect(saved.dualIntentConfirmedAt).not.toBeNull();
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("unchanged");
    expect(callAiText).toHaveBeenCalledTimes(1);
  });
  it("keeps an explicit human single-role decision without calling AI", async () => {
    const { c } = await fixture();
    await prisma.client.update({ where: { id: c.id }, data: { dualIntentDecisionSource: "MANUAL", dualIntent: false } });
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("manual");
    expect(callAiText).not.toHaveBeenCalled();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).dualIntent).toBe(false);
  });
  it("cannot overwrite an administrator decision made while classification is running", async () => {
    const { c, call } = await fixture();
    vi.mocked(callAiText).mockImplementationOnce(async () => {
      await prisma.client.update({ where: { id: c.id }, data: { dualIntentDecisionSource: "MANUAL", dualIntent: false } });
      return extraction(`call:${call.id}`);
    });
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("unchanged");
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ dualIntent: false, dualIntentDecisionSource: "MANUAL" });
  });
  it("does not use role evidence from before the current assignment", async () => {
    const { c, call } = await fixture();
    await prisma.interaction.update({ where: { id: call.id }, data: { createdAt: new Date(c.assignedAt.getTime() - 1000) } });
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("updated");
    expect(callAiText).not.toHaveBeenCalled();
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ dualIntent: false, dualIntentNeedsReview: true });
  });
  it("rejects a stale analysis when its related transcript changes while AI runs", async () => {
    const { c, call } = await fixture();
    vi.mocked(callAiText).mockImplementationOnce(async () => {
      await prisma.interaction.update({ where: { id: call.id }, data: { transcript: "Клиент: Я больше не продаю квартиру." } });
      return extraction(`call:${call.id}`);
    });
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("unchanged");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).dualIntent).toBe(false);
  });
  it("uses current structural facts without AI keys, then flags vanished support for review", async () => {
    const { c, call } = await fixture();
    await prisma.interaction.delete({ where: { id: call.id } });
    const owned = await property(c.id);
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("updated");
    expect(callAiText).not.toHaveBeenCalled();
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).dualIntent).toBe(true);
    await prisma.property.update({ where: { id: owned.id }, data: { status: "WITHDRAWN" } });
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("updated");
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ dualIntent: true, dualIntentNeedsReview: true });
  });
  it("rechecks seller properties changed during classification before applying the result", async () => {
    const { c, call } = await fixture();
    const owned = await property(c.id);
    vi.mocked(callAiText).mockImplementationOnce(async () => {
      await prisma.property.update({ where: { id: owned.id }, data: { status: "WITHDRAWN" } });
      return extraction(`call:${call.id}`);
    });
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("unchanged");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).dualIntent).toBe(false);
  });
  it("does not treat a closed purchase as an active structured buying request", async () => {
    const { c, call } = await fixture();
    await prisma.interaction.delete({ where: { id: call.id } });
    await prisma.client.update({ where: { id: c.id }, data: { status: "DEAL_CLOSED" } });
    await property(c.id);
    await resolveClientIntentsAutomatically(c.id);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).dualIntent).toBe(false);
  });
  it("keeps unclear call authorship for review even when the structured records suggest both roles", async () => {
    const { c, call } = await fixture();
    await property(c.id);
    await prisma.interaction.update({ where: { id: call.id }, data: { transcript: "Я больше не продаю квартиру." } });
    await resolveClientIntentsAutomatically(c.id);
    expect(callAiText).not.toHaveBeenCalled();
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ dualIntent: false, dualIntentNeedsReview: true });
  });
  it("does not hide the remaining seller side when the primary buyer role is explicitly inactive", async () => {
    const { c, call } = await fixture();
    await prisma.client.update({ where: { id: c.id }, data: { dualIntent: true, dualIntentConfirmedAt: new Date(), dualIntentDecisionSource: "AUTO" } });
    const noBuy = "Я больше не покупаю квартиру.";
    await prisma.interaction.update({ where: { id: call.id }, data: { transcript: `Клиент: ${noBuy}\nКлиент: ${sellQuote}.` } });
    vi.mocked(callAiText).mockResolvedValue({ ...extraction(`call:${call.id}`), buying: { state: "INACTIVE", sourceId: `call:${call.id}`, quote: noBuy } });
    await resolveClientIntentsAutomatically(c.id);
    expect(await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ kind: "BUYER", dualIntent: true, dualIntentNeedsReview: true, assignedAgentId: agentId });
  });
  it("ignores completed assignments and preserves the previous decision on unavailable AI", async () => {
    const { c } = await fixture();
    vi.mocked(callAiText).mockResolvedValue(null);
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("unavailable");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).dualIntentAnalyzedHash).toBeNull();
    await prisma.client.update({ where: { id: c.id }, data: { assignmentCompletedAt: new Date() } });
    vi.mocked(callAiText).mockClear();
    expect(await resolveClientIntentsAutomatically(c.id)).toBe("unchanged");
    expect(callAiText).not.toHaveBeenCalled();
  });
});
