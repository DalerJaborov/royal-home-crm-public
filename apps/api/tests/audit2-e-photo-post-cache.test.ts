import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/**
 * АУДИТ CODEX 04.10.2026, PUB01: кэш изображений фото-поста не различал исходные
 * фотографии. Выход назывался `<propertyId>-<индекс>.jpg`, а свежесть сравнивала
 * только mtime входа и выхода: после удаления фото A старая B получала индекс 0,
 * готовый `-0.jpg` (снимок A) был новее исходника B и публиковалась УДАЛЁННАЯ A.
 * Перестановка фото оставляла прежние изображения так же.
 */

process.env.CRM_PUBLIC_URL = process.env.CRM_PUBLIC_URL ?? "https://crm-test.royalhome.tj";

const { prisma } = await import("../src/db.js");
const { uploadsDir, photoPostsDir } = await import("../src/upload.js");
const { preparePhotoPostImages } = await import("../src/lib/photoPosts.js");

const runId = Date.now().toString(36);
let districtId: string;
let propertyId: string;
const files: string[] = [];
const photoIds: string[] = [];

async function addPhoto(order: number, color: { r: number; g: number; b: number }) {
  const buf = await sharp({ create: { width: 900, height: 600, channels: 3, background: color } }).webp().toBuffer();
  const name = `audit2-e-cache-${runId}-${order}.webp`;
  await fs.writeFile(path.join(uploadsDir, name), buf);
  files.push(path.join(uploadsDir, name));
  const photo = await prisma.propertyPhoto.create({ data: { propertyId, url: `/uploads/${name}`, thumbUrl: `/uploads/${name}`, order } });
  photoIds.push(photo.id);
  return photo.id;
}

beforeAll(async () => {
  districtId = (await prisma.district.create({ data: { name: `Район-кэш-фото-${runId}` } })).id;
  const p = await prisma.property.create({
    data: {
      title: `Кэш фото-поста ${runId}`,
      type: "APARTMENT",
      areaSqm: 50,
      price: 40000,
      currency: "USD",
      districtId,
      address: "Тестовая, 1",
      condition: "GOOD",
    },
  });
  propertyId = p.id;
});

afterAll(async () => {
  await prisma.propertyPhoto.deleteMany({ where: { propertyId } });
  await prisma.property.deleteMany({ where: { id: propertyId } });
  await prisma.district.deleteMany({ where: { id: districtId } });
  for (const f of files) await fs.rm(f, { force: true });
  const leftovers = await fs.readdir(photoPostsDir).catch(() => [] as string[]);
  for (const f of leftovers) if (f.startsWith(`${propertyId}-`)) await fs.rm(path.join(photoPostsDir, f), { force: true });
  await prisma.$disconnect();
});

describe("preparePhotoPostImages: кэш привязан к исходнику, а не к индексу", () => {
  it("после удаления первого фото публикуется второе, а не прежний снимок первого", async () => {
    const aId = await addPhoto(0, { r: 200, g: 20, b: 20 }); // A — красное
    await addPhoto(1, { r: 20, g: 20, b: 200 }); // B — синее
    const before = await preparePhotoPostImages(propertyId);
    expect(before!.paths).toHaveLength(2);
    const bBytes = await fs.readFile(before!.paths[1]);

    await prisma.propertyPhoto.delete({ where: { id: aId } });
    await prisma.propertyPhoto.updateMany({ where: { propertyId }, data: { order: 0 } });

    const after = await preparePhotoPostImages(propertyId);
    expect(after!.paths).toHaveLength(1);
    // Новый индекс 0 — это B: путь не совпадает с прежним `-0` (снимком A) и
    // содержимое то же, что у прежнего второго слайда.
    expect(after!.paths[0]).not.toBe(before!.paths[0]);
    expect(after!.urls[0]).not.toBe(before!.urls[0]);
    expect((await fs.readFile(after!.paths[0])).equals(bBytes)).toBe(true);
  });

  it("исходники не менялись — sharp второй раз не вызывается (файл не переписывается)", async () => {
    const first = await preparePhotoPostImages(propertyId);
    const firstStat = await fs.stat(first!.paths[0]);
    await new Promise((r) => setTimeout(r, 25));
    const second = await preparePhotoPostImages(propertyId);
    expect(second!.paths).toEqual(first!.paths);
    expect((await fs.stat(second!.paths[0])).mtimeMs).toBe(firstStat.mtimeMs);
  });

  it("исходник на месте заменён новым файлом — выход пересобирается", async () => {
    const first = await preparePhotoPostImages(propertyId);
    const photo = await prisma.propertyPhoto.findFirstOrThrow({ where: { propertyId } });
    const src = path.join(uploadsDir, photo.url.replace(/^\/uploads\//, ""));
    const green = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 20, g: 200, b: 20 } } }).webp().toBuffer();
    await new Promise((r) => setTimeout(r, 25));
    await fs.writeFile(src, green);
    const second = await preparePhotoPostImages(propertyId);
    expect(second!.paths[0]).not.toBe(first!.paths[0]);
    const { dominant } = await sharp(second!.paths[0]).stats();
    expect(dominant.g).toBeGreaterThan(dominant.r);
    expect(dominant.g).toBeGreaterThan(dominant.b);
  });

  it("устаревшие выходы объекта (старше часа) убираются, свежие не трогаются", async () => {
    const first = await preparePhotoPostImages(propertyId);
    // Заменяем исходник ещё раз: прежний выход становится «чужим» для нового имени.
    const photo = await prisma.propertyPhoto.findFirstOrThrow({ where: { propertyId } });
    const src = path.join(uploadsDir, photo.url.replace(/^\/uploads\//, ""));
    const grey = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 120, g: 120, b: 120 } } }).webp().toBuffer();
    await new Promise((r) => setTimeout(r, 25));
    await fs.writeFile(src, grey);
    const second = await preparePhotoPostImages(propertyId);
    expect(second!.paths[0]).not.toBe(first!.paths[0]);
    // Свежий прежний выход (публикация могла ещё тянуть его по ссылке) остаётся.
    await expect(fs.stat(first!.paths[0])).resolves.toBeTruthy();
    // Состарили — следующая подготовка его убирает.
    const old = new Date(Date.now() - 2 * 3_600_000);
    await fs.utimes(first!.paths[0], old, old);
    await preparePhotoPostImages(propertyId);
    await expect(fs.stat(first!.paths[0])).rejects.toThrow();
    await expect(fs.stat(second!.paths[0])).resolves.toBeTruthy();
  });
});
