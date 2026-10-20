import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import { prisma } from "../src/db.js";
import { applySellerRefusal } from "../src/lib/sellerRefusalReview.js";
import { propertyDeleteRequestSchema } from "@royal-home/shared";

/**
 * Отказ продавца, оформленный снятием объекта (владелец 09.09.2026).
 *
 * Две дыры, которые здесь закрываются:
 *
 *  СЧЁТЧИК ТИШИНЫ НЕ ОСТАНАВЛИВАЛСЯ — агент честно оформлял отказ, а через три
 *  рабочих дня получал «забросил клиента». Единственный путь снять объект проходил
 *  через ложное обвинение.
 *
 *  «ПРОДАН В ОБХОД АГЕНТСТВА» НИКУДА НЕ УХОДИЛО — главный автоматический вход в СБ
 *  был потерян вместе со всплывающими окнами.
 */

const runId = Date.now();
let agentId: string;
let districtId: string;
const clientIds: string[] = [];
const propertyIds: string[] = [];

beforeAll(async () => {
  const passwordHash = await bcrypt.hash("testpass123", 10);
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент отказа", phone: `+992944${runId}`, role: "AGENT", passwordHash },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Район-отказ-${runId}` } })).id;
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

async function makeSellerWithProperty(propertyStatus: "AVAILABLE" | "WITHDRAWN" = "WITHDRAWN") {
  const seller = await prisma.client.create({
    data: {
      fullName: `Продавец отказа ${runId}-${clientIds.length}`,
      phone: `+992945${runId}${clientIds.length}`,
      source: "PHONE_CALL",
      kind: "SELLER",
      assignedAgentId: agentId,
      workStatus: "ACTIVE",
      lastAgentAttemptAt: new Date(Date.now() - 5 * 24 * 3600_000),
    },
  });
  clientIds.push(seller.id);
  const property = await prisma.property.create({
    data: {
      title: `Объект отказа ${runId}-${propertyIds.length}`,
      type: "APARTMENT",
      areaSqm: 45,
      price: 50000,
      currency: "TJS",
      districtId,
      address: "Тест",
      condition: "GOOD",
      status: propertyStatus,
      sellerClientId: seller.id,
      intakeAgentId: agentId,
    },
  });
  propertyIds.push(property.id);
  return { seller, property };
}

describe("Форма заявки", () => {
  it("«продан в обход агентства» без комментария не принимается", () => {
    const res = propertyDeleteRequestSchema.safeParse({ reason: "SOLD_ELSEWHERE" });
    expect(res.success).toBe(false);
  });

  it("с названным агентством — принимается", () => {
    const res = propertyDeleteRequestSchema.safeParse({
      reason: "SOLD_ELSEWHERE",
      comment: "Продал через «Соседний дом», сам подтвердил по телефону",
    });
    expect(res.success).toBe(true);
  });

  /** Пачка 13, 11.09.2026, п.1: короче 20 символов — тоже отказ, не только пусто. */
  it("короче 20 символов — тоже не принимается", () => {
    const res = propertyDeleteRequestSchema.safeParse({
      reason: "SOLD_ELSEWHERE",
      comment: "Продали сами",
    });
    expect(res.success).toBe(false);
  });

  it("обычная причина комментария не требует", () => {
    expect(propertyDeleteRequestSchema.safeParse({ reason: "OWNER_CANCELLED" }).success).toBe(true);
  });
});

describe("Последствия одобренной заявки", () => {
  it("счётчик тишины останавливается — агента больше не обвинят", async () => {
    const { seller, property } = await makeSellerWithProperty();
    const before = (await prisma.client.findUnique({ where: { id: seller.id } }))!.lastAgentAttemptAt!;

    await applySellerRefusal({
      propertyId: property.id,
      reason: "OWNER_CANCELLED",
      comment: null,
      requestedById: agentId,
    });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after!.lastAgentAttemptAt!.getTime()).toBeGreaterThan(before.getTime());
  });

  it("объектов не осталось — карточка уходит в потерянные с причиной", async () => {
    const { seller, property } = await makeSellerWithProperty();

    await applySellerRefusal({
      propertyId: property.id,
      reason: "OWNER_CANCELLED",
      comment: null,
      requestedById: agentId,
    });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).toBe("LOST");
    expect(after?.refusalReason).toBe("OWNER_CANCELLED");
  });

  /** ГЛАВНАЯ ПРОВЕРКА: вход в СБ вернулся. */
  it("«продан в обход агентства» уходит в СБ автоматически", async () => {
    const { seller, property } = await makeSellerWithProperty();

    await applySellerRefusal({
      propertyId: property.id,
      reason: "SOLD_ELSEWHERE",
      comment: "Агентство «Соседний дом»",
      requestedById: agentId,
    });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.securityReview).toBe("PENDING");

    const notes = await prisma.interaction.findMany({ where: { clientId: seller.id, type: "SYSTEM" } });
    expect(notes.some((n) => n.notes?.includes("Соседний дом"))).toBe(true);
    expect(notes.some((n) => n.notes?.includes("СБ"))).toBe(true);
  });

  it("обычный отказ в СБ не уходит", async () => {
    const { seller, property } = await makeSellerWithProperty();

    await applySellerRefusal({
      propertyId: property.id,
      reason: "OWNER_CANCELLED",
      comment: null,
      requestedById: agentId,
    });

    expect((await prisma.client.findUnique({ where: { id: seller.id } }))?.securityReview).toBeNull();
  });

  /**
   * У продавца снят ОДИН объект из двух — работа продолжается, и обвинять агента
   * в потере клиента не за что.
   */
  it("остались другие объекты — карточка остаётся активной", async () => {
    const { seller, property } = await makeSellerWithProperty();
    const second = await prisma.property.create({
      data: {
        title: `Второй объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 60,
        price: 70000,
        currency: "TJS",
        districtId,
        address: "Тест-2",
        condition: "GOOD",
        status: "AVAILABLE",
        sellerClientId: seller.id,
      },
    });
    propertyIds.push(second.id);

    await applySellerRefusal({
      propertyId: property.id,
      reason: "OWNER_CANCELLED",
      comment: null,
      requestedById: agentId,
    });

    const after = await prisma.client.findUnique({ where: { id: seller.id } });
    expect(after?.status).not.toBe("LOST");
    expect(after?.assignedAgentId).toBe(agentId);
  });

  it("объект без карточки продавца — молча ничего не делаем", async () => {
    const orphan = await prisma.property.create({
      data: {
        title: `Ничей объект ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 40000,
        currency: "TJS",
        districtId,
        address: "Тест-3",
        condition: "GOOD",
        status: "WITHDRAWN",
      },
    });
    propertyIds.push(orphan.id);
    await expect(
      applySellerRefusal({ propertyId: orphan.id, reason: "SOLD_ELSEWHERE", comment: "х", requestedById: agentId })
    ).resolves.toBeUndefined();
  });
});

/**
 * Удалять карточку продавца, пока его объект стоит на сайте, нельзя: объект
 * остался бы без владельца, а номер собственника уехал бы в Корзину вместе с
 * карточкой. И главное — вместе с объектами пропала бы ПРИЧИНА снятия, наш
 * единственный автоматический вход в СБ.
 */
describe("Удаление карточки продавца", () => {
  it("объект в работе — удаление запрещено, названы номера объектов", async () => {
    const { seller, property } = await makeSellerWithProperty("AVAILABLE");
    const { trashClient } = await import("../src/lib/trashClient.js");

    const res = await trashClient(seller.id, agentId);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error).toContain(`№${property.shortId}`);
    }
    expect((await prisma.client.findUnique({ where: { id: seller.id } }))?.deletedAt).toBeNull();
  });

  it("все объекты сняты с продажи — удаление проходит", async () => {
    const { seller } = await makeSellerWithProperty("WITHDRAWN");
    const { trashClient } = await import("../src/lib/trashClient.js");

    const res = await trashClient(seller.id, agentId);
    expect(res.ok).toBe(true);
    expect((await prisma.client.findUnique({ where: { id: seller.id } }))?.deletedAt).not.toBeNull();
  });
});
