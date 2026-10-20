import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { findClientByPhoneDigits } from "../src/lib/whatsappPhone.js";
import { findPhoneOwners, findPhoneConflicts } from "../src/lib/clientPhones.js";
import { extractAllPhones } from "../src/ai/leadQualifier.js";
import { createLeadFromChannel } from "../src/leads.js";

/**
 * ЗАПАСНЫЕ НОМЕРА КЛИЕНТА (18.08.2026).
 *
 * Два живых случая, ради которых поле появилось, и стерегут эти тесты:
 *
 *  1. Клиент звонит со ВТОРОЙ симки («на первой кончились деньги»). CRM обязана
 *     узнать его на гудке и увести звонок на ЕГО агента — иначе заводится вторая
 *     карточка и клиента получает другой сотрудник.
 *  2. Продавец присылает боту несколько номеров сразу. Раньше в карточку попадал
 *     один, а остальные агент переписывал текстом в заметки — то есть терял.
 *
 * И два правила, без которых от поля был бы вред:
 *  3. Номер не может принадлежать двоим — иначе звонок находит две карточки, и
 *     маршрутизация отказывается переводить (ambiguous_phone).
 *  4. Звоним по ГЛАВНОМУ. Запасной номер — только для узнавания входящего.
 */

const runId = Date.now();
/** Хвосты уникальны для прогона: база общая с сидом и параллельными прогонами. */
const t = String(runId).slice(-6);
const mainPhone = `+992944${t}`;
const secondPhone = `+992551${t}`;
const thirdPhone = `+992552${t}`;
const strangerPhone = `+992553${t}`;

const clientIds: string[] = [];
let agentId = "";
let otherAgentId = "";
let adminId = "";
let adminToken = "";
let ownerClientId = "";
let strangerClientId = "";

const password = "testpass123";

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const agent = await prisma.agent.create({
    data: { fullName: `Агент запасных ${runId}`, phone: `+992910${t}`, role: "AGENT", passwordHash },
  });
  agentId = agent.id;
  const other = await prisma.agent.create({
    data: { fullName: `Другой агент ${runId}`, phone: `+992911${t}`, role: "AGENT", passwordHash },
  });
  otherAgentId = other.id;
  const admin = await prisma.agent.create({
    data: { fullName: `Админ запасных ${runId}`, phone: `+992912${t}`, role: "ADMIN", passwordHash },
  });
  adminId = admin.id;
  const login = await request(app).post("/api/v1/auth/login").send({ phone: admin.phone, password });
  expect(login.status).toBe(200);
  adminToken = login.body.accessToken as string;

  // Клиент со вторым номером в запасных — его ведёт agent.
  const owner = await prisma.client.create({
    data: {
      fullName: `Клиент с двумя симками ${runId}`,
      phone: mainPhone,
      source: "PHONE_CALL",
      assignedAgentId: agentId,
      acceptedAt: new Date(),
      // Записан НАРОЧНО в другом виде («992 551 …» без плюса и с пробелами): номера
      // в базу ложатся как их набрали, и узнавание обязано быть терпимым к записи.
      extraPhones: [secondPhone.replace("+992", "992 ").replace(/(\d{3})(\d{3})$/, "$1 $2")],
    },
  });
  ownerClientId = owner.id;
  clientIds.push(owner.id);

  // Совершенно другой клиент, у которого strangerPhone — ГЛАВНЫЙ номер.
  const stranger = await prisma.client.create({
    data: {
      fullName: `Чужой клиент ${runId}`,
      phone: strangerPhone,
      source: "WALK_IN",
      assignedAgentId: otherAgentId,
      acceptedAt: new Date(),
    },
  });
  strangerClientId = stranger.id;
  clientIds.push(stranger.id);
});

afterAll(async () => {
  await prisma.interaction.deleteMany({ where: { clientId: { in: clientIds } } });
  await prisma.client.deleteMany({ where: { id: { in: clientIds } } });
  await prisma.agent.deleteMany({ where: { id: { in: [agentId, otherAgentId, adminId] } } });
  await prisma.$disconnect();
});

describe("входящий со второго номера — тот же клиент и тот же агент", () => {
  it("находит карточку по запасному номеру, записанному в другом формате", async () => {
    // Станция даёт девять цифр без кода страны — ровно так и проверяем.
    const found = await findClientByPhoneDigits(secondPhone.replace("+992", ""));
    expect(found?.id).toBe(ownerClientId);
  });

  it("звонок остаётся адресован ЕГО агенту", async () => {
    const found = await findClientByPhoneDigits(secondPhone);
    const card = await prisma.client.findUnique({
      where: { id: found!.id },
      select: { assignedAgentId: true },
    });
    expect(card?.assignedAgentId).toBe(agentId);
  });

  it("по номеру находится РОВНО одна карточка — иначе перевод откажет (ambiguous_phone)", async () => {
    const owners = await findPhoneOwners([secondPhone]);
    expect(owners).toHaveLength(1);
    expect(owners[0].id).toBe(ownerClientId);
    expect(owners[0].matchedIn).toBe("extra");
  });

  it("ЗВОНИМ ПО ГЛАВНОМУ: поиск по запасному отдаёт основной номер карточки", async () => {
    // Это и есть страховка правила «дополнительные не равны главному»: всё, что
    // идёт дальше по коду (создание лида, набор номера), получает `phone`.
    const found = await findClientByPhoneDigits(secondPhone);
    expect(found?.phone).toBe(mainPhone);
  });
});

describe("бот не теряет номера из сообщения", () => {
  it("extractAllPhones достаёт ВСЕ номера, а не первый", () => {
    const text = `Салом! Хона мефурушам, 1 050 000 сомонӣ\n910001044\n+992935001122\n88 777 66 55`;
    expect(extractAllPhones(text)).toEqual(["+992910001044", "+992935001122", "+992887776655"]);
  });

  it("цена телефоном не становится", () => {
    expect(extractAllPhones("3 сотих, нарх 1050000 сомонӣ")).toEqual([]);
  });

  it("лишние номера уезжают в карточку, а главным остаётся тот, что назвали для звонка", async () => {
    const lead = await createLeadFromChannel({
      fullName: `Продавец с четырьмя номерами ${runId}`,
      phone: thirdPhone,
      source: "INSTAGRAM",
      kind: "SELLER",
      extraPhones: extractAllPhones(`${thirdPhone}\n918${t}\n+99293${t}0`),
    });
    clientIds.push(lead.clientId);
    const saved = await prisma.client.findUnique({
      where: { id: lead.clientId },
      select: { phone: true, extraPhones: true },
    });
    expect(saved?.phone).toBe(thirdPhone);
    // Сам главный номер в запасных не дублируется — иначе агент видел бы «второй»
    // телефон, которого нет.
    expect(saved?.extraPhones).toEqual([`+992918${t}`, `+99293${t}0`]);
  });

  it("чужой номер бот молча пропускает — приём заявки из-за него не падает", async () => {
    const lead = await createLeadFromChannel({
      fullName: `Клиент с чужим номером ${runId}`,
      phone: `+992554${t}`,
      source: "INSTAGRAM",
      extraPhones: [strangerPhone],
    });
    clientIds.push(lead.clientId);
    const saved = await prisma.client.findUnique({
      where: { id: lead.clientId },
      select: { extraPhones: true },
    });
    expect(saved?.extraPhones).toEqual([]);
  });
});

describe("номер не может принадлежать двоим", () => {
  it("findPhoneConflicts видит и чужой главный, и чужой запасной", async () => {
    const conflicts = await findPhoneConflicts([strangerPhone, secondPhone]);
    expect(conflicts.map((c) => c.clientId).sort()).toEqual([ownerClientId, strangerClientId].sort());
    expect(conflicts.find((c) => c.phone === strangerPhone)?.isPrimary).toBe(true);
    expect(conflicts.find((c) => c.phone === secondPhone)?.isPrimary).toBe(false);
  });

  it("PATCH с чужим номером в запасных — 409 и ПОНЯТНАЯ ошибка с указанием карточки", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${ownerClientId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ extraPhones: [strangerPhone] });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("уже принадлежит другому клиенту");
    // Именно «чья карточка», а не безликое «номер занят»: без этого агенту некуда идти.
    expect(res.body.error).toContain(`ПК-`);
    expect(res.body.error).toContain(`Чужой клиент ${runId}`);
    // Ничего не записалось.
    const after = await prisma.client.findUnique({ where: { id: ownerClientId }, select: { extraPhones: true } });
    expect(after?.extraPhones).not.toContain(strangerPhone);
  });

  it("создание клиента с чужим номером в запасных тоже отбивается", async () => {
    const res = await request(app)
      .post("/api/v1/clients")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        fullName: `Новый с чужим запасным ${runId}`,
        phone: `+992555${t}`,
        source: "WALK_IN",
        extraPhones: [strangerPhone],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("уже принадлежит другому клиенту");
    const created = await prisma.client.findFirst({ where: { phone: `+992555${t}` }, select: { id: true } });
    expect(created).toBeNull();
  });

  it("свои собственные номера сохранению не мешают", async () => {
    const res = await request(app)
      .patch(`/api/v1/clients/${ownerClientId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ extraPhones: [secondPhone] });
    expect(res.status).toBe(200);
    expect(res.body.extraPhones).toEqual([secondPhone]);
  });
});
