import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../src/db.js";
import { recordContactFacts, resolveContactProfile } from "../src/lib/contactProfiles.js";
import { contactProfileForPrompt } from "../src/lib/contactProfileMemory.js";
import { parseContactFacts, readContactFacts } from "@royal-home/shared";
import type { LeadDraft } from "../src/ai/leadQualifier.js";

/**
 * ДОСЬЕ ГОВОРИТ БОТУ ТОЛЬКО ПРАВДУ (разбор 21.09, docs/bot-audit-21-09.md, §5).
 *
 * Четыре разных способа соврать, все найдены в одном разборе:
 *
 *  1. хвост из девяти цифр — признак TRANSPORT, то есть повод связать каналы
 *     САМ, без человека. Узбекский +998 90 … и душанбинский +992 90 … дают один
 *     хвост: память двух незнакомых людей склеивалась молча;
 *  2. ФИО из карточки CRM записывалось как «человек назвал сам», и бот
 *     здоровался служебной пометкой агента;
 *  3. карточка, удалённая в Корзину, продолжала звучать в промте действующей;
 *  4. непонятое поле фактов читалось как пустое И ЗАПИСЫВАЛОСЬ обратно —
 *     поднятая version стёрла бы накопленное за месяцы с первого же сообщения.
 *
 * Номера одной длины из одной полосы и уборка за собой — известная ловушка
 * этого репозитория.
 */

const digits6 = String(Date.now()).slice(-6);
/** Один и тот же местный номер в двух странах — вся суть находки. */
const LOCAL_TAIL = `905${digits6.slice(0, 3)}${digits6.slice(0, 3)}`;
const TJ_PHONE = `992${LOCAL_TAIL}`;
const UZ_PHONE = `998${LOCAL_TAIL}`;

const values = [LOCAL_TAIL, TJ_PHONE, UZ_PHONE];
const created: string[] = [];
let clientId = "";

async function cleanup(): Promise<void> {
  const ids = new Set(created);
  const rows = await prisma.contactIdentity.findMany({
    where: { value: { in: values } },
    select: { profileId: true },
  });
  for (const row of rows) ids.add(row.profileId);
  const list = [...ids];
  if (list.length > 0) {
    await prisma.contactIdentity.deleteMany({ where: { profileId: { in: list } } });
    await prisma.contactProfile.updateMany({ where: { id: { in: list } }, data: { mergedIntoId: null, clientId: null } });
    await prisma.contactProfile.deleteMany({ where: { id: { in: list } } });
  }
  if (clientId) await prisma.client.deleteMany({ where: { id: clientId } });
}

beforeAll(cleanup);
afterAll(cleanup);

/** Пустой черновик: печатаем то, что знает досье, а не то, что уже в диалоге. */
const emptyDraft = { stage: "chatting" } as unknown as LeadDraft;

describe("номер с чужим кодом страны не сливает двух людей", () => {
  it("узбекский и душанбинский номер с одинаковым хвостом — разные досье", async () => {
    const tj = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `+${TJ_PHONE}`, trust: "TRANSPORT" }],
    });
    const uz = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `+${UZ_PHONE}`, trust: "TRANSPORT" }],
    });
    expect(tj).not.toBeNull();
    expect(uz).not.toBeNull();
    created.push(tj!.profileId, uz!.profileId);
    expect(uz!.profileId).not.toBe(tj!.profileId);
  });

  it("тот же душанбинский номер в любой записи — по-прежнему одно досье", async () => {
    // Местный номер со станции приходит без кода страны, из формы сайта — с
    // «+992», руками — с пробелами. Это один человек, и так было всегда.
    const bare = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: LOCAL_TAIL, trust: "TRANSPORT" }],
    });
    const spaced = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `992 ${LOCAL_TAIL.slice(0, 2)} ${LOCAL_TAIL.slice(2)}`, trust: "TRANSPORT" }],
    });
    expect(bare!.profileId).toBe(spaced!.profileId);
    // И это то же досье, что завёл «+992…» выше, а не третье.
    expect(bare!.created).toBe(false);
  });
});

describe("что досье рассказывает боту", () => {
  it("ФИО из карточки CRM не выдаётся за имя, которым человек представился", async () => {
    const profile = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `+${TJ_PHONE}`, trust: "TRANSPORT" }],
      // Ровно та жалоба: в карточке агент держит служебную пометку.
      name: "Далер (брат Умеда, звонить после 18)",
      nameSource: "crm",
    });
    // Печатать нечего: имя из карточки в промт не идёт, а больше о человеке
    // пока ничего не известно — блока досье в промте не будет вовсе.
    expect(await contactProfileForPrompt(profile!.profileId, emptyDraft)).toBeNull();

    // Контроль: имя, которым человек представился САМ, в промт идёт — иначе
    // проверка выше доказывала бы только то, что блок всегда пуст.
    await prisma.contactProfile.update({
      where: { id: profile!.profileId },
      data: { displayName: "Далер", nameSource: "self" },
    });
    const withSelf = await contactProfileForPrompt(profile!.profileId, emptyDraft);
    expect(withSelf!.selfName).toBe("Далер");

    // И обратно — карточка CRM это имя не перебивает.
    await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `+${TJ_PHONE}`, trust: "TRANSPORT" }],
      name: "Далер (брат Умеда, звонить после 18)",
      nameSource: "crm",
    });
    const after = await contactProfileForPrompt(profile!.profileId, emptyDraft);
    expect(after!.selfName).toBe("Далер");
  });

  it("карточка в Корзине из промта исчезает, а досье остаётся жить", async () => {
    const profile = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `+${TJ_PHONE}`, trust: "TRANSPORT" }],
    });
    const client = await prisma.client.create({
      data: { fullName: `Корзина досье ${digits6}`, phone: `+${TJ_PHONE}`, source: "PHONE_CALL" },
      select: { id: true },
    });
    clientId = client.id;
    await prisma.contactProfile.update({ where: { id: profile!.profileId }, data: { clientId } });

    const живая = await contactProfileForPrompt(profile!.profileId, emptyDraft);
    expect(живая!.crm).toBeTruthy();

    await prisma.client.update({ where: { id: clientId }, data: { deletedAt: new Date() } });
    const удалённая = await contactProfileForPrompt(profile!.profileId, emptyDraft);
    // Строка «в CRM» ушла — но само досье на месте: переписка и факты никуда не делись.
    expect(удалённая).not.toBeNull();
    expect(удалённая!.crm).toBeNull();
  });
});

describe("непонятое досье фактов не затирается", () => {
  it("readContactFacts отличает пустое поле от битого", () => {
    expect(readContactFacts(null).recognized).toBe(true);
    expect(readContactFacts({}).recognized).toBe(true);
    expect(readContactFacts({ version: 1, buyer: {}, seller: {}, job: {}, misc: {} }).recognized).toBe(true);
    // Будущая версия формата — понять её мы не можем, но и стереть не вправе.
    expect(readContactFacts({ version: 7, что: "то новое" }).recognized).toBe(false);
  });

  it("запись поверх непонятого поля не проходит", async () => {
    const profile = await resolveContactProfile({
      identities: [{ kind: "PHONE", value: `+${UZ_PHONE}`, trust: "TRANSPORT" }],
    });
    const накопленное = { version: 7, buyer: { budgetMax: { v: 90000, at: "2026-09-01T00:00:00.000Z", src: "agent" } } };
    await prisma.contactProfile.update({
      where: { id: profile!.profileId },
      data: { facts: накопленное as object },
    });

    await recordContactFacts({
      profileId: profile!.profileId,
      domain: "buyer",
      values: { districtName: "Сино" },
      source: "model",
    });

    const after = await prisma.contactProfile.findUnique({
      where: { id: profile!.profileId },
      select: { facts: true },
    });
    // Поле осталось как было: новый факт не записан, старые не потеряны.
    expect(after!.facts).toEqual(накопленное);
    // А читается оно по-прежнему пустым — бот не падает, он просто не помнит.
    expect(Object.keys(parseContactFacts(after!.facts).buyer)).toHaveLength(0);
  });
});
