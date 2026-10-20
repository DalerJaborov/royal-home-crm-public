import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { mergeClients } from "../src/lib/clientMerge.js";

/**
 * CRM-05 (аудит 04.10.2026): слияние переносило бюджет дубля в основную карточку
 * без валюты. Основная в USD с пустым бюджетом + дубль в TJS с 500000 давали
 * 500000 долларов. Бюджет и его валюта переезжают только вместе.
 */
const runId = Date.now();
let agentId = "";
const clientIds: string[] = [];
let seq = 0;

async function pair(
  primary: { currency: "USD" | "TJS"; budgetMin?: number; budgetMax?: number },
  duplicate: { currency: "USD" | "TJS"; budgetMin?: number; budgetMax?: number }
) {
  seq++;
  const p = await prisma.client.create({
    data: { fullName: `Основной бюджет ${seq} ${runId}`, phone: `+9929301${seq}${String(runId).slice(-6)}`, kind: "BUYER", source: "PHONE_CALL", assignedAgentId: agentId, ...primary },
  });
  const d = await prisma.client.create({
    data: { fullName: `Дубль бюджет ${seq} ${runId}`, phone: `+9929302${seq}${String(runId).slice(-6)}`, kind: "BUYER", source: "WALK_IN", assignedAgentId: agentId, ...duplicate },
  });
  clientIds.push(p.id, d.id);
  return { primaryId: p.id, duplicateId: d.id };
}

const num = (v: unknown) => (v == null ? null : Number(v));

beforeAll(async () => {
  agentId = (await prisma.agent.create({ data: { fullName: `Агент бюджета ${runId}`, phone: `+992928${String(runId).slice(-8)}`, role: "AGENT", passwordHash: "x" } })).id;
});
afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
});

describe("слияние клиентов: бюджет дубля и его валюта (CRM-05)", () => {
  it("основная USD без бюджета + дубль TJS: бюджет переезжает вместе с валютой TJS", async () => {
    const { primaryId, duplicateId } = await pair({ currency: "USD" }, { currency: "TJS", budgetMax: 500000 });
    const merged = await mergeClients(primaryId, duplicateId, agentId, "тест");
    expect(num(merged.budgetMax)).toBe(500000);
    expect(merged.currency).toBe("TJS");
  });

  it("у основной уже есть бюджет в USD, дубль в TJS: бюджет дубля не копируется", async () => {
    const { primaryId, duplicateId } = await pair({ currency: "USD", budgetMin: 30000 }, { currency: "TJS", budgetMax: 500000 });
    const merged = await mergeClients(primaryId, duplicateId, agentId, "тест");
    expect(num(merged.budgetMin)).toBe(30000);
    expect(num(merged.budgetMax)).toBeNull();
    expect(merged.currency).toBe("USD");
  });

  it("обе в USD: границы дополняют друг друга, как раньше", async () => {
    const { primaryId, duplicateId } = await pair({ currency: "USD", budgetMin: 30000 }, { currency: "USD", budgetMax: 60000 });
    const merged = await mergeClients(primaryId, duplicateId, agentId, "тест");
    expect(num(merged.budgetMin)).toBe(30000);
    expect(num(merged.budgetMax)).toBe(60000);
    expect(merged.currency).toBe("USD");
  });
});
