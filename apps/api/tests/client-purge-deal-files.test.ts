import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { createDealDocument } from "../src/lib/dealDocumentsDb.js";
import { dealDocumentFilePath, saveDealDocumentFile } from "../src/lib/dealDocumentFiles.js";

/**
 * «Удалить навсегда» клиента стирает и ФАЙЛЫ документов его сделок
 * (глубокая проверка 02.10.2026, C6).
 *
 * Строки DealDocument уходят каскадом вместе со сделкой, а сами файлы — скан
 * паспорта покупателя, договор — оставались на сервере без владельца и без
 * способа их найти из CRM.
 */

const runId = Date.now();
const password = "testpass123";
let adminId = "";
let adminToken = "";
let districtId = "";
let propertyId = "";
let clientId = "";
let fileName = "";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({
    data: { fullName: "Админ навсегда", phone: `+992946${runId}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  grantElevation(adminId);
  adminToken = res.body.accessToken as string;
  districtId = (await prisma.district.create({ data: { name: `Район навсегда ${runId}` } })).id;
  propertyId = (
    await prisma.property.create({
      data: {
        title: `Объект навсегда ${runId}`,
        type: "APARTMENT",
        areaSqm: 40,
        price: 50000,
        currency: "TJS",
        districtId,
        address: "Тестовая, навсегда",
        condition: "GOOD",
      },
    })
  ).id;
  clientId = (
    await prisma.client.create({
      data: { fullName: `Клиент навсегда ${runId}`, phone: `+992945${runId}`, source: "PHONE_CALL", deletedAt: new Date() },
    })
  ).id;
});

afterAll(async () => {
  if (fileName) {
    const full = dealDocumentFilePath(fileName);
    if (full && fs.existsSync(full)) fs.unlinkSync(full);
  }
  await prisma.$executeRaw`DELETE FROM "DealDocument" WHERE "fileName" = ${fileName}`;
  await prisma.deal.deleteMany({ where: { clientId } });
  await prisma.client.deleteMany({ where: { id: clientId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await prisma.agent.deleteMany({ where: { id: adminId } });
});

describe("C6: безвозвратное удаление клиента", () => {
  it("файл паспорта из отменённой сделки удаляется с диска", async () => {
    const deal = await prisma.deal.create({
      data: { clientId, propertyId, agentId: adminId, stage: "CANCELLED" },
    });
    fileName = saveDealDocumentFile(Buffer.from("%PDF-1.4 паспорт"), "application/pdf")!;
    expect(fileName).toBeTruthy();
    await createDealDocument({
      dealId: deal.id,
      kind: "PASSPORT",
      fileName,
      originalName: "паспорт.pdf",
      mimeType: "application/pdf",
      uploadedById: adminId,
    });
    const full = dealDocumentFilePath(fileName)!;
    expect(fs.existsSync(full)).toBe(true);

    const res = await request(app).delete(`/api/v1/clients/${clientId}/permanent`).set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(204);
    expect(await prisma.client.findUnique({ where: { id: clientId } })).toBeNull();
    expect(fs.existsSync(full)).toBe(false);
  });
});
