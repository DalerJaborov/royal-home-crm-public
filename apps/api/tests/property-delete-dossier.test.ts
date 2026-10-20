import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { buildPropertyDeleteDossiers } from "../src/lib/propertyDeleteDossier.js";

/**
 * ДОСЬЕ К КНОПКЕ «ОДОБРИТЬ» (заявка на удаление объекта).
 *
 * Дословная тревога владельца: «я могу по ошибке одобрить, не зная всей картины
 * — агент расскажет, я одобрю». Проверяется, что картина собирается из фактов
 * базы и что она НЕ поднимает тревогу там, где всё чисто: досье, которое кричит
 * на каждую вторую заявку, перестают читать на третий день.
 */

const runId = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-16T07:00:00Z");
const SHOWING_AT = new Date(NOW.getTime() - 5 * DAY);

let agentId: string;
let buyerId: string;
let sellerId: string;
let propertyId: string;
let quietPropertyId: string;
let districtId: string;
let phoneSeq = 0;

function phone(): string {
  phoneSeq++;
  return `+9927${String(runId).slice(-6)}${String(phoneSeq).padStart(2, "0")}`;
}

async function makeProperty(title: string, seller: string | null): Promise<string> {
  const p = await prisma.property.create({
    data: {
      title: `${title} ${runId}`,
      type: "APARTMENT",
      areaSqm: 55,
      price: 40000,
      currency: "TJS",
      districtId,
      address: "Тест",
      condition: "GOOD",
      status: "AVAILABLE",
      sellerClientId: seller,
    },
  });
  return p.id;
}

async function makeSilentShowing(onProperty: string) {
  const showing = await prisma.interaction.create({
    data: {
      clientId: buyerId,
      agentId,
      type: "SHOWING",
      propertyId: onProperty,
      notes: "Показ",
      nextActionDate: SHOWING_AT,
      createdAt: new Date(SHOWING_AT.getTime() - HOUR),
    },
  });
  await prisma.postShowingCall.create({
    data: {
      showingId: showing.id,
      clientId: buyerId,
      agentId,
      propertyId: onProperty,
      scheduledFor: new Date(SHOWING_AT.getTime() + 2 * HOUR),
      status: "GIVEN_UP",
      attempts: 2,
    },
  });
  return showing.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-досье-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Умед Агентов", phone: phone(), role: "AGENT", passwordHash: "x" } })
  ).id;
  buyerId = (
    await prisma.client.create({
      data: {
        fullName: `Далер Покупателев ${runId}`,
        phone: phone(),
        source: "PHONE_CALL",
        kind: "BUYER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  sellerId = (
    await prisma.client.create({
      data: {
        fullName: `Собственник ${runId}`,
        phone: phone(),
        source: "WALK_IN",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = await makeProperty("Объект с показом", sellerId);
  quietPropertyId = await makeProperty("Объект без показов", sellerId);
});

afterAll(async () => {
  await prisma.sellerProbeCall.deleteMany({ where: { agentId } });
  await prisma.postShowingCall.deleteMany({ where: { clientId: buyerId } });
  await prisma.deal.deleteMany({ where: { propertyId: { in: [propertyId, quietPropertyId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.property.deleteMany({ where: { id: { in: [propertyId, quietPropertyId] } } });
  await prisma.client.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.sellerProbeCall.deleteMany({ where: { agentId } });
  await prisma.postShowingCall.deleteMany({ where: { clientId: buyerId } });
  await prisma.deal.deleteMany({ where: { propertyId: { in: [propertyId, quietPropertyId] } } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.client.update({ where: { id: sellerId }, data: { lastClientMessageAt: null } });
});

describe("досье к заявке на удаление", () => {
  it("показов не было — сказать об этом прямо и тревогу не поднимать", async () => {
    const dossier = (await buildPropertyDeleteDossiers([quietPropertyId], NOW)).get(quietPropertyId);
    expect(dossier?.showingsCount).toBe(0);
    expect(dossier?.lines[0]).toContain("Показов по объекту не было");
    expect(dossier?.hasConcerns).toBe(false);
  });

  it("показывали, обе стороны замолчали, сделки нет — вот это владелец и должен увидеть", async () => {
    await makeSilentShowing(propertyId);

    const dossier = (await buildPropertyDeleteDossiers([propertyId], NOW)).get(propertyId);
    expect(dossier?.showingsCount).toBe(1);
    expect(dossier?.buyerSilent).toBe(true);
    expect(dossier?.sellerAnsweredAfterShowing).toBe(false);
    expect(dossier?.hasDeal).toBe(false);
    expect(dossier?.hasConcerns).toBe(true);
    expect(dossier?.lines.join(" ")).toContain("Умед Агентов");
    expect(dossier?.lines.join(" ")).toContain("Далер Покупателев");
  });

  it("собственник отвечал после показа — это в пользу агента", async () => {
    await makeSilentShowing(propertyId);
    await prisma.client.update({
      where: { id: sellerId },
      data: { lastClientMessageAt: new Date(SHOWING_AT.getTime() + DAY) },
    });

    const dossier = (await buildPropertyDeleteDossiers([propertyId], NOW)).get(propertyId);
    expect(dossier?.sellerAnsweredAfterShowing).toBe(true);
    expect(dossier?.lines.join(" ")).not.toContain("тоже не отвечал");
  });

  it("есть сделка — круг закрыт, тревоги нет даже при тишине", async () => {
    await makeSilentShowing(propertyId);
    await prisma.deal.create({ data: { clientId: buyerId, propertyId, agentId, stage: "NEGOTIATION" } });

    const dossier = (await buildPropertyDeleteDossiers([propertyId], NOW)).get(propertyId);
    expect(dossier?.hasDeal).toBe(true);
    expect(dossier?.hasConcerns).toBe(false);
  });

  it("итог звонка собственнику попадает в досье словами", async () => {
    const showingId = await makeSilentShowing(propertyId);
    const call = await prisma.postShowingCall.findFirstOrThrow({ where: { showingId } });
    await prisma.sellerProbeCall.create({
      data: {
        postShowingCallId: call.id,
        propertyId,
        sellerClientId: sellerId,
        agentId,
        scheduledFor: NOW,
        status: "DONE",
        outcome: "SOLD_ELSEWHERE",
        quote: "я уже продал",
      },
    });

    const dossier = (await buildPropertyDeleteDossiers([propertyId], NOW)).get(propertyId);
    expect(dossier?.sellerProbeOutcome).toBe("SOLD_ELSEWHERE");
    expect(dossier?.lines.join(" ")).toContain("уже продал");
    expect(dossier?.hasConcerns).toBe(true);
  });

  it("считается пачкой: два объекта — один набор запросов", async () => {
    await makeSilentShowing(propertyId);

    const map = await buildPropertyDeleteDossiers([propertyId, quietPropertyId], NOW);
    expect(map.size).toBe(2);
    expect(map.get(propertyId)?.showingsCount).toBe(1);
    expect(map.get(quietPropertyId)?.showingsCount).toBe(0);
  });
});
