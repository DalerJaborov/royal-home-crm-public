import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Импорт объектов из Excel идёт по тем же правилам, что и создание в карточке
 * (находка №186): номер сотрудника в «контакте владельца» не принимается, дубль
 * по адресу — тоже, а новый объект не выходит в продажу сразу, а встаёт в
 * конвейер подготовки (без фото — «Ждём фото»), как после мастера.
 */

const runId = Date.now();
const password = "testpass123";
const adminPhone = `+992936${String(runId).slice(-7)}`;
const staffPhone = `+992937${String(runId).slice(-7)}`;
const districtName = `Район импорта правил ${runId}`;
const header = "Название;Тип;Комнаты;Площадь;Этаж;Этажей всего;Окна;Цена;Район;Адрес;Контакт владельца\n";
const ownerPhone = `+99293${String(runId).slice(-7)}`;
let adminId: string;
let staffId: string;
let token: string;

const importCsv = (body: string) =>
  request(app).post("/api/v1/import/properties").set("Authorization", `Bearer ${token}`).attach("file", Buffer.from(header + body), "p.csv");

beforeAll(async () => {
  const hash = await bcrypt.hash(password, 10);
  const admin = await prisma.agent.create({ data: { fullName: "Импорт правил Админ", phone: adminPhone, role: "ADMIN", passwordHash: hash } });
  adminId = admin.id;
  staffId = (await prisma.agent.create({ data: { fullName: "Сотрудник импорта", phone: staffPhone, role: "AGENT", passwordHash: hash } })).id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  expect(res.status).toBe(200);
  grantElevation(adminId);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.property.deleteMany({ where: { title: { startsWith: `Импорт правил ${runId}` } } });
  await prisma.district.deleteMany({ where: { name: districtName } });
  await deleteAgentsWithTraces([adminId, staffId]);
});

describe("импорт объектов — правила создания", () => {
  it("контакт владельца = номер сотрудника → строка пропущена", async () => {
    const res = await importCsv(`Импорт правил ${runId} A;Квартира;2;64;3;9;4;50000;${districtName};ул. Импортная, 1;${staffPhone}\n`);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].error).toContain("сотруднику");
  });

  it("новый объект не выходит в продажу сразу: без фото — «Ждём фото»", async () => {
    const res = await importCsv(`Импорт правил ${runId} B;Квартира;2;64;3;9;4;50000;${districtName};ул. Импортная, 2;${ownerPhone}\n`);
    expect(res.body).toMatchObject({ created: 1, skipped: [] });
    const saved = await prisma.property.findFirstOrThrow({ where: { title: `Импорт правил ${runId} B` } });
    expect(saved.status).toBe("AWAITING_PHOTOS");
    expect(saved.canonicalAddress).not.toBe("");
  });

  it("тот же адрес и площадь, что уже в базе → дубль пропущен", async () => {
    const res = await importCsv(`Импорт правил ${runId} C;Квартира;2;65;3;9;4;51000;${districtName};ул. Импортная, 2;${ownerPhone}\n`);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped[0].error).toMatch(/уже (есть|заведён)/);
  });

  it("два одинаковых адреса в одном файле → вторая строка пропущена", async () => {
    const res = await importCsv(
      `Импорт правил ${runId} D1;Квартира;2;70;5;9;4;60000;${districtName};ул. Импортная, 3;${ownerPhone}\n` +
        `Импорт правил ${runId} D2;Квартира;2;70;5;9;4;60000;${districtName};ул. Импортная, 3;${ownerPhone}\n`
    );
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].row).toBe(3);
  });
});
