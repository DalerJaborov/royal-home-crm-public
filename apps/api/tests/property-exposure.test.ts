import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCustomerMessengerFixture, type CustomerMessengerFixture } from "./helpers/customerMessengerFixture.js";

/** Отправку в Meta мокаем целиком: тест про журнал показов, а не про канал.
 *  isMetaChannelEnabled тоже — иначе он упрётся в отсутствующие ключи Meta и
 *  показ вернёт пустоту, ничего не сказав. */
const { sendMessage, sendImage } = vi.hoisted(() => ({
  sendMessage: vi.fn(async () => "synthetic-showcase-mid"),
  sendImage: vi.fn(async () => "synthetic-showcase-image-mid"),
}));
vi.mock("../src/messengers/meta.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isMetaChannelEnabled: vi.fn(async () => true),
    sendMessage,
    sendImage,
    showReadAndTyping: vi.fn(async () => undefined),
  };
});

const { prisma } = await import("../src/db.js");
const { showPropertyToClient, linkExposuresToClient } = await import("../src/messengers/propertyShowcase.js");

/**
 * Журнал показов — основание правила «бот показал объект, лид уходит хозяину»
 * (решение владельца 11.08.2026). Проверяем ровно то, на чём правило держится:
 * запись появляется, недельный дедуп её не стирает, и карточка клиента
 * привязывается задним числом — потому что показ случается РАНЬШЕ, чем клиент
 * вообще заводится.
 */

const runId = Date.now();
const RECIPIENT = `psid-${runId}`;

let districtId: string;
let intakeAgentId: string;
let propertyId: string;
let propertyShortId: number;
let clientId: string;
let instagram: CustomerMessengerFixture;

beforeAll(async () => {
  instagram = await createCustomerMessengerFixture("INSTAGRAM");
  districtId = (await prisma.district.create({ data: { name: `Тест-показ-${runId}` } })).id;
  intakeAgentId = (
    await prisma.agent.create({
      data: { fullName: "Агент показа", phone: `+992915${runId}`, role: "AGENT", passwordHash: "x" },
    })
  ).id;

  const property = await prisma.property.create({
    data: {
      title: `Объект журнала ${runId}`,
      type: "APARTMENT",
      areaSqm: 60,
      rooms: 3,
      price: 300_000,
      currency: "TJS",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
      status: "AVAILABLE",
      publishedOnSite: true,
      intakeAgentId,
      // Instagram-пост: самая короткая ветка показа — уходит одна ссылка, без
      // перекодирования фотографий и без публичного адреса CRM.
      instagramUrl: `https://instagram.com/p/test${runId}`,
    },
  });
  propertyId = property.id;
  propertyShortId = property.shortId;

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент журнала ${runId}`,
      phone: `+992914${runId}`,
      source: "INSTAGRAM",
    },
  });
  clientId = client.id;
});

beforeEach(() => {
  sendImage.mockClear();
  sendMessage.mockClear();
});

afterAll(async () => {
  await prisma.propertyExposure.deleteMany({ where: { recipientId: RECIPIENT } });
  await prisma.shownProperty.deleteMany({ where: { recipientId: RECIPIENT } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await instagram.dispose();
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: intakeAgentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.$disconnect();
});

describe("Журнал показов объектов", () => {
  it("показ записывается вместе с объектом и его хозяином", async () => {
    const result = await showPropertyToClient("INSTAGRAM", RECIPIENT, propertyShortId, "", undefined, instagram.token, true, instagram.transport);
    expect(result.link).toBeTruthy();

    const exposures = await prisma.propertyExposure.findMany({
      where: { recipientId: RECIPIENT },
      include: { property: { select: { intakeAgentId: true } } },
    });
    expect(exposures).toHaveLength(1);
    expect(exposures[0].propertyId).toBe(propertyId);
    expect(exposures[0].shortId).toBe(propertyShortId);
    expect(exposures[0].kind).toBe("LINK");
    // Клиента ещё нет — это норма: бот показывает объекты раньше, чем узнаёт телефон.
    expect(exposures[0].clientId).toBeNull();
    expect(exposures[0].property?.intakeAgentId).toBe(intakeAgentId);
  });

  it("недельный дедуп отправки журнал не трогает", async () => {
    // Второй показ внутри недели не уходит — это старое поведение, и оно осталось.
    const second = await showPropertyToClient("INSTAGRAM", RECIPIENT, propertyShortId, "", undefined, instagram.token, true, instagram.transport);
    expect(second.link).toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();

    // Но запись о первом показе на месте: правило «свой объект» опирается на неё,
    // и стереть её вместе с отметкой дедупа значило бы отменить правило через неделю.
    const count = await prisma.propertyExposure.count({ where: { recipientId: RECIPIENT } });
    expect(count).toBe(1);
  });

  it("карточка клиента привязывается задним числом", async () => {
    await linkExposuresToClient("INSTAGRAM", RECIPIENT, clientId, instagram.transport);
    const exposures = await prisma.propertyExposure.findMany({ where: { recipientId: RECIPIENT } });
    expect(exposures).toHaveLength(1);
    expect(exposures[0].clientId).toBe(clientId);
  });

  it("повторная привязка чужие записи не перетирает", async () => {
    const other = await prisma.propertyExposure.create({
      data: { endpointScopeId: instagram.transport.endpointScopeId, channel: "INSTAGRAM", recipientId: RECIPIENT, propertyId, shortId: propertyShortId, kind: "PHOTO" },
    });
    const otherClient = await prisma.client.create({
      data: { fullName: `Чужой клиент ${runId}`, phone: `+992913${runId}`, source: "INSTAGRAM" },
    });

    await linkExposuresToClient("INSTAGRAM", RECIPIENT, otherClient.id, instagram.transport);

    // Новая запись досталась второму клиенту, а уже привязанная осталась за первым:
    // updateMany берёт только clientId: null. Иначе поздний лид переписывал бы
    // историю показов раннего.
    const rows = await prisma.propertyExposure.findMany({ where: { recipientId: RECIPIENT } });
    expect(rows.find((r) => r.id === other.id)?.clientId).toBe(otherClient.id);
    expect(rows.filter((r) => r.clientId === clientId)).toHaveLength(1);

    await prisma.propertyExposure.deleteMany({ where: { id: other.id } });
    await prisma.client.deleteMany({ where: { id: otherClient.id } });
  });

  it("удаление объекта запись не роняет — факт показа остаётся", async () => {
    const doomed = await prisma.property.create({
      data: {
        title: `Объект на удаление ${runId}`,
        type: "APARTMENT",
        areaSqm: 50,
        price: 100_000,
        currency: "TJS",
        districtId,
        address: "Тестовая, 2",
        condition: "GOOD",
      },
    });
    const exposure = await prisma.propertyExposure.create({
      data: {
        channel: "INSTAGRAM",
        recipientId: RECIPIENT,
        propertyId: doomed.id,
        shortId: doomed.shortId,
        kind: "LINK",
      },
    });

    await prisma.property.delete({ where: { id: doomed.id } });

    const after = await prisma.propertyExposure.findUnique({ where: { id: exposure.id } });
    expect(after).not.toBeNull();
    // Связь обнулилась, но НОМЕР объекта остался: по нему видно, что показывали.
    expect(after?.propertyId).toBeNull();
    expect(after?.shortId).toBe(doomed.shortId);

    await prisma.propertyExposure.deleteMany({ where: { id: exposure.id } });
  });
});
