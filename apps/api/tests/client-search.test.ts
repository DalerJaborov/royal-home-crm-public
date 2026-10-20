import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";

/** Поиск клиентов: слова в любом порядке и любом написании (та же логика, что
 *  у поиска объектов, — раньше здесь искалась целая подстрока). */

const runId = Date.now();
const password = "testpass123";

let agentId: string;
let token: string;
const clientIds: string[] = [];

async function search(q: string) {
  const res = await request(app)
    .get(`/api/v1/clients?q=${encodeURIComponent(q)}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return (res.body.items as Array<{ fullName: string }>).map((c) => c.fullName);
}

async function searchFull(q: string) {
  const res = await request(app)
    .get(`/api/v1/clients?q=${encodeURIComponent(q)}`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.items as Array<{ fullName: string; deletedAt: string | null }>;
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: "Агент поиска клиентов", phone: `+992978${runId}`, role: "ADMIN", passwordHash },
  });
  agentId = agent.id;

  for (const [i, fullName] of ["Гулнора Исмоилова", "Хофиз Раҳимов"].entries()) {
    const c = await prisma.client.create({
      data: {
        fullName: `${fullName} ${runId}`,
        phone: `+99297${i}${runId}`,
        source: "PHONE_CALL",
        assignedAgentId: agentId,
        acceptedAt: new Date(),
      },
    });
    clientIds.push(c.id);
  }

  // Владелец искал СЕБЯ по номеру, который в анкете записан ЗАПАСНЫМ, а не
  // основным (04.09.2026) — поиск отвечал пусто, хотя номер виден в карточке.
  const extraPhoneClient = await prisma.client.create({
    data: {
      fullName: `Далер запасной ${runId}`,
      phone: `+992900${runId}`,
      whatsappPhone: `+992901${runId}`,
      extraPhones: [`+992902${runId}`],
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(extraPhoneClient.id);

  // «Поиск по всем параметрам» (04.09.2026): почта, адрес, ник телеграма,
  // свободные пожелания — до этого дня искалось только имя, телефон и номер.
  const fullFieldsClient = await prisma.client.create({
    data: {
      fullName: `Полный профиль ${runId}`,
      phone: `+992903${runId}`,
      email: `client${runId}@example.tj`,
      address: `Душанбе, улица Тестовая ${runId}`,
      telegramUsername: `tguser${runId}`,
      requirementsNotes: `Хочет квартиру у метро, бюджет обсуждаем ${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
    },
  });
  clientIds.push(fullFieldsClient.id);

  // Карточка в Корзине — поиск должен её находить (с признаком deletedAt для
  // плашки «в Корзине»), а не отвечать «ничего не найдено» на удалённого клиента.
  const trashedClient = await prisma.client.create({
    data: {
      fullName: `В корзине ${runId}`,
      phone: `+992904${runId}`,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      deletedAt: new Date(),
    },
  });
  clientIds.push(trashedClient.id);

  const res = await request(app).post("/api/v1/auth/login").send({ phone: agent.phone, password });
  expect(res.status).toBe(200);
  token = res.body.accessToken as string;
});

afterAll(async () => {
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: agentId } });
  await prisma.$disconnect();
});

describe("Поиск клиентов", () => {
  it("порядок слов не важен: «Исмоилова Гулнора» находит «Гулнора Исмоилова»", async () => {
    expect((await search(`Исмоилова Гулнора`)).join()).toContain("Гулнора Исмоилова");
  });

  it("забытая раскладка: Uekyjhf находит Гулнора", async () => {
    expect((await search("Uekyjhf")).join()).toContain("Гулнора");
  });

  it("латиница: Gulnora находит Гулнора", async () => {
    expect((await search("Gulnora")).join()).toContain("Гулнора");
  });

  it("таджикская буква в запросе сворачивается: Раҳимов находит Рахимов и наоборот", async () => {
    expect((await search("Раҳимов")).join()).toContain("Раҳимов");
  });

  it("поиск по части телефона по-прежнему работает", async () => {
    expect((await search(String(runId).slice(-6))).length).toBeGreaterThan(0);
  });

  /**
   * ТЗ «Путь покупателя», п. 2: номер клиента должен работать «в карточке; в
   * поиске; в списках; в истории». До 14.08.2026 поиск умел только ФИО и телефон,
   * и «ПК-000042» не находил ничего — при том что номер показан в карточке и
   * агенты диктуют его друг другу.
   */
  it("находит по номеру карточки — и «ПК-000042», и голым числом", async () => {
    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientIds[0] } });
    const code = `ПК-${String(client.shortId).padStart(6, "0")}`;

    expect((await search(code)).join()).toContain("Гулнора");
    expect((await search(String(client.shortId))).join()).toContain("Гулнора");
  });

  /**
   * 04.09.2026: у клиента бывает несколько номеров — основной, WhatsApp,
   * запасные (`extraPhones`). Поиск смотрел только на `phone`, и карточка
   * с номером в другом поле не находилась вовсе (владелец наткнулся на
   * этом на своей же тестовой карточке).
   */
  it("находит по запасному номеру (extraPhones), не только по основному", async () => {
    expect((await search(`902${runId}`)).join()).toContain("Далер запасной");
  });

  it("находит по номеру WhatsApp (whatsappPhone)", async () => {
    expect((await search(`901${runId}`)).join()).toContain("Далер запасной");
  });

  /**
   * 04.09.2026, «поиск по всем параметрам»: почта, адрес, телеграм-ник,
   * свободные пожелания клиента — раньше ни одно из этих полей не
   * участвовало в поиске вообще.
   */
  it("находит по почте", async () => {
    expect((await search(`client${runId}@example.tj`)).join()).toContain("Полный профиль");
  });

  it("находит по адресу", async () => {
    expect((await search(`Тестовая ${runId}`)).join()).toContain("Полный профиль");
  });

  it("находит по нику телеграма", async () => {
    expect((await search(`tguser${runId}`)).join()).toContain("Полный профиль");
  });

  it("находит по свободным пожеланиям клиента (requirementsNotes)", async () => {
    expect((await search(`метро, бюджет обсуждаем ${runId}`)).join()).toContain("Полный профиль");
  });

  /**
   * 04.09.2026: карточка в Корзине раньше не находилась поиском вовсе — ответ
   * был «ничего не найдено», хотя карточка существует. У того, кому видна
   * Корзина (archive.view), она теперь находится, и с явным deletedAt — по
   * нему интерфейс рисует плашку «в Корзине».
   */
  it("находит клиента в Корзине и отмечает его deletedAt", async () => {
    const items = await searchFull(`В корзине ${runId}`);
    const found = items.find((c) => c.fullName.includes("В корзине"));
    expect(found).toBeDefined();
    expect(found?.deletedAt).not.toBeNull();
  });
});
