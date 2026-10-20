import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import sharp from "sharp";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { savePrivateFile, privateFilePath } from "../src/lib/privateFiles.js";
import { attachDraftToProperty } from "../src/routes/properties/draftAttach.js";
import { loginWithCode } from "./helpers/loginCode.js";

/**
 * Глубокая проверка 02.10.2026, находка D2: второй объект того же продавца,
 * собранный «из переписки», создавался без единого фото и видео.
 *
 * Вложения переписки копируются в черновик с ключом `chat:<sha256>`, а
 * идемпотентность смотрела только таблицу черновиков. После создания первого
 * объекта ключи лежат уже в PropertyPhoto (uploadKey @unique), но черновик
 * второго объекта снова получал снимки первого — и перенос черновика в объект
 * падал на уникальном ключе, откатывая ВСЕ фото и видео второго объекта.
 */

const PREFIX = "/api/v1/properties/drafts";
const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
const createdClientIds: string[] = [];
const createdConversationIds: string[] = [];
const createdPropertyIds: string[] = [];
const createdPrivateFiles: string[] = [];

function tinyJpeg(shade: number): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: 7, b: 9 } } })
    .jpeg()
    .toBuffer();
}

async function sendPhotos(clientId: string, shades: number[]) {
  const files: string[] = [];
  for (const shade of shades) {
    const name = await savePrivateFile(await tinyJpeg(shade), "image/jpeg");
    expect(name).toBeTruthy();
    createdPrivateFiles.push(name!);
    files.push(name!);
  }
  const conversation = await prisma.botConversation.create({
    data: {
      channel: "WHATSAPP",
      subscriberId: `seller-second-${runId}-${randomUUID().slice(0, 8)}`,
      clientId,
      messages: files.map((file, i) => ({
        role: "user",
        content: `[фото ${i}]`,
        attachments: [{ kind: "image", file, mime: "image/jpeg" }],
        at: new Date(Date.now() + i * 1000).toISOString(),
      })),
      lastMessageAt: new Date(),
    },
  });
  createdConversationIds.push(conversation.id);
}

async function makeProperty(title: string) {
  const property = await prisma.property.create({
    data: {
      title,
      type: "APARTMENT",
      areaSqm: 50,
      condition: "GOOD",
      price: 50000,
      address: "ул. Проверки, 1",
      intakeAgentId: agentId,
      createdById: agentId,
      status: "AWAITING_PHOTOS",
    },
  });
  createdPropertyIds.push(property.id);
  return property;
}

async function draftFromClient(clientId: string) {
  const current = await request(app).get(`${PREFIX}/current`).set("Authorization", `Bearer ${token}`);
  let active = current.body.draft;
  if (!active) {
    const started = await request(app).post(`${PREFIX}/current/start`).set("Authorization", `Bearer ${token}`).send({ sessionId: randomUUID(), revision: current.body.revision });
    expect(started.status).toBe(200); active = started.body.draft;
  }
  const res = await request(app)
    .post(`${PREFIX}/from-client/${clientId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ draftId: active.id, revision: active.revision, mode: "merge" });
  expect(res.status).toBe(200);
  const draft = await prisma.propertyDraft.findFirstOrThrow({ where: { agentId } });
  return { body: res.body, draft };
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: {
      fullName: `Агент второго объекта ${runId}`,
      phone: `+992939${String(runId).slice(-7)}`,
      role: "AGENT",
      passwordHash,
    },
  });
  agentId = agent.id;
  const login = await loginWithCode(app, agent.phone);
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;
});

afterAll(async () => {
  await prisma.propertyDraft.deleteMany({ where: { agentId } });
  await prisma.property.deleteMany({ where: { id: { in: createdPropertyIds } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: createdConversationIds } } });
  await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  for (const name of createdPrivateFiles) {
    const full = privateFilePath(name);
    if (full) fs.rmSync(full, { force: true });
  }
  await prisma.$disconnect();
});

describe("D2: второй объект продавца из переписки", () => {
  it("снимки первого (живого) объекта не попадают в черновик второго, снимки второго переезжают", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Продавец двух квартир ${runId}`,
        phone: `+992${String(Date.now()).slice(-9)}`,
        source: "WHATSAPP",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    createdClientIds.push(client.id);

    // Квартира А: два фото → черновик → объект А.
    await sendPhotos(client.id, [11, 12]);
    const first = await draftFromClient(client.id);
    const propertyA = await makeProperty(`Квартира А ${runId}`);
    const attachedA = await attachDraftToProperty(first.draft.id, agentId, propertyA, agentId);
    expect(attachedA.photos).toBe(2);

    // Через неделю тот же продавец шлёт фото квартиры Б.
    await sendPhotos(client.id, [21, 22, 23]);
    const second = await draftFromClient(client.id);
    const draftMedia = await prisma.propertyDraftMedia.findMany({ where: { draftId: second.draft.id } });
    expect(draftMedia).toHaveLength(3);

    const propertyB = await makeProperty(`Квартира Б ${runId}`);
    const attachedB = await attachDraftToProperty(second.draft.id, agentId, propertyB, agentId);
    expect(attachedB.photos).toBe(3);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: propertyB.id } })).toBe(3);
    // Черновик перенесён и удалён, а не висит.
    expect((await prisma.propertyDraft.findUniqueOrThrow({ where: { id: second.draft.id } })).closedAt).not.toBeNull();
    // Объект А своих снимков не потерял.
    expect(await prisma.propertyPhoto.count({ where: { propertyId: propertyA.id } })).toBe(2);
  });

  it("объект А в Корзине, агент собирает объект заново: снимки переезжают, перенос не откатывается", async () => {
    const client = await prisma.client.create({
      data: {
        fullName: `Продавец пересоздания ${runId}`,
        phone: `+992${String(Date.now() + 7).slice(-9)}`,
        source: "WHATSAPP",
        kind: "SELLER",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    createdClientIds.push(client.id);

    await sendPhotos(client.id, [31, 32]);
    const first = await draftFromClient(client.id);
    const propertyA = await makeProperty(`Квартира пересоздания ${runId}`);
    expect((await attachDraftToProperty(first.draft.id, agentId, propertyA, agentId)).photos).toBe(2);
    await prisma.property.update({ where: { id: propertyA.id }, data: { deletedAt: new Date() } });

    const second = await draftFromClient(client.id);
    expect(await prisma.propertyDraftMedia.count({ where: { draftId: second.draft.id } })).toBe(2);
    const propertyA2 = await makeProperty(`Квартира пересоздания заново ${runId}`);
    const attached = await attachDraftToProperty(second.draft.id, agentId, propertyA2, agentId);
    expect(attached.photos).toBe(2);
    expect(await prisma.propertyPhoto.count({ where: { propertyId: propertyA2.id } })).toBe(2);
    // Объект в Корзине своих снимков не потерял — его можно восстановить.
    expect(await prisma.propertyPhoto.count({ where: { propertyId: propertyA.id } })).toBe(2);
  });
});
