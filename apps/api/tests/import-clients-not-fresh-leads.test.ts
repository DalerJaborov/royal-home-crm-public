import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { randomInt } from "node:crypto";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { grantElevation } from "../src/lib/stepUp.js";
import { penalizeMissedFirstCalls, SELF_CREATED_ASSIGN_REASON } from "../src/services/leads/firstCall.js";
import { deleteAgentsWithTraces } from "./helpers/cleanupAgents.js";

/**
 * Импорт клиентов из CSV — перенос базы, а не свежие лиды (B3 и B8 глубокой
 * проверки 02.10.2026).
 *
 * B3: каждая импортированная строка числилась «принятой агентом» без отметки
 * «завёл сам», и через 15 минут крон первого звонка штрафовал импортёра по
 * каждой строке (плюс запись в хронологию и уведомление руководителям).
 * B8: дубль искался только точной строкой телефона — тот же номер в другой
 * записи, запасной номер или WhatsApp другой карточки давали вторую карточку
 * того же человека.
 */

const password = "testpass123";
const tail7 = () => String(randomInt(1_000_000, 9_999_999));
let adminId = "";
let adminPhone = "";
let token = "";
const importedPhones: string[] = [];
const clientIds: string[] = [];

const importCsv = (body: string) =>
  request(app)
    .post("/api/v1/import/clients")
    .set("Authorization", `Bearer ${token}`)
    .attach("file", Buffer.from(`Имя;Телефон;Источник\n${body}`), "clients.csv");

beforeAll(async () => {
  adminPhone = `+99293${tail7()}`;
  const admin = await prisma.agent.create({
    data: { fullName: "Импорт клиентов Админ", phone: adminPhone, role: "ADMIN", passwordHash: await bcrypt.hash(password, 4) },
  });
  adminId = admin.id;
  const res = await request(app).post("/api/v1/auth/login").send({ phone: adminPhone, password });
  expect(res.status).toBe(200);
  grantElevation(adminId);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  const imported = await prisma.client.findMany({ where: { phone: { in: importedPhones } }, select: { id: true } });
  const ids = [...clientIds, ...imported.map((c) => c.id)];
  await prisma.interaction.deleteMany({ where: { clientId: { in: ids } } });
  await prisma.client.deleteMany({ where: { id: { in: ids } } });
  await deleteAgentsWithTraces([adminId]);
  await prisma.$disconnect();
});

describe("импорт клиентов — не новые лиды", () => {
  it("строка помечается «завёл сам», и крон первого звонка её не штрафует", async () => {
    const phone = `+99293${tail7()}`;
    importedPhones.push(phone);
    const res = await importCsv(`Старый клиент;${phone};Instagram\n`);
    expect(res.body).toMatchObject({ created: 1, skipped: [] });
    const saved = await prisma.client.findUniqueOrThrow({ where: { phone } });
    expect(saved.assignReason).toBe(SELF_CREATED_ASSIGN_REASON);

    // Сдвигаем «принят» на 20 минут назад — окно первого звонка прошло.
    await prisma.client.update({ where: { id: saved.id }, data: { acceptedAt: new Date(Date.now() - 20 * 60_000) } });
    await penalizeMissedFirstCalls();
    const notes = await prisma.interaction.count({
      where: { clientId: saved.id, notes: { contains: "Первый звонок" } },
    });
    expect(notes).toBe(0);
  });
});

describe("импорт клиентов — дубль по любому номеру карточки", () => {
  it("тот же номер в другой записи (без +992) — строка пропущена", async () => {
    const t = tail7();
    const existing = await prisma.client.create({
      data: { fullName: "Уже в базе A", phone: `+99293${t}`, kind: "BUYER", source: "WALK_IN" },
    });
    clientIds.push(existing.id);
    const res = await importCsv(`Тот же человек;93${t};Instagram\n`);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].error).toContain("Уже в базе A");
  });

  it("номер записан у другой карточки запасным или WhatsApp — строка пропущена", async () => {
    const extra = `+99293${tail7()}`;
    const wa = `+99293${tail7()}`;
    const existing = await prisma.client.create({
      data: {
        fullName: "Уже в базе B",
        phone: `+99293${tail7()}`,
        extraPhones: [extra],
        whatsappPhone: wa,
        kind: "BUYER",
        source: "WALK_IN",
      },
    });
    clientIds.push(existing.id);
    importedPhones.push(extra, wa);
    const res = await importCsv(`Второй номер;${extra};Instagram\nВотсап;${wa};Instagram\n`);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toHaveLength(2);
  });

  it("одна и та же цифра дважды в файле в разной записи — вторая строка пропущена", async () => {
    const t = tail7();
    importedPhones.push(`+99293${t}`, `93${t}`);
    const res = await importCsv(`Первый;+99293${t};Instagram\nВторой;93${t};Instagram\n`);
    expect(res.body.created).toBe(1);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.skipped[0].row).toBe(3);
  });
});
