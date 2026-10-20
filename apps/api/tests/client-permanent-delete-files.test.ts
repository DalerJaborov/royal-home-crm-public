import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import { dealDocumentFilePath, saveDealDocumentFile } from "../src/lib/dealDocumentFiles.js";

/**
 * «Удалить клиента навсегда» убирает его файлы (G10, 02.10.2026).
 *
 * Так было: строки клиента и отменённых сделок стирались, а файлы оставались:
 * аватар в ОТКРЫТОЙ uploads/avatars открывался по старой ссылке у любого, а
 * сканы паспортов и договоров отменённых сделок лежали в хранилище документов
 * без владельца навсегда — уборки у него нет.
 */

const runId = String(Date.now()).slice(-7);
const password = "testpass123";
const adminPhone = `+992985${runId}`;
let adminId = "";
let token = "";
let districtId = "";
let propertyId = "";
let clientId = "";
let avatarFile = "";
let docName = "";

beforeAll(async () => {
  await prisma.agent.deleteMany({ where: { phone: adminPhone } });
  adminId = (
    await prisma.agent.create({
      data: { fullName: "Админ стирания клиента", phone: adminPhone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 4) },
    })
  ).id;
  token = (await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password })).body.accessToken;

  districtId = (await prisma.district.create({ data: { name: `Стирание клиента-${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Стирание клиента-${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 200000,
        currency: "TJS",
        districtId,
        address: "Проверочная, 2",
        condition: "GOOD",
      },
    })
  ).id;

  const avatarName = `${randomUUID()}.webp`;
  avatarFile = path.join(uploadsDir, "avatars", avatarName);
  fs.mkdirSync(path.dirname(avatarFile), { recursive: true });
  fs.writeFileSync(avatarFile, "аватар");

  const client = await prisma.client.create({
    data: {
      fullName: `Клиент на стирание ${runId}`,
      phone: `+992986${runId}`,
      source: "PHONE_CALL",
      avatarUrl: `/uploads/avatars/${avatarName}`,
      deletedAt: new Date(),
    },
  });
  clientId = client.id;

  const deal = await prisma.deal.create({
    data: { clientId, propertyId, agentId: adminId, stage: "CANCELLED" },
  });
  docName = saveDealDocumentFile(Buffer.from("%PDF-1.4 паспорт"), "application/pdf")!;
  expect(docName).toBeTruthy();
  await prisma.dealDocument.create({
    data: {
      dealId: deal.id,
      kind: "PASSPORT",
      fileName: docName,
      originalName: "паспорт.pdf",
      mimeType: "application/pdf",
      uploadedById: adminId,
    },
  });
});

afterAll(async () => {
  fs.rmSync(avatarFile, { force: true });
  const leftover = dealDocumentFilePath(docName);
  if (leftover) fs.rmSync(leftover, { force: true });
  await prisma.deal.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.session.deleteMany({ where: { agentId: adminId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe("DELETE /clients/:id/permanent", () => {
  it("стирает аватар и документы отменённых сделок с диска", async () => {
    expect(fs.existsSync(avatarFile)).toBe(true);
    expect(dealDocumentFilePath(docName)).not.toBeNull();

    const res = await request(app).delete(`/api/v1/clients/${clientId}/permanent`).set("Authorization", `Bearer ${token}`);
    expect(res.status, JSON.stringify(res.body)).toBe(204);

    expect(fs.existsSync(avatarFile), "аватар удалён").toBe(false);
    expect(dealDocumentFilePath(docName), "документ сделки удалён").toBeNull();
  });
});
