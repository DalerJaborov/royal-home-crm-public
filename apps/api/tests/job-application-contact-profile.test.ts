import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseContactFacts } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { jobApplicationKnownFacts, recordJobApplication } from "../src/lib/jobApplications.js";
import { contactProfileForPrompt } from "../src/lib/contactProfileMemory.js";
import {
  identitiesForMessengerChannel,
  linkContactProfileToClient,
  mergeContactProfiles,
  resolveContactProfile,
} from "../src/lib/contactProfiles.js";

/**
 * АНКЕТА КАНДИДАТА ПОМНИТСЯ ПО ЧЕЛОВЕКУ, А НЕ ПО РАЗГОВОРУ.
 *
 * До 21.09.2026 анкета жила одним диалогом: кандидат, написавший сперва в
 * Instagram, а потом в WhatsApp, заводил вторую анкету, а бот заново спрашивал
 * возраст и опыт. Проверяется ровно то, чем это легко испортить обратно:
 *
 *  1. анкета находит досье САМА, даже если вызывающий его не передал (в проекте
 *     пять мест вызова, и забытый аргумент в одном тихо отключил бы память);
 *  2. поля анкеты зеркалятся в досье и доживают до другого разговора;
 *  3. ОТРИЦАТЕЛЬНЫЙ ответ («не учусь», «не работаю») виден в промте — иначе бот
 *     спрашивает про учёбу заново, а по правилам отбора это и есть допуск;
 *  4. свод по человеку собирает оба его разговора, и свежее перекрывает старое;
 *  5. слияние досье уводит анкеты за собой (класс «спутник не гаснет»);
 *  6. связка с карточкой клиента проставляется и в анкетах.
 *
 * Идентификаторы — одной фиксированной длины, с уборкой за собой (известная
 * ловушка репозитория: иначе они сталкиваются между файлами и на повторе).
 */

const digits6 = String(Date.now()).slice(-6);
const WA_ID = `992915${digits6.slice(0, 3)}`;
const WA_ID2 = `992916${digits6.slice(0, 3)}`;
const CONV_A = `conv-job-a-${digits6}`;
const CONV_B = `conv-job-b-${digits6}`;

const profiles: string[] = [];

async function cleanup(): Promise<void> {
  await prisma.jobApplication.deleteMany({ where: { conversationId: { in: [CONV_A, CONV_B] } } });
  await prisma.botConversation.deleteMany({ where: { id: { in: [CONV_A, CONV_B] } } });
  const ids = new Set(profiles);
  const rows = await prisma.contactIdentity.findMany({
    where: { value: { in: [WA_ID, WA_ID2] } },
    select: { profileId: true },
  });
  for (const row of rows) ids.add(row.profileId);
  const list = [...ids];
  if (list.length === 0) return;
  await prisma.jobApplication.deleteMany({ where: { contactProfileId: { in: list } } });
  await prisma.contactIdentity.deleteMany({ where: { profileId: { in: list } } });
  await prisma.contactProfile.updateMany({ where: { id: { in: list } }, data: { mergedIntoId: null } });
  await prisma.contactProfileMerge.deleteMany({ where: { sourceId: { in: list } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: list } } });
}

beforeAll(cleanup);
afterAll(cleanup);

async function profileFor(waId: string): Promise<string> {
  const resolved = await resolveContactProfile({ identities: identitiesForMessengerChannel("WHATSAPP", waId) });
  expect(resolved).not.toBeNull();
  profiles.push(resolved!.profileId);
  return resolved!.profileId;
}

async function conversationFor(id: string, profileId: string, subscriberId: string): Promise<void> {
  // upsert, а не create: разговор в этом файле переиспользуется несколькими
  // проверками, и второй create падал бы на своём же ключе.
  await prisma.botConversation.upsert({
    where: { id },
    create: { id, channel: "WHATSAPP", subscriberId, contactProfileId: profileId },
    update: { contactProfileId: profileId },
  });
}

describe("анкета кандидата помнится по человеку", () => {
  it("находит досье по разговору сама и зеркалит анкету в память бота", async () => {
    const profileId = await profileFor(WA_ID);
    await conversationFor(CONV_A, profileId, WA_ID);

    // contactProfileId НАРОЧНО не передаём — так вызывает обратная засыпка и
    // ручной перевод клиента в кандидаты.
    await recordJobApplication({
      conversationId: CONV_A,
      channel: "WHATSAPP",
      draft: { age: 27, experience: "два года в продажах", studyingNow: false, employedNow: false },
    });

    const app = await prisma.jobApplication.findUnique({
      where: { conversationId: CONV_A },
      select: { contactProfileId: true, age: true },
    });
    expect(app?.contactProfileId).toBe(profileId);
    expect(app?.age).toBe(27);

    const row = await prisma.contactProfile.findUnique({ where: { id: profileId }, select: { facts: true } });
    const facts = parseContactFacts(row!.facts);
    expect(facts.job.age?.v).toBe(27);
    expect(facts.job.experience?.v).toBe("два года в продажах");
    // Номер в фактах не дублируется — только признак «дал».
    expect(facts.job.phone).toBeUndefined();
  });

  it("отрицательный ответ про учёбу и работу виден в промте, а не пропадает", async () => {
    const profileId = await profileFor(WA_ID);
    await recordJobApplication({
      conversationId: CONV_A,
      channel: "WHATSAPP",
      contactProfileId: profileId,
      draft: { studyingNow: false, employedNow: false, hasCar: true, phone: "992900111222" },
    });

    const forPrompt = await contactProfileForPrompt(profileId, { stage: "chatting" });
    const job = forPrompt!.job.join("; ");
    expect(job).toContain("сейчас не учится");
    expect(job).toContain("сейчас не работает");
    expect(job).toContain("есть машина");
    expect(job).toContain("номер уже дал");
    // Сам номер в промт не уходит.
    expect(job).not.toContain("992900111222");
  });

  it("свод собирает оба разговора одного человека, свежее перекрывает старое", async () => {
    const profileId = await profileFor(WA_ID);
    await conversationFor(CONV_B, profileId, `${WA_ID}-b`);

    await recordJobApplication({
      conversationId: CONV_A,
      channel: "INSTAGRAM",
      contactProfileId: profileId,
      draft: { city: "Хуҷанд", age: 27 },
    });
    await recordJobApplication({
      conversationId: CONV_B,
      channel: "WHATSAPP",
      contactProfileId: profileId,
      draft: { city: "Душанбе" },
    });

    const known = await jobApplicationKnownFacts(profileId);
    // Возраст назван в первом разговоре, город переехал во втором.
    expect(known.age).toBe(27);
    expect(known.city).toBe("Душанбе");
  });

  it("слияние досье уводит анкеты за собой", async () => {
    const target = await profileFor(WA_ID);
    const source = await profileFor(WA_ID2);
    await conversationFor(CONV_B, source, WA_ID2);
    await recordJobApplication({
      conversationId: CONV_B,
      channel: "TELEGRAM",
      contactProfileId: source,
      draft: { name: "Фируз" },
    });

    const merged = await mergeContactProfiles({ targetId: target, sourceId: source, reason: "TEST" });
    expect(merged).toBe(true);

    const app = await prisma.jobApplication.findUnique({
      where: { conversationId: CONV_B },
      select: { contactProfileId: true },
    });
    expect(app?.contactProfileId).toBe(target);
  });

  it("карточка клиента проставляется и в анкетах, когда она появилась", async () => {
    const profileId = await profileFor(WA_ID);
    await conversationFor(CONV_A, profileId, WA_ID);
    await recordJobApplication({
      conversationId: CONV_A,
      channel: "WHATSAPP",
      contactProfileId: profileId,
      draft: { name: "Нигина" },
    });

    const client = await prisma.client.create({
      data: { fullName: `Кандидат ${digits6}`, phone: `99290${digits6.slice(0, 4)}`, source: "WHATSAPP" },
    });
    try {
      await linkContactProfileToClient(profileId, client.id);
      const app = await prisma.jobApplication.findUnique({
        where: { conversationId: CONV_A },
        select: { clientId: true },
      });
      expect(app?.clientId).toBe(client.id);
    } finally {
      await prisma.jobApplication.updateMany({ where: { clientId: client.id }, data: { clientId: null } });
      await prisma.contactProfile.updateMany({ where: { clientId: client.id }, data: { clientId: null } });
      await prisma.client.delete({ where: { id: client.id } });
    }
  });
});
