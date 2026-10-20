import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";

/**
 * CHANNEL-NEW-16 (аудит Codex, 04.10.2026): удаление объекта с сайта коммитило deletedAt, а
 * гашение спутников (заявка агента на удаление, ссылки, очередь монтажа) шло ПОСЛЕ коммита
 * вне транзакции. Сбой на этом шаге оставлял объект в Корзине с открытой заявкой, а повторная
 * доставка видела `existing.deletedAt` и ничего не делала: спутники оставались навсегда.
 * Теперь гашение заявки и ссылок идёт в той же транзакции, а повторная доставка для уже
 * удалённого объекта снова гасит спутников (идемпотентно).
 */
const trash = vi.hoisted(() => ({ failNextClose: false }));
vi.mock("../src/lib/trashProperty.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/lib/trashProperty.js")>();
  return {
    ...original,
    closePendingPropertyDeleteRequests: vi.fn(async (...args: Parameters<typeof original.closePendingPropertyDeleteRequests>) => {
      if (trash.failNextClose) {
        trash.failNextClose = false;
        throw new Error("временный отказ базы при закрытии заявки");
      }
      return original.closePendingPropertyDeleteRequests(...args);
    }),
  };
});

const { app } = await import("../src/app.js");
const { prisma } = await import("../src/db.js");

const runId = Date.now();
const API_KEY = `test-site-delete-retry-${runId}`;
let agentId = "";
let districtId = "";
const propertyIds: string[] = [];

beforeAll(async () => {
  process.env.WEBSITE_LEAD_API_KEY = API_KEY;
  agentId = (
    await prisma.agent.create({
      data: { fullName: "Агент заявки", phone: `+992988${runId}`, role: "AGENT", passwordHash: await bcrypt.hash("testpass123", 10) },
    })
  ).id;
  districtId = (await prisma.district.create({ data: { name: `Удаление-сайта-${runId}` } })).id;
});

beforeEach(() => {
  trash.failNextClose = false;
});

afterAll(async () => {
  delete process.env.WEBSITE_LEAD_API_KEY;
  await prisma.propertyDeleteRequest.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.siteEditNotification.deleteMany({ where: { propertyId: { in: propertyIds } } });
  await prisma.property.deleteMany({ where: { id: { in: propertyIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
});

async function makeListedProperty() {
  const siteListingId = 920_000_000 + Math.floor(Math.random() * 9_000_000);
  const property = await prisma.property.create({
    data: {
      title: `Объект удаления ${siteListingId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 50000,
      currency: "USD",
      districtId,
      address: `Адрес ${siteListingId}`,
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      siteListingId,
    },
  });
  propertyIds.push(property.id);
  const deleteRequest = await prisma.propertyDeleteRequest.create({
    data: { propertyId: property.id, requestedById: agentId, reason: "OWNER_CANCELLED" },
  });
  return { siteListingId, property, deleteRequest };
}

function sendDeleted(siteListingId: number) {
  return request(app).post("/api/v1/webhooks/site-listing-upserted").set("X-Api-Key", API_KEY).send({ siteListingId, action: "deleted" });
}

describe("Удаление объекта с сайта: сбой гашения спутников исправляется повторной доставкой", () => {
  it("первая доставка упала на закрытии заявки, вторая закрывает заявку и оставляет объект в Корзине", async () => {
    const { siteListingId, property, deleteRequest } = await makeListedProperty();
    trash.failNextClose = true;

    await sendDeleted(siteListingId);
    const second = await sendDeleted(siteListingId);

    expect(second.status).toBe(200);
    const closed = await prisma.propertyDeleteRequest.findUniqueOrThrow({ where: { id: deleteRequest.id } });
    expect(closed.status).toBe("APPROVED");
    const after = await prisma.property.findUniqueOrThrow({ where: { id: property.id } });
    expect(after.deletedAt).not.toBeNull();
  });

  it("повторная доставка уже удалённого объекта гасит заявку, оставшуюся открытой (объект удалён, спутник жив)", async () => {
    const { siteListingId, property, deleteRequest } = await makeListedProperty();
    // Состояние после обрыва процесса между коммитом deletedAt и гашением спутников.
    await prisma.property.update({ where: { id: property.id }, data: { deletedAt: new Date(), publishedOnSite: false } });

    const res = await sendDeleted(siteListingId);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    const closed = await prisma.propertyDeleteRequest.findUniqueOrThrow({ where: { id: deleteRequest.id } });
    expect(closed.status).toBe("APPROVED");
  });
});
