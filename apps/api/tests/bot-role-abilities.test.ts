import { describe, expect, it } from "vitest";
import { abilitiesForIntent } from "../src/ai/roleAbilities.js";
import type { BotAbilities, LeadIntent, ShowcaseAbility } from "../src/ai/leadQualifier.js";

/**
 * ПРАВА БОТА ПО РОЛИ СОБЕСЕДНИКА.
 *
 * Проверяется ровно то, чем эта функция опасна:
 *
 *  1. она НИКОГДА не включает то, что владелец выключил в Настройках — иначе
 *     роль станет вторым местом, где решается, что боту можно;
 *  2. при выключенном тумблере вход возвращается как есть — тумблер обязан
 *     означать «как было», иначе его нельзя вернуть обратно;
 *  3. пока направление не известно, права не снимаются: снять их у покупателя,
 *     которого просто не успели распознать, дороже лишнего умения у того, кто
 *     им не воспользуется;
 *  4. собственнику и кандидату действительно не достаётся подборка квартир.
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

const SHOWCASE: ShowcaseAbility = {
  canSendPhotos: true,
  alreadyShownShortIds: [],
  photosPerOffer: 3,
  canSendGuide: true,
};

const INTENTS: (LeadIntent | undefined)[] = ["buy", "sell", "rent", "job", "other", undefined];

describe("права бота по роли разговора", () => {
  it("тумблер выключен — права ровно те, что пришли", () => {
    for (const intent of INTENTS) {
      const out = abilitiesForIntent(ALL_ON, SHOWCASE, intent, false);
      expect(out.abilities).toEqual(ALL_ON);
      expect(out.showcase).toEqual(SHOWCASE);
    }
  });

  it("выключенное в Настройках роль включить не может — только сужение", () => {
    const allOff: BotAbilities = {
      showings: false,
      callback: false,
      askOwner: false,
      vacancies: false,
      links: false,
      cautious: false,
      promptEconomy: true,
    };
    const noPhotos: ShowcaseAbility = { ...SHOWCASE, canSendPhotos: false };
    for (const intent of INTENTS) {
      const out = abilitiesForIntent(allOff, noPhotos, intent, true);
      for (const key of Object.keys(allOff) as (keyof BotAbilities)[]) {
        expect(out.abilities[key]).toBe(allOff[key]);
      }
      expect(out.showcase.canSendPhotos).toBe(false);
    }
  });

  it("направление ещё не известно — прав не снимаем", () => {
    for (const intent of [undefined, "other"] as const) {
      const out = abilitiesForIntent(ALL_ON, SHOWCASE, intent, true);
      expect(out.abilities).toEqual(ALL_ON);
      expect(out.showcase.canSendPhotos).toBe(true);
    }
  });

  it("собственнику не уходят ни подборка квартир, ни назначение показа", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, "sell", true);
    expect(out.abilities.links).toBe(false);
    expect(out.abilities.showings).toBe(false);
    expect(out.showcase.canSendPhotos).toBe(false);
    // Приём объекта у собственника без «уточню у хозяина» не работает: хозяин
    // здесь он сам. Право остаётся.
    expect(out.abilities.askOwner).toBe(true);
    expect(out.abilities.callback).toBe(true);
  });

  it("кандидату на вакансию квартиры не показывают, но живого человека он позвать может", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, "job", true);
    expect(out.abilities.links).toBe(false);
    expect(out.abilities.showings).toBe(false);
    expect(out.showcase.canSendPhotos).toBe(false);
    expect(out.abilities.vacancies).toBe(true);
    // «Соедините с человеком» — законная просьба и от кандидата тоже.
    expect(out.abilities.callback).toBe(true);
  });

  it("аренде не остаётся ничего, кроме обратного звонка: разговор кончается отказом", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, "rent", true);
    expect(out.abilities.links).toBe(false);
    expect(out.abilities.showings).toBe(false);
    expect(out.abilities.askOwner).toBe(false);
    expect(out.abilities.vacancies).toBe(false);
    expect(out.showcase.canSendPhotos).toBe(false);
  });

  it("покупателю не снимается ничего — ради него всё и работает", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, "buy", true);
    expect(out.abilities).toEqual(ALL_ON);
    expect(out.showcase).toEqual(SHOWCASE);
  });
});

/**
 * ТЕ, У КОГО НАМЕРЕНИЯ НЕ БУДЕТ НИКОГДА.
 *
 * Рекламный агент, поставщик и застройщик не покупают и не продают жильё:
 * `intent` у них навсегда `"other"`, и таблица по намерению про них не знает
 * ничего. Проверяется то, из-за чего это стало отдельной таблицей: им
 * действительно снимаются умения, но не право позвать человека, и одна метка не
 * пересиливает намерение — иначе покупатель, разок помеченный рекламщиком,
 * оказался бы выпровожен из переписки.
 */
describe("права бота, когда собеседник вообще не клиент", () => {
  it("рекламщику и поставщику не уходит ни подборка, ни показ, ни фотографии", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, "other", true, "VENDOR");
    expect(out.abilities.links).toBe(false);
    expect(out.abilities.showings).toBe(false);
    expect(out.abilities.askOwner).toBe(false);
    expect(out.abilities.vacancies).toBe(false);
    expect(out.showcase.canSendPhotos).toBe(false);
    // Просьбу «соедините с руководством» обязан донести до CRM и он.
    expect(out.abilities.callback).toBe(true);
  });

  it("застройщику — то же: объекты в работу принимает руководство, а не бот", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, undefined, true, "PARTNER");
    expect(out.abilities.links).toBe(false);
    expect(out.abilities.showings).toBe(false);
    expect(out.showcase.canSendPhotos).toBe(false);
    expect(out.abilities.callback).toBe(true);
  });

  it("намерение старше метки: помеченный рекламщиком покупатель остаётся покупателем", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, "buy", true, "VENDOR");
    expect(out.abilities).toEqual(ALL_ON);
    expect(out.showcase).toEqual(SHOWCASE);
  });

  it("метки, у которых свой сценарий не предусмотрен, прав не снимают", () => {
    // UNKNOWN — «модель не поняла», и это ровно тот случай, где снимать права
    // дороже всего. CLIENT_CARE, JOB и OTHER ведёт намерение либо интейк.
    for (const who of ["UNKNOWN", "CLIENT_CARE", "OTHER", "BUYER", "SELLER", "JOB"] as const) {
      const out = abilitiesForIntent(ALL_ON, SHOWCASE, "other", true, who);
      expect(out.abilities).toEqual(ALL_ON);
      expect(out.showcase).toEqual(SHOWCASE);
    }
  });

  it("тумблер выключен — метка не снимает ничего", () => {
    const out = abilitiesForIntent(ALL_ON, SHOWCASE, "other", false, "VENDOR");
    expect(out.abilities).toEqual(ALL_ON);
    expect(out.showcase).toEqual(SHOWCASE);
  });

  it("выключенное в Настройках метка не включает", () => {
    const allOff: BotAbilities = { ...ALL_ON, showings: false, links: false, askOwner: false, vacancies: false };
    const out = abilitiesForIntent(allOff, { ...SHOWCASE, canSendPhotos: false }, "other", true, "VENDOR");
    expect(out.abilities).toEqual(allOff);
    expect(out.showcase.canSendPhotos).toBe(false);
  });
});
