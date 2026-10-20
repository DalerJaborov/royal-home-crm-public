/**
 * Живые диалоги 25.09.2026 (выдержки владельца): «ок/рахмат», пачка фото,
 * найм агентов не кандидату, первый вопрос с рекламы, ролик за роликом,
 * язык после короткого «Ок». Чистые функции, база не нужна.
 */
import { describe, expect, it } from "vitest";
import { botAskedQuestion, isAckOnlyMessage } from "../src/ai/ackOnly.js";
import { isPhotoAck, isPhotoOnlyTurn, photoAlreadyAcknowledged, PHOTO_ACK_WINDOW_MS } from "../src/ai/photoAckGuard.js";
import { mentionsRecruiting, stripRecruiting } from "../src/ai/recruitingGuard.js";
import { clientMeansHousingDeal } from "../src/ai/housingIntent.js";
import { bareSharesAnsweredInRow, isBareShare, shouldStaySilentOnBareShare } from "../src/ai/bareShareRepeat.js";
import { lastClientLanguage } from "../src/ai/leadQualifier.js";
import { neutralOpenerHint } from "../src/ai/adTemplateOpener.js";

describe("«ок/рахмат» — только реакция", () => {
  it.each(["Ок", "ок", "Ok", "Рахмат", "Добро брат", "Боз ҳам қаблан сипосгузорам аз шумо", "Қаблан сипосгузорам", "Хоп", "👍", "Спасибо большое!", "Хоб"])(
    "%s — вежливость",
    (t) => expect(isAckOnlyMessage(t)).toBe(true)
  );
  it.each([
    "Ок, а сколько стоит?",
    "Ок 910001033",
    "Оиди иваз имкониятҳо ҳаст?",
    "Но гуфта намонад боз муомила дорад.",
    "Хонаи фуруши дорем",
    "Мехроч",
    "",
    "Салом",
  ])("%s — не вежливость", (t) => expect(isAckOnlyMessage(t)).toBe(false));

  it("после вопроса бота «ок» — ответ, а не прощание", () => {
    expect(botAskedQuestion("Хотите посмотреть квартиру?")).toBe(true);
    expect(botAskedQuestion("Ташаккур, Ҳофиз! Дархости шуморо ба агент додем, ба зудӣ тамос мегирад")).toBe(false);
  });
});

describe("язык не теряется на коротком «Ок»", () => {
  it("русский разговор + «Ок» → ru", () => {
    expect(
      lastClientLanguage([
        { role: "user", content: "Хочу купить квартиру" },
        { role: "assistant", content: "В каком районе?" },
        { role: "user", content: "У меня наличных нету" },
        { role: "assistant", content: "Понимаю Вас." },
        { role: "user", content: "Ок" },
      ])
    ).toBe("ru");
  });
});

describe("пачка фото — одно «спасибо»", () => {
  const now = Date.parse("2026-09-25T08:53:30Z");
  const ack = { content: "Раҳмат, аксҳоро гирифтем! Агенти мо ба зудӣ бо шумо тамос мегирад", at: "2026-09-25T08:53:00Z" };
  it("распознаёт «фото получили» разными словами", () => {
    for (const t of [
      "Раҳмат, суратҳоро қабул кардем!",
      "Расмҳоро гирифтам, раҳмат",
      "Раҳмат, акс омад.",
      "Спасибо, фото получили",
    ])
      expect(isPhotoAck(t)).toBe(true);
    expect(isPhotoAck("Агенти мо ба зудӣ занг мезанад")).toBe(false);
  });
  it("вторая пачка без слов — молчим", () => {
    expect(isPhotoOnlyTurn("[📷]\n[📷]\n[📷]")).toBe(true);
    expect(photoAlreadyAcknowledged("[📷]\n[📷]", ack, now)).toBe(true);
  });
  it("с подписью или спустя время — отвечаем", () => {
    expect(photoAlreadyAcknowledged("[📷]\n145 кв", ack, now)).toBe(false);
    expect(photoAlreadyAcknowledged("[📷]", ack, Date.parse(ack.at) + PHOTO_ACK_WINDOW_MS + 1)).toBe(false);
    expect(photoAlreadyAcknowledged("[📷]", { content: "Хона чанд квадрат аст?", at: ack.at }, now)).toBe(false);
  });
});

describe("про найм — только кандидату", () => {
  it("вычёркивает хвост про найм, оставляет суть", () => {
    const { bubbles, stripped } = stripRecruiting(
      ["Рекламаи мо барои соҳибони хона ройгон аст. Мо инчунин ба дастаи худ агентони фурӯшро қабул мекунем. Оё резюме ё маълумот дар бораи таҷрибаи кориатон доред?"],
      "tg"
    );
    expect(bubbles).toEqual(["Рекламаи мо барои соҳибони хона ройгон аст."]);
    expect(stripped).toBe(2);
  });
  it("отдельная просьба номера «для заявки на работу» уходит, вместо тишины — «чем помочь»", () => {
    expect(stripRecruiting(["Барои қабули дархости кор рақами телефони худро бинависед"], "tg").bubbles).toEqual([
      "Чӣ хизмат карда метавонам?",
    ]);
  });
  it("«квартира или работа?» — тоже найм", () => {
    expect(mentionsRecruiting("Подскажите, ищете квартиру или Вас интересует работа?")).toBe(true);
  });
  it("«агент позвонит» — не найм", () => {
    expect(mentionsRecruiting("Агенти мо ба зудӣ бо шумо тамос мегирад")).toBe(false);
    expect(mentionsRecruiting("Рақами телефон ва номатонро нависед, то агенти мо занг занад")).toBe(false);
  });
});

describe("хозяйка о своём доме — не кандидат", () => {
  it.each(["Шумо хона реклама мекунед", "Шумо хона реклама", "Ду сотих хона дар калхоз рассяа", "65кв", "2 хонага", "Хона дорам"])(
    "%s — разговор о жилье",
    (t) => expect(clientMeansHousingDeal(t)).toBe(true)
  );
  it("рассказ кандидата о себе — по-прежнему не жильё", () => {
    expect(clientMeansHousingDeal("дар фурӯши хона таҷриба дорам")).toBe(false);
    expect(clientMeansHousingDeal("Ман 22 сола, кор мекунам")).toBe(false);
  });
});

describe("первый вопрос с рекламы — «чем могу помочь»", () => {
  it("без вакансии и на двух языках", () => {
    const hint = neutralOpenerHint();
    expect(hint).toContain("Чем могу помочь");
    expect(hint).toContain("Чӣ хизмат карда метавонам");
    expect(hint).not.toMatch(/реклама и квартир, и вакансии/);
  });
});

describe("ролик за роликом без слов", () => {
  const share = "[вложение: ig_reel]";
  it("третья пересылка подряд — молчим", () => {
    const h = [
      { role: "user" as const, content: share },
      { role: "assistant" as const, content: "Маълумоти хонаатонро ба агент додем" },
      { role: "user" as const, content: share },
      { role: "assistant" as const, content: "Агенти мо ба зудӣ занг мезанад" },
    ];
    expect(isBareShare(share)).toBe(true);
    expect(bareSharesAnsweredInRow(h)).toBe(2);
    expect(shouldStaySilentOnBareShare(share, h)).toBe(true);
  });
  it("слова между пересылками обнуляют счёт", () => {
    const h = [
      { role: "user" as const, content: share },
      { role: "assistant" as const, content: "…" },
      { role: "user" as const, content: "Ин хона чанд пул?" },
      { role: "assistant" as const, content: "…" },
      { role: "user" as const, content: share },
      { role: "assistant" as const, content: "…" },
    ];
    expect(shouldStaySilentOnBareShare(share, h)).toBe(false);
    expect(isBareShare("[вложение: ig_reel] ин хона чанд пул")).toBe(false);
  });
});
