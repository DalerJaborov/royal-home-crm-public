import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * CSV, сохранённый Excel в Windows-1251 (26.08.2026): при чтении как UTF-8
 * русские заголовки превращались в «�», ни одна колонка не находилась, и все
 * строки отбрасывались с «заполните поле». Разбор кодировки (`decodeCsvBuffer`)
 * был написан тогда же, но к загрузке так и не подключён — нашлось 28.09 при
 * уборке неиспользуемого кода.
 */

const runId = Date.now();
const password = "testpass123";
const adminPhone = `+992986${runId}`;
const clientPhone = `+992987${runId}`;
const propertyTitle = `Квартира 1251 ${runId}`;
const districtName = `Район 1251 ${runId}`;
let adminId: string;
let token: string;

/** Кириллица → Windows-1251 (в Node нет кодировщика в эту кодировку). */
function toWindows1251(text: string): Buffer {
  const bytes: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else if (code >= 0x410 && code <= 0x44f) bytes.push(code - 0x410 + 0xc0);
    else if (code === 0x401) bytes.push(0xa8);
    else if (code === 0x451) bytes.push(0xb8);
    else throw new Error(`нет в Windows-1251: ${ch}`);
  }
  return Buffer.from(bytes);
}

beforeAll(async () => {
  const admin = await prisma.agent.create({
    data: { fullName: "Импорт Админ", phone: adminPhone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 10) },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  expect(res.status).toBe(200);
  grantElevation(adminId);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { phone: clientPhone } });
  await prisma.property.deleteMany({ where: { title: propertyTitle } });
  await prisma.district.deleteMany({ where: { name: districtName } });
  await deleteAgentsWithTraces([adminId]);
});

describe("импорт CSV в Windows-1251", () => {
  it("клиенты: русские заголовки читаются, строка создаётся", async () => {
    const csv = toWindows1251(`Имя;Телефон;Источник\nЁлка Импортова;${clientPhone};Instagram\n`);
    const res = await request(app)
      .post("/api/v1/import/clients")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", csv, "clients.csv");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: [] });
    const saved = await prisma.client.findUnique({ where: { phone: clientPhone }, select: { fullName: true } });
    expect(saved?.fullName).toBe("Ёлка Импортова");
  });

  it("объекты: русские заголовки читаются, строка создаётся", async () => {
    const csv = toWindows1251(`Название;Тип;Комнаты;Площадь;Этаж;Этажей всего;Окна;Цена;Район;Адрес;Контакт владельца\n` +
        `${propertyTitle};Квартира;2;64;3;9;4;50000;${districtName};улица Рудаки, 12;Собственник +992 93 000 00 00\n`);
    const res = await request(app)
      .post("/api/v1/import/properties")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", csv, "properties.csv");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, skipped: [] });
  });
});
