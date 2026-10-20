import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryFromWhoIsThis } from "@royal-home/shared";
import { prisma } from "../src/db.js";
import { mergeDraft, NON_CLIENT_SCENARIOS, qualifySchema, resolveEffectiveWhoIsThis } from "../src/ai/leadQualifier.js";
import { isNonClientRole } from "../src/ai/roleAbilities.js";
import { WHO_IS_THIS } from "../src/ai/botContract.js";
import type { BotAbilities, LeadDraft, QualifyResult } from "../src/ai/leadQualifier.js";
import type { ContactProfileForPrompt } from "../src/ai/contactProfileBlock.js";
import { attachContactProfile } from "../src/lib/contactProfiles.js";
import { rememberContactTurn } from "../src/lib/contactProfileMemory.js";

/**
 * «КТО ПИШЕТ» — метка для тех, у кого намерения не будет никогда.
 *
 * Рекламный агент, поставщик и застройщик не покупают и не продают жильё:
 * `intent` у них навсегда `"other"`, и до этой метки код не отличал их ни друг
 * от друга, ни от покупателя, которого просто не успели распознать. Живой итог
 * владелец видел сам: бот по третьему разу спрашивал у рекламщика, что тот
 * хочет купить, и заводил ему досье «Пока не понятно».
 *
 * Проверяется ровно то, чем метка опасна:
 *
 *  1. поля нет в схеме при выключенном тумблере — иначе «выключено» перестанет
 *     означать «как было»;
 *  2. метка держится между ходами (модель легко промолчит о ней в следующем
 *     ответе), но НЕ пересиливает намерение: покупатель, разок помеченный
 *     рекламщиком, иначе был бы выпровожен из переписки навсегда;
 *  3. `UNKNOWN` в досье не пишется — это «модель не поняла», и записывать его
 *     значило бы стирать категорию, поставленную раньше или руками агента;
 *  4. рекламщик получает в досье «Предлагает услуги», а не «Пока не понятно».
 */

const ALL_ON: BotAbilities = {
  showings: true,
  callback: true,
  askOwner: true,
  vacancies: true,
  links: true,
  cautious: false,
  promptEconomy: true,
};

const SHOWCASE = { canSendPhotos: false, alreadyShownShortIds: [], photosPerOffer: 3, canSendGuide: false };

const result = (over: Partial<QualifyResult> = {}): QualifyResult => ({ reply: ["ок"], ready: false, ...over });

describe("поле «кто пишет» в схеме ответа модели", () => {
  it("тумблер выключен — поля нет вовсе", () => {
    const off = qualifySchema(false, false, { ...ALL_ON, promptEconomy: false }, false);
    expect(off.properties).not.toHaveProperty("whoIsThis");
    // Направление разговора при этом на месте: тумблер про роли, а не про intent.
    expect(off.properties).toHaveProperty("intent");
  });

  it("тумблер включён — поле есть, и в нём нет SPAM", () => {
    const on = qualifySchema(false, false, ALL_ON, false);
    const field = (on.properties as Record<string, { enum?: string[] }>).whoIsThis;
    expect(field).toBeDefined();
    expect(field.enum).toContain("VENDOR");
    expect(field.enum).toContain("PARTNER");
    // Спам ловится кодом до вызова модели. Спросить у неё «это спам?» значило бы
    // дать ей повод замолчать в ответ живому человеку.
    expect(field.enum).not.toContain("SPAM");
  });
});

describe("метка живёт дольше одного хода, но намерение старше", () => {
  const base: LeadDraft = { stage: "chatting" };

  it("модель промолчала о метке — прежняя остаётся", () => {
    const first = mergeDraft(base, result({ whoIsThis: "VENDOR", intent: "other" }));
    expect(first.whoIsThis).toBe("VENDOR");
    const second = mergeDraft(first, result({ intent: "other" }));
    expect(second.whoIsThis).toBe("VENDOR");
  });

  it("модель назвала другую — берётся ответ этого хода", () => {
    const first = mergeDraft(base, result({ whoIsThis: "VENDOR" }));
    const second = mergeDraft(first, result({ whoIsThis: "PARTNER" }));
    expect(second.whoIsThis).toBe("PARTNER");
  });

  it("метка не отменяет намерения: помеченный рекламщиком покупатель остался покупателем", () => {
    const draft = mergeDraft(base, result({ whoIsThis: "VENDOR", intent: "buy" }));
    expect(draft.intent).toBe("buy");
    expect(draft.whoIsThis).toBe("VENDOR");
  });
});

/**
 * ОДИН СПИСОК «КТО НЕ КЛИЕНТ», А НЕ ДВА.
 *
 * Роль решает три вещи в трёх разных местах: какой сценарий подать (промт),
 * какие умения снять (права) и собирать ли подборку объектов (она строится
 * раньше прав и своим условием). Разъедься эти списки — и разъезд будет тихим:
 * бот перестанет предлагать показ, но продолжит присылать подборку квартир
 * человеку, которому тем же промтом запрещено предлагать жильё.
 */
describe("сценарии и права знают одних и тех же «не клиентов»", () => {
  it("списки совпадают ключ в ключ", () => {
    const withScenario = Object.keys(NON_CLIENT_SCENARIOS).sort();
    const withNarrowedRights = WHO_IS_THIS.filter((who) => isNonClientRole(who)).sort();
    expect(withScenario).toEqual(withNarrowedRights);
    // Список не пустой — иначе тест «совпадают» проходил бы на двух пустых.
    expect(withScenario.length).toBeGreaterThan(0);
  });

  it("покупатель, продавец, кандидат и «не понял» — клиенты, прав им не снимают", () => {
    for (const who of ["BUYER", "SELLER", "JOB", "CLIENT_CARE", "OTHER", "UNKNOWN"] as const) {
      expect(isNonClientRole(who)).toBe(false);
    }
    expect(isNonClientRole(undefined)).toBe(false);
  });
});

/**
 * §10.4 плана от 20.09.2026: досье подсказывает роль ПЕРВОМУ ходу нового
 * разговора, чтобы не проходить интейк заново с рекламщиком, писавшим месяц
 * назад. Профиль здесь — не полноценное досье, только то, что читает эта
 * функция: категория.
 */
const profile = (category: ContactProfileForPrompt["category"]): ContactProfileForPrompt => ({
  category,
  previousCategories: [],
  selfName: null,
  language: null,
  history: null,
  buyer: [],
  seller: [],
  job: [],
  crm: null,
});

describe("досье подсказывает роль, пока разговор ещё ничего не сказал (§10.4)", () => {
  it("новый разговор, досье помнит рекламщика — подсказка встаёт сразу", () => {
    expect(resolveEffectiveWhoIsThis({ whoIsThis: undefined }, profile("VENDOR"), true)).toBe("VENDOR");
  });

  it("тумблер выключен — подсказки нет вовсе, даже если досье её знает", () => {
    expect(resolveEffectiveWhoIsThis({ whoIsThis: undefined }, profile("VENDOR"), false)).toBeUndefined();
  });

  it("разговор уже классифицировал сам — метка этого хода побеждает, досье не спрашивается", () => {
    expect(resolveEffectiveWhoIsThis({ whoIsThis: "PARTNER" }, profile("VENDOR"), true)).toBe("PARTNER");
  });

  it("покупатель и продавец из досье не подставляются — рента от покупки так не отличить", () => {
    expect(resolveEffectiveWhoIsThis({ whoIsThis: undefined }, profile("BUYER"), true)).toBeUndefined();
    expect(resolveEffectiveWhoIsThis({ whoIsThis: undefined }, profile("SELLER"), true)).toBeUndefined();
  });

  it("«пока не понятно» и без досье — подсказки нет, интейк как обычно", () => {
    expect(resolveEffectiveWhoIsThis({ whoIsThis: undefined }, profile("UNKNOWN"), true)).toBeUndefined();
    expect(resolveEffectiveWhoIsThis({ whoIsThis: undefined }, null, true)).toBeUndefined();
    expect(resolveEffectiveWhoIsThis({ whoIsThis: undefined }, undefined, true)).toBeUndefined();
  });
});

describe("перевод метки в категорию досье", () => {
  it("«не понял» категорией не становится", () => {
    expect(categoryFromWhoIsThis("UNKNOWN")).toBeNull();
    expect(categoryFromWhoIsThis("ЧТО-ТО НОВОЕ")).toBeNull();
  });

  it("коды совпадают с категориями досье — перевод один к одному", () => {
    expect(categoryFromWhoIsThis("VENDOR")).toBe("VENDOR");
    expect(categoryFromWhoIsThis("PARTNER")).toBe("PARTNER");
  });
});

const runId = String(Date.now()).slice(-6);
const WA_ID = `992919${runId.slice(0, 3)}`;
const CONVERSATION_ID = `who-is-this-${runId}`;

async function cleanup(): Promise<void> {
  const rows = await prisma.contactIdentity.findMany({
    where: { value: WA_ID },
    select: { profileId: true },
  });
  const ids = rows.map((r) => r.profileId);
  if (ids.length === 0) return;
  await prisma.contactIdentity.deleteMany({ where: { profileId: { in: ids } } });
  await prisma.contactProfile.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(cleanup);
afterAll(cleanup);

describe("рекламщик в досье", () => {
  it("получает «Предлагает услуги», а не «Пока не понятно»", async () => {
    const profileId = await attachContactProfile({
      identities: [{ kind: "WA_ID", value: WA_ID, trust: "TRANSPORT" }],
      // Привязывать досье к диалогу этому тесту не нужно: он про категорию.
      link: async () => {},
    });
    expect(profileId).toBeTruthy();

    // Ровно то, что кладёт канал после хода модели: намерения нет, метка есть.
    await rememberContactTurn({
      profileId,
      conversationId: CONVERSATION_ID,
      draft: { stage: "chatting", intent: "other", whoIsThis: "VENDOR", confident: true },
    });

    const profile = await prisma.contactProfile.findUnique({
      where: { id: profileId! },
      select: { category: true },
    });
    expect(profile?.category).toBe("VENDOR");
  });
});
