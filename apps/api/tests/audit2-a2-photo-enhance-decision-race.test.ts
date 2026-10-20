import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { uploadsDir } from "../src/upload.js";
import { grantElevation } from "../src/lib/stepUp.js";

/**
 * APROP03 (аудит 04.10.2026): «одобрить» и «отклонить» улучшенное фото читали один
 * и тот же enhancedUrl, потом безусловно писали. Отклонение стирало с диска файл по
 * старому снимку и обнуляло поля, пока одобрение уже сделало этот файл действующим:
 * оба запроса успешны, а фото ссылается на удалённый файл. Гонка воспроизводится
 * подставной задержкой после чтения.
 */
const runId = Date.now();
const password = "testpass123";
let districtId = "";
let agentId = "";
let token = "";
let propertyId = "";
const photoIds: string[] = [];
const files: string[] = [];

async function makePhoto(tag: string) {
  const enhanced = `a2enh-${runId}-${tag}.webp`;
  const file = path.join(uploadsDir, enhanced);
  await fs.mkdir(uploadsDir, { recursive: true });
  await fs.writeFile(file, "x");
  files.push(file);
  const photo = await prisma.propertyPhoto.create({
    data: {
      propertyId,
      url: `/uploads/a2orig-${runId}-${tag}.webp`,
      thumbUrl: `/uploads/thumbs/a2orig-${runId}-${tag}.webp`,
      enhancedUrl: `/uploads/${enhanced}`,
      enhancedThumbUrl: `/uploads/thumbs/${enhanced}`,
      enhancedRequestedAt: new Date(),
      order: photoIds.length,
    },
  });
  photoIds.push(photo.id);
  return { photo, file };
}

function raceAfterRead(competitor: () => Promise<unknown>) {
  const real = prisma.propertyPhoto.findUnique.bind(prisma.propertyPhoto) as (a: unknown) => Promise<unknown>;
  vi.spyOn(prisma.propertyPhoto, "findUnique").mockImplementation(((args: unknown) =>
    real(args).then(async (row) => {
      await competitor();
      return row;
    })) as never);
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  districtId = (await prisma.district.create({ data: { name: `Район гонки фото ${runId}` } })).id;
  agentId = (await prisma.agent.create({ data: { fullName: "Агент гонки фото", phone: `+992923${runId}`, role: "AGENT", passwordHash } })).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: `+992923${runId}`, password });
  token = res.body.accessToken as string;
  grantElevation(agentId);
  propertyId = (
    await prisma.property.create({
      data: { title: `Объект гонки фото ${runId}`, type: "APARTMENT", areaSqm: 50, price: 40000, currency: "TJS", districtId, address: "Тестовая, 6", condition: "GOOD", status: "EDITING", intakeAgentId: agentId, createdById: agentId },
    })
  ).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { id: { in: photoIds } } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  await Promise.all(files.map((f) => fs.rm(f, { force: true })));
  await prisma.$disconnect();
});

describe("улучшение фото: решение берётся один раз (APROP03)", () => {
  it("отклонение, проигравшее одобрению, отвечает 409 и не удаляет файл, ставший действующим", async () => {
    const { photo, file } = await makePhoto("rej");
    raceAfterRead(() =>
      prisma.propertyPhoto.update({
        where: { id: photo.id },
        data: { url: photo.enhancedUrl!, thumbUrl: photo.enhancedThumbUrl!, enhancedUrl: null, enhancedThumbUrl: null, enhancedRequestedAt: null },
      })
    );
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/photos/${photo.id}/enhance/reject`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    await expect(fs.access(file)).resolves.toBeUndefined();
    expect((await prisma.propertyPhoto.findUniqueOrThrow({ where: { id: photo.id } })).url).toBe(photo.enhancedUrl);
  });

  it("одобрение, проигравшее отклонению, отвечает 409 и не подставляет url из обнулённого снимка", async () => {
    const { photo } = await makePhoto("app");
    raceAfterRead(() =>
      prisma.propertyPhoto.update({
        where: { id: photo.id },
        data: { enhancedUrl: null, enhancedThumbUrl: null, enhancedRequestedAt: null },
      })
    );
    const res = await request(app)
      .post(`/api/v1/properties/${propertyId}/photos/${photo.id}/enhance/approve`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect((await prisma.propertyPhoto.findUniqueOrThrow({ where: { id: photo.id } })).url).toBe(photo.url);
  });

  it("одиночные решения работают как раньше", async () => {
    const approved = await makePhoto("ok1");
    const r1 = await request(app)
      .post(`/api/v1/properties/${propertyId}/photos/${approved.photo.id}/enhance/approve`)
      .set("Authorization", `Bearer ${token}`);
    expect(r1.status).toBe(200);
    expect(r1.body.url).toBe(approved.photo.enhancedUrl);
    expect(r1.body.originalUrl).toBe(approved.photo.url);

    const rejected = await makePhoto("ok2");
    const r2 = await request(app)
      .post(`/api/v1/properties/${propertyId}/photos/${rejected.photo.id}/enhance/reject`)
      .set("Authorization", `Bearer ${token}`);
    expect(r2.status).toBe(200);
    expect(r2.body.enhancedUrl).toBeNull();
    await expect(fs.access(rejected.file)).rejects.toBeTruthy();
  });
});
