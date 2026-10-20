import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import {
  attachContactProfile,
  identitiesForMessengerChannel,
  mergeContactProfiles,
  proposeContactLink,
  recordContactFacts,
  recordContactTurn,
  resolveContactProfile,
  resolveMergedInto,
  setContactCategory,
} from "../src/lib/contactProfiles.js";
import { parseContactFacts, parseContactLanguageCounts } from "@royal-home/shared";

/**
 * ДОСЬЕ СОБЕСЕДНИКА — «карточка на каждого написавшего» (владелец 21.09.2026).
 *
 * Проверяется ровно то, из-за чего досье вообще появилось, и ровно то, чем его
 * легче всего испортить:
 *
 *  1. одно и то же досье на повторное касание — иначе бот снова «не помнит»;
 *  2. WhatsApp и звонок с ТОГО ЖЕ номера сходятся в одно досье сами (номер
 *     нормализуется хвостом из девяти цифр, как во всей остальной CRM);
 *  3. НАПЕЧАТАННЫЙ человеком номер чужое досье НЕ сливает — он заводит
 *     предложение на ручное подтверждение. Это главное свойство: склеенные досье
 *     двух людей означают чужой бюджет и чужой адрес в ответе бота;
 *  4. смена категории не стирает прошлое;
 *  5. факт, выясненный человеком, не перебивается догадкой модели;
 *  6. слияние переносит и признаки, и диалоги, и не теряет счётчики.
 *
 * Номера и идентификаторы собираются из одной полосы фиксированной длины и
 * убираются за собой — иначе они сталкиваются между файлами и на повторе прогона
 * (известная ловушка этого репозитория).
 */

const runId = Date.now().toString(36).slice(-6);
/** Только цифры: из букв base36 хвост номера в девять цифр не собрать. */
const digits6 = String(Date.now()).slice(-6);
/** wa_id приходит как «992…» без «+» — девять цифр после кода страны. */
const WA_ID = `992907${digits6.slice(0, 3)}`;
const IG_ID = `ig-${runId}`;
const TG_ID = `tg-${runId}`;
/** Отдельный номер того же вида: длина у всех одна, иначе они столкнутся. */
const STATED_TAIL = `918${digits6}`;

const createdProfiles: string[] = [];

async function cleanup(): Promise<void> {
  const values = [WA_ID, IG_ID, TG_ID, STATED_TAIL];
  const ids = new Set(createdProfiles);
  const rows = await prisma.contactIdentity.findMany({
    where: { value: { in: values } },
    select: { profileId: true },
  });
  for (const row of rows) ids.add(row.profileId);
  const list = [...ids];
  if (list.length === 0) return;
  await prisma.contactProfileMerge.deleteMany({
    where: { OR: [{ targetId: { in: list } }, { sourceId: { in: list } }] },
  });
  await prisma.contactLinkCandidate.deleteMany({
    where: { OR: [{ leftId: { in: list } }, { rightId: { in: list } }] },
  });
  await prisma.contactIdentity.deleteMany({ where: { profileId: { in: list } } });
  await prisma.contactProfile.updateMany({
    where: { id: { in: list } },
    data: { mergedIntoId: null },
  });
  await prisma.contactProfile.deleteMany({ where: { id: { in: list } } });
}

beforeAll(cleanup);
afterAll(cleanup);

describe("досье собеседника", () => {
  it("заводит досье на первом касании и НЕ заводит второе на повторном", async () => {
    const first = await resolveContactProfile({
      identities: identitiesForMessengerChannel("WHATSAPP", WA_ID),
      name: "Далер",
      nameSource: "profile",
    });
    expect(first).not.toBeNull();
    expect(first!.created).toBe(true);
    createdProfiles.push(first!.profileId);

    const second = await resolveContactProfile({
      identities: identitiesForMessengerChannel("WHATSAPP", WA_ID),
    });
    expect(second).not.toBeNull();
    expect(second!.created).toBe(false);
    expect(second!.profileId).toBe(first!.profileId);
  });

  it("звонок с того же номера попадает в то же досье, что переписка в WhatsApp", async () => {
    const chat = await resolveContactProfile({
      identities: identitiesForMessengerChannel("WHATSAPP", WA_ID),
    });
    expect(chat).not.toBeNull();
    createdProfiles.push(chat!.profileId);

    // Станция сообщает номер в виде +992…: приведение обязано дать тот же хвост,
    // что wa_id «99291…» — иначе один человек получил бы два досье.
    const call = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `+${WA_ID}`, trust: "TRANSPORT" }],
    });
    expect(call).not.toBeNull();
    expect(call!.created).toBe(false);
    expect(call!.profileId).toBe(chat!.profileId);
  });

  it("без подтверждённого каналом признака досье не заводится", async () => {
    const nothing = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: STATED_TAIL, trust: "STATED" }],
    });
    expect(nothing).toBeNull();
  });

  it("напечатанный человеком номер НЕ сливает чужое досье, а предлагает связку", async () => {
    const owner = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: STATED_TAIL, trust: "TRANSPORT" }],
    });
    expect(owner).not.toBeNull();
    createdProfiles.push(owner!.profileId);

    const stranger = await resolveContactProfile({
      identities: [{ kind: "IG_ID", value: IG_ID, trust: "TRANSPORT" }],
      // Тот же номер, но НАПЕЧАТАННЫЙ в чате: продавец диктует номер жены,
      // агент пересылает чужой контакт — сливать такое нельзя.
      name: null,
    });
    expect(stranger).not.toBeNull();
    createdProfiles.push(stranger!.profileId);
    expect(stranger!.profileId).not.toBe(owner!.profileId);

    await attachContactProfile({
      existingProfileId: stranger!.profileId,
      identities: [{ kind: "PHONE", value: STATED_TAIL, trust: "STATED" }],
      link: async () => {
        throw new Error("ссылку не надо заводить заново");
      },
    });

    // Номер остался у первого досье…
    const identity = await prisma.contactIdentity.findUnique({
      where: { kind_value: { kind: "PHONE", value: STATED_TAIL } },
      select: { profileId: true },
    });
    expect(identity?.profileId).toBe(owner!.profileId);

    // …а второе получило предложение связать, которое подтверждает человек.
    const [leftId, rightId] =
      owner!.profileId < stranger!.profileId
        ? [owner!.profileId, stranger!.profileId]
        : [stranger!.profileId, owner!.profileId];
    const candidate = await prisma.contactLinkCandidate.findUnique({
      where: { leftId_rightId: { leftId, rightId } },
      select: { reason: true, status: true },
    });
    expect(candidate?.status).toBe("PENDING");
    expect(candidate?.reason).toBe("STATED_PHONE");
  });

  it("одно и то же предложение не заводится дважды, с какой стороны ни приди", async () => {
    const a = await resolveContactProfile({
      identities: [{ kind: "TG_CHAT_ID", value: `${TG_ID}-a`, trust: "TRANSPORT" }],
    });
    const b = await resolveContactProfile({
      identities: [{ kind: "TG_CHAT_ID", value: `${TG_ID}-b`, trust: "TRANSPORT" }],
    });
    createdProfiles.push(a!.profileId, b!.profileId);
    await proposeContactLink({ leftId: a!.profileId, rightId: b!.profileId, reason: "MANUAL" });
    await proposeContactLink({ leftId: b!.profileId, rightId: a!.profileId, reason: "MANUAL" });
    const count = await prisma.contactLinkCandidate.count({
      where: {
        OR: [
          { leftId: a!.profileId, rightId: b!.profileId },
          { leftId: b!.profileId, rightId: a!.profileId },
        ],
      },
    });
    expect(count).toBe(1);
  });

  it("язык решается по большинству входящих, а при равенстве остаётся пустым", async () => {
    const profile = await resolveContactProfile({
      identities: [{ kind: "TG_CHAT_ID", value: `${TG_ID}-lang`, trust: "TRANSPORT" }],
    });
    createdProfiles.push(profile!.profileId);

    await recordContactTurn({ profileId: profile!.profileId, language: "ru" });
    await recordContactTurn({ profileId: profile!.profileId, language: "tg" });
    let row = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile!.profileId } });
    // Поровну — молчим: обратиться не на том языке хуже, чем ответить на языке
    // последнего сообщения.
    expect(row.language).toBeNull();
    expect(row.messagesIn).toBe(2);

    await recordContactTurn({ profileId: profile!.profileId, language: "tg" });
    row = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile!.profileId } });
    expect(row.language).toBe("tg");
    expect(parseContactLanguageCounts(row.languageCounts)).toEqual({ ru: 1, tg: 2 });
  });

  it("смена категории не стирает прошлое, а «не понял» не делает человека незнакомцем", async () => {
    const profile = await resolveContactProfile({
      identities: [{ kind: "TG_CHAT_ID", value: `${TG_ID}-cat`, trust: "TRANSPORT" }],
    });
    createdProfiles.push(profile!.profileId);

    await setContactCategory({ profileId: profile!.profileId, category: "SELLER", source: "model" });
    await setContactCategory({ profileId: profile!.profileId, category: "BUYER", source: "model" });
    await setContactCategory({ profileId: profile!.profileId, category: "UNKNOWN", source: "model" });

    const row = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile!.profileId } });
    expect(row.category).toBe("BUYER");
    const history = row.categoryHistory as { category: string }[];
    expect(history.map((h) => h.category)).toEqual(["SELLER", "BUYER"]);
  });

  it("выясненное человеком не перебивается догадкой модели", async () => {
    const profile = await resolveContactProfile({
      identities: [{ kind: "TG_CHAT_ID", value: `${TG_ID}-facts`, trust: "TRANSPORT" }],
    });
    createdProfiles.push(profile!.profileId);

    await recordContactFacts({
      profileId: profile!.profileId,
      domain: "buyer",
      values: { budgetMax: 60000, district: "Сино" },
      source: "agent",
    });
    await recordContactFacts({
      profileId: profile!.profileId,
      domain: "buyer",
      values: { budgetMax: 30000, rooms: 3 },
      source: "model",
    });

    const row = await prisma.contactProfile.findUniqueOrThrow({ where: { id: profile!.profileId } });
    const facts = parseContactFacts(row.facts);
    expect(facts.buyer.budgetMax?.v).toBe(60000);
    expect(facts.buyer.budgetMax?.src).toBe("agent");
    // Новое, чего человек не говорил, записалось как есть.
    expect(facts.buyer.rooms?.v).toBe(3);
  });

  it("слияние переносит признаки и диалоги, а слитая запись ведёт к выжившей", async () => {
    const target = await resolveContactProfile({
      identities: [{ kind: "TG_CHAT_ID", value: `${TG_ID}-t`, trust: "TRANSPORT" }],
    });
    const source = await resolveContactProfile({
      identities: [{ kind: "IG_ID", value: `${IG_ID}-s`, trust: "TRANSPORT" }],
    });
    createdProfiles.push(target!.profileId, source!.profileId);

    const conversation = await prisma.botConversation.create({
      data: {
        channel: "INSTAGRAM",
        subscriberId: `${IG_ID}-s`,
        messages: [],
        contactProfileId: source!.profileId,
      },
      select: { id: true },
    });

    await recordContactTurn({ profileId: source!.profileId, language: "ru" });
    const ok = await mergeContactProfiles({
      targetId: target!.profileId,
      sourceId: source!.profileId,
      reason: "MANUAL",
    });
    expect(ok).toBe(true);

    const movedIdentity = await prisma.contactIdentity.findUnique({
      where: { kind_value: { kind: "IG_ID", value: `${IG_ID}-s` } },
      select: { profileId: true },
    });
    expect(movedIdentity?.profileId).toBe(target!.profileId);

    const movedConversation = await prisma.botConversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: { contactProfileId: true },
    });
    expect(movedConversation.contactProfileId).toBe(target!.profileId);

    // Ссылка на слитую запись обязана привести к выжившей: диалоги, которые её
    // ещё держат, не должны терять человека.
    expect(await resolveMergedInto(source!.profileId)).toBe(target!.profileId);

    const survivor = await prisma.contactProfile.findUniqueOrThrow({
      where: { id: target!.profileId },
    });
    expect(survivor.messagesIn).toBe(1);
    expect(survivor.language).toBe("ru");

    const log = await prisma.contactProfileMerge.findFirst({
      where: { targetId: target!.profileId, sourceId: source!.profileId },
      select: { reason: true },
    });
    expect(log?.reason).toBe("MANUAL");

    await prisma.botConversation.delete({ where: { id: conversation.id } });
  });
});
