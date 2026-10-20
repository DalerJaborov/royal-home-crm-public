import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { identitiesForMessengerChannel, resolveContactProfile } from "../src/lib/contactProfiles.js";

/**
 * РАЗБОР КАНДИДАТОВ НА СЛИЯНИЕ ДОСЬЕ.
 *
 * Код находил их с 20.09 и складывал в базу, а решить было нечем — они копились
 * невидимо, пока бот читал одно досье из двух. Проверяется то, чем этот разбор
 * опасен, а не то, что кнопка нажимается:
 *
 *  1. решать может ТОЛЬКО право «объединять дубликаты»: склеенные досье двух
 *     людей означают чужой бюджет и чужой адрес в ответе бота;
 *  2. выживает досье с карточкой клиента, а не то, что оказалось слева;
 *  3. слитая запись не удаляется, а помечается — ошибку можно разобрать;
 *  4. повторное решение по тому же кандидату не проходит: иначе второе нажатие
 *     переписало бы решение, принятое кем-то другим;
 *  5. прочие предложения с участием слитой записи гаснут вместе с ней: иначе
 *     администратору предлагают надгробие, а подтверждение такого кандидата
 *     разводит одного человека по двум живым досье.
 *
 * Идентификаторы одной длины из одной полосы и уборка за собой — известная
 * ловушка этого репозитория.
 */

const runId = Date.now();
const digits6 = String(runId).slice(-6);
const WA_ID = `992918${digits6.slice(0, 3)}`;
const TG_ID = `tgl-${runId}`;
const password = "testpass123";

let mergerToken = "";
let plainToken = "";
let clientId = "";
let leftId = "";
let rightId = "";
let candidateId = "";
let thirdId = "";
let staleCandidateId = "";
const agentIds: string[] = [];

async function login(phone: string) {
  const res = await request(app).post("/api/v1/auth/login").send({ phone, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

async function cleanup(): Promise<void> {
  const ids = [leftId, rightId, thirdId].filter(Boolean);
  if (ids.length > 0) {
    await prisma.contactProfileMerge.deleteMany({
      where: { OR: [{ targetId: { in: ids } }, { sourceId: { in: ids } }] },
    });
    await prisma.contactLinkCandidate.deleteMany({
      where: { OR: [{ leftId: { in: ids } }, { rightId: { in: ids } }] },
    });
    await prisma.contactIdentity.deleteMany({ where: { profileId: { in: ids } } });
    await prisma.contactProfile.updateMany({ where: { id: { in: ids } }, data: { mergedIntoId: null } });
    await prisma.contactProfile.deleteMany({ where: { id: { in: ids } } });
  }
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
  if (agentIds.length > 0) await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
}

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  const director = await prisma.agent.create({
    data: { fullName: `Директор досье ${runId}`, phone: `+992968${digits6}`, role: "DIRECTOR", passwordHash },
  });
  const agent = await prisma.agent.create({
    data: { fullName: `Агент досье ${runId}`, phone: `+992969${digits6}`, role: "AGENT", passwordHash },
  });
  agentIds.push(director.id, agent.id);
  mergerToken = await login(`+992968${digits6}`);
  plainToken = await login(`+992969${digits6}`);

  const client = await prisma.client.create({
    data: { fullName: `Хангома досье ${runId}`, phone: `+${WA_ID}`, source: "WHATSAPP" },
    select: { id: true },
  });
  clientId = client.id;

  // Досье с карточкой клиента и живой перепиской.
  const left = await resolveContactProfile({
    identities: identitiesForMessengerChannel("WHATSAPP", WA_ID),
    name: "Хангома",
    nameSource: "profile",
  });
  leftId = left!.profileId;
  await prisma.contactProfile.update({
    where: { id: leftId },
    data: { clientId, messagesIn: 7 },
  });

  // Второе досье того же человека, пришедшее из другого канала: сообщений
  // больше, а карточки клиента нет. Выжить должно ПЕРВОЕ.
  const right = await resolveContactProfile({
    identities: [{ kind: "TG_CHAT_ID", value: TG_ID, trust: "TRANSPORT" }],
  });
  rightId = right!.profileId;
  await prisma.contactProfile.update({ where: { id: rightId }, data: { messagesIn: 20 } });

  const candidate = await prisma.contactLinkCandidate.create({
    data: { leftId: rightId, rightId: leftId, reason: "STATED_PHONE" },
    select: { id: true },
  });
  candidateId = candidate.id;

  // Третье досье, предложенное в пару к ВТОРОМУ. Когда второе уедет в слияние,
  // эта пара обязана погаснуть сама.
  const third = await resolveContactProfile({
    identities: [{ kind: "TG_CHAT_ID", value: `tgl-${runId}-3`, trust: "TRANSPORT" }],
  });
  thirdId = third!.profileId;
  const stale = await prisma.contactLinkCandidate.create({
    data: { leftId: thirdId, rightId: rightId, reason: "STATED_NAME" },
    select: { id: true },
  });
  staleCandidateId = stale.id;
});

afterAll(cleanup);

describe("кандидаты на слияние досье", () => {
  it("без права объединять дубликаты очередь не отдаётся и решение не проходит", async () => {
    const list = await request(app).get("/api/v1/contacts/links").set("Authorization", `Bearer ${plainToken}`);
    expect(list.status).toBe(403);
    const decide = await request(app)
      .post(`/api/v1/contacts/links/${candidateId}/confirm`)
      .set("Authorization", `Bearer ${plainToken}`);
    expect(decide.status).toBe(403);
    // Решение не прошло — кандидат обязан остаться нетронутым.
    const row = await prisma.contactLinkCandidate.findUnique({
      where: { id: candidateId },
      select: { status: true },
    });
    expect(row!.status).toBe("PENDING");
  });

  it("очередь показывает кандидата с причиной человеческими словами", async () => {
    const res = await request(app).get("/api/v1/contacts/links").set("Authorization", `Bearer ${mergerToken}`);
    expect(res.status).toBe(200);
    const mine = res.body.items.find((i: { id: string }) => i.id === candidateId);
    expect(mine).toBeTruthy();
    expect(mine.reason).toBe("STATED_PHONE");
    expect([mine.left.id, mine.right.id].sort()).toEqual([leftId, rightId].sort());
  });

  it("выживает досье с карточкой клиента, а не то, где больше сообщений", async () => {
    const res = await request(app)
      .post(`/api/v1/contacts/links/${candidateId}/confirm`)
      .set("Authorization", `Bearer ${mergerToken}`);
    expect(res.status).toBe(200);
    // В карточке уже висят сделки и история — она и решает, кто останется.
    expect(res.body.targetId).toBe(leftId);

    const [survivor, merged] = await Promise.all([
      prisma.contactProfile.findUnique({ where: { id: leftId }, select: { mergedIntoId: true } }),
      prisma.contactProfile.findUnique({ where: { id: rightId }, select: { mergedIntoId: true } }),
    ]);
    expect(survivor!.mergedIntoId).toBeNull();
    // Слитая запись НЕ удалена: ссылки диалогов остаются рабочими, а ошибочное
    // слияние можно разобрать.
    expect(merged!.mergedIntoId).toBe(leftId);

    const candidate = await prisma.contactLinkCandidate.findUnique({
      where: { id: candidateId },
      select: { status: true, decidedAt: true },
    });
    expect(candidate!.status).toBe("ACCEPTED");
    expect(candidate!.decidedAt).not.toBeNull();
  });

  it("повторное решение по разобранному кандидату не проходит", async () => {
    const again = await request(app)
      .post(`/api/v1/contacts/links/${candidateId}/confirm`)
      .set("Authorization", `Bearer ${mergerToken}`);
    expect(again.status).toBe(409);
    const dismiss = await request(app)
      .post(`/api/v1/contacts/links/${candidateId}/dismiss`)
      .set("Authorization", `Bearer ${mergerToken}`);
    expect(dismiss.status).toBe(404);
    // Решение, принятое первым нажатием, не переписано.
    const row = await prisma.contactLinkCandidate.findUnique({
      where: { id: candidateId },
      select: { status: true },
    });
    expect(row!.status).toBe("ACCEPTED");
  });

  it("прочие пары со слитым досье гаснут и больше не предлагаются", async () => {
    const stale = await prisma.contactLinkCandidate.findUnique({
      where: { id: staleCandidateId },
      select: { status: true },
    });
    expect(stale!.status).toBe("OBSOLETE");

    const list = await request(app).get("/api/v1/contacts/links").set("Authorization", `Bearer ${mergerToken}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((i: { id: string }) => i.id === staleCandidateId)).toBe(false);

    // И даже если такая пара откуда-то придёт, слить надгробие нельзя: иначе у
    // одного человека оказывается два досье, каждое с половиной правды.
    await prisma.contactLinkCandidate.update({
      where: { id: staleCandidateId },
      data: { status: "PENDING", decidedAt: null },
    });
    const confirm = await request(app)
      .post(`/api/v1/contacts/links/${staleCandidateId}/confirm`)
      .set("Authorization", `Bearer ${mergerToken}`);
    expect(confirm.status).toBe(500);

    const [third, merged] = await Promise.all([
      prisma.contactProfile.findUnique({ where: { id: thirdId }, select: { mergedIntoId: true } }),
      prisma.contactProfile.findUnique({ where: { id: rightId }, select: { mergedIntoId: true } }),
    ]);
    // Кольца A→B→A не возникло: слитая запись по-прежнему указывает на выжившую.
    expect(third!.mergedIntoId).toBeNull();
    expect(merged!.mergedIntoId).toBe(leftId);

    // Неудавшееся слияние вернуло кандидата в очередь, а не съело его молча.
    const after = await prisma.contactLinkCandidate.findUnique({
      where: { id: staleCandidateId },
      select: { status: true },
    });
    expect(after!.status).toBe("PENDING");
  });
});
