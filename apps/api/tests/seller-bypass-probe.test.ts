import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  buildBypassDossier,
  findSellerProbeCandidates,
  SELLER_PROBE_MIN_SIGNALS,
} from "../src/lib/sellerBypassProbe.js";

/**
 * ПРОВЕРКА СО СТОРОНЫ ПРОДАВЦА (порог 5 воронки, решение владельца 16.09.2026:
 * «звонить не всем продавцам, у которых был показ»).
 *
 * Здесь проверяется ровно то, ради чего модуль написан: что круг сужается САМ,
 * до всякого звонка, и что меньше трёх сошедшихся признаков собственника не
 * беспокоят.
 */

const runId = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date("2026-09-16T07:00:00Z");
const SHOWING_AT = new Date(NOW.getTime() - 4 * DAY);

let agentId: string;
let buyerId: string;
let sellerId: string;
let propertyId: string;
let districtId: string;
let phoneSeq = 0;

function phone(): string {
  phoneSeq++;
  return `+9929${String(runId).slice(-6)}${String(phoneSeq).padStart(2, "0")}`;
}

async function makeCandidate(options: {
  propertyOnShowing?: boolean;
  status?: "GIVEN_UP" | "DONE";
  outcome?: "UNCLEAR" | "LIKED";
}): Promise<string> {
  const showing = await prisma.interaction.create({
    data: {
      clientId: buyerId,
      agentId,
      type: "SHOWING",
      propertyId: options.propertyOnShowing === false ? null : propertyId,
      notes: "Показ",
      nextActionDate: SHOWING_AT,
      createdAt: new Date(SHOWING_AT.getTime() - HOUR),
    },
  });
  const call = await prisma.postShowingCall.create({
    data: {
      showingId: showing.id,
      clientId: buyerId,
      agentId,
      propertyId: options.propertyOnShowing === false ? null : propertyId,
      scheduledFor: new Date(SHOWING_AT.getTime() + 2 * HOUR),
      status: options.status ?? "GIVEN_UP",
      outcome: options.outcome ?? null,
      attempts: 2,
      createdAt: new Date(SHOWING_AT.getTime() + 2 * HOUR),
    },
  });
  return call.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Тест-район-продавец-${runId}` } })).id;
  agentId = (
    await prisma.agent.create({ data: { fullName: "Агент Проверкин", phone: phone(), role: "AGENT", passwordHash: "x" } })
  ).id;
  buyerId = (
    await prisma.client.create({
      data: {
        fullName: `Покупатель ${runId}`,
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
        // WALK_IN — карточку завёл агент руками, номер никем не проверен.
        source: "WALK_IN",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    })
  ).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект продавца ${runId}`,
        type: "APARTMENT",
        areaSqm: 70,
        price: 60000,
        currency: "TJS",
        districtId,
        address: "Айни 1",
        condition: "GOOD",
        status: "AVAILABLE",
        sellerClientId: sellerId,
      },
    })
  ).id;
});

afterAll(async () => {
  await prisma.postShowingCall.deleteMany({ where: { clientId: buyerId } });
  await prisma.deal.deleteMany({ where: { propertyId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.propertyExposure.deleteMany({ where: { clientId: buyerId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.client.deleteMany({ where: { id: { in: [buyerId, sellerId] } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.postShowingCall.deleteMany({ where: { clientId: buyerId } });
  await prisma.deal.deleteMany({ where: { propertyId } });
  await prisma.interaction.deleteMany({ where: { clientId: { in: [buyerId, sellerId] } } });
  await prisma.propertyExposure.deleteMany({ where: { clientId: buyerId } });
  await prisma.property.update({
    where: { id: propertyId },
    data: { status: "AVAILABLE", deletedAt: null, stageEnteredAt: new Date(SHOWING_AT.getTime() - 10 * DAY) },
  });
  await prisma.client.update({ where: { id: sellerId }, data: { lastClientMessageAt: null } });
});

describe("кого вообще проверяем", () => {
  it("покупатель промолчал — показ идёт в проверку", async () => {
    const id = await makeCandidate({ status: "GIVEN_UP" });
    expect(await findSellerProbeCandidates(NOW)).toContain(id);
  });

  it("покупатель всё объяснил — расследовать нечего", async () => {
    const id = await makeCandidate({ status: "DONE", outcome: "LIKED" });
    expect(await findSellerProbeCandidates(NOW)).not.toContain(id);
  });

  it("свежий показ не трогаем: тишина в пару часов ничего не значит", async () => {
    const id = await makeCandidate({ status: "GIVEN_UP" });
    // «Сейчас» — сразу после показа: двое суток тишины ещё не прошли.
    expect(await findSellerProbeCandidates(new Date(SHOWING_AT.getTime() + 3 * HOUR))).not.toContain(id);
  });
});

describe("какой объект смотрели", () => {
  it("объект записан у показа — берём его, без всяких догадок", async () => {
    const dossier = await buildBypassDossier(await makeCandidate({}), NOW);
    expect(dossier?.propertyId).toBe(propertyId);
    expect(dossier?.propertySource).toBe("showing");
  });

  it("у показа объекта нет, но покупателю отправляли ровно один — берём его", async () => {
    await prisma.propertyExposure.create({
      data: {
        clientId: buyerId,
        propertyId,
        shortId: 1,
        kind: "LINK",
        channel: "WHATSAPP",
        recipientId: `r-${runId}`,
        sentAt: new Date(SHOWING_AT.getTime() - DAY),
      },
    });

    const dossier = await buildBypassDossier(await makeCandidate({ propertyOnShowing: false }), NOW);
    expect(dossier?.propertyId).toBe(propertyId);
    expect(dossier?.propertySource).toBe("single_candidate");
  });

  it("объект опознать не удалось — сторону продавца не проверяем вовсе", async () => {
    const dossier = await buildBypassDossier(await makeCandidate({ propertyOnShowing: false }), NOW);
    expect(dossier?.propertyId).toBeNull();
    expect(dossier?.propertySource).toBe("unknown");
    expect(dossier?.shouldAskSeller).toBe(false);
  });
});

describe("сколько признаков сошлось", () => {
  it("по объекту есть сделка — круг закрыт, собственника не трогаем", async () => {
    await prisma.deal.create({
      data: { clientId: buyerId, propertyId, agentId, stage: "NEGOTIATION" },
    });

    const dossier = await buildBypassDossier(await makeCandidate({}), NOW);
    expect(dossier?.closedByDeal).toBe(true);
    expect(dossier?.signals).toEqual([]);
    expect(dossier?.shouldAskSeller).toBe(false);
  });

  it("одна тишина собственника — мало: звонить не идём", async () => {
    const dossier = await buildBypassDossier(await makeCandidate({}), NOW);
    expect(dossier?.signals.map((s) => s.key)).toEqual(["both_silent"]);
    expect(dossier?.signals.length).toBeLessThan(SELLER_PROBE_MIN_SIGNALS);
    expect(dossier?.shouldAskSeller).toBe(false);
  });

  it("собственник замолчал, агент его бросил, объект ушёл с продажи — вот теперь звоним", async () => {
    // Собственник отвечал ДО показа и замолчал после.
    await prisma.client.update({
      where: { id: sellerId },
      data: { lastClientMessageAt: new Date(SHOWING_AT.getTime() - DAY) },
    });
    // Агент вёл его до показа и после ни разу.
    await prisma.interaction.create({
      data: {
        clientId: sellerId,
        agentId,
        type: "CALL",
        notes: "Предупредил о показе",
        createdAt: new Date(SHOWING_AT.getTime() - 2 * HOUR),
      },
    });
    // Объект сняли с продажи уже после показа.
    await prisma.property.update({
      where: { id: propertyId },
      data: { status: "WITHDRAWN", stageEnteredAt: new Date(SHOWING_AT.getTime() + DAY) },
    });

    const dossier = await buildBypassDossier(await makeCandidate({}), NOW);
    const keys = dossier?.signals.map((s) => s.key) ?? [];
    expect(keys).toContain("both_silent");
    expect(keys).toContain("seller_stopped_answering");
    expect(keys).toContain("agent_stopped_seller");
    expect(keys).toContain("property_left_sale");
    expect(dossier?.shouldAskSeller).toBe(true);
  });

  it("собственник ответил после показа — самый сильный признак снимается", async () => {
    await prisma.client.update({
      where: { id: sellerId },
      data: { lastClientMessageAt: new Date(SHOWING_AT.getTime() + 2 * HOUR) },
    });

    const dossier = await buildBypassDossier(await makeCandidate({}), NOW);
    const keys = dossier?.signals.map((s) => s.key) ?? [];
    expect(keys).not.toContain("both_silent");
    expect(keys).not.toContain("seller_stopped_answering");
  });

  it("видно, что карточку собственника заводил агент руками", async () => {
    const dossier = await buildBypassDossier(await makeCandidate({}), NOW);
    expect(dossier?.sellerCardCreatedByAgent).toBe(true);

    await prisma.client.update({ where: { id: sellerId }, data: { source: "INSTAGRAM" } });
    const fromChannel = await buildBypassDossier(await makeCandidate({}), NOW);
    expect(fromChannel?.sellerCardCreatedByAgent).toBe(false);
    await prisma.client.update({ where: { id: sellerId }, data: { source: "WALK_IN" } });
  });
});
