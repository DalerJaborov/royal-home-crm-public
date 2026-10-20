import { describe, expect, it } from "vitest";
import {
  asksKnownSellerFact,
  collectSellerFacts,
  extractSellerFacts,
  missingSellerFacts,
  SELLER_INTAKE_RULES,
  sellerIntakeBlock,
} from "../src/ai/sellerIntake.js";
import {
  alreadyApologizedForMedia,
  mediaApologyDirective,
  stripRepeatedMediaApology,
} from "../src/ai/mediaApology.js";
import type { ChatMessage } from "../src/ai/client.js";

/**
 * ПРИЁМ ОБЪЕКТА У ПРОДАВЦА — ОДНИМ ВОПРОСОМ (жалоба владельца 18.08.2026).
 *
 * Проверяется не «есть ли в промте красивая фраза», а то, что нельзя выполнить
 * наполовину: код сам считает названное и сам снимает вопрос про уже названное.
 * Живой материал теста — переписка @suhroboqilov0 от 18.08.2026, где бот тянул из
 * продавца по одному параметру за реплику и дважды повторил «видео не открылось».
 */
describe("продавец: всё спрашивается одним сообщением", () => {
  it("недостающее перечисляется одним списком, а не по одному параметру", () => {
    const block = sellerIntakeBlock({});
    // Ровно одна просьба, и в ней все шесть пунктов сразу.
    expect(block).toContain("ОДНИМ сообщением, всё сразу");
    for (const part of ["количество комнат", "площадь", "район или ориентир", "этаж", "состояние", "цена"]) {
      expect(block).toContain(part);
    }
    expect(missingSellerFacts({})).toHaveLength(6);
  });

  it("правило приёма отменяет общее «один вопрос за раз» только для продавца", () => {
    expect(SELLER_INTAKE_RULES).toContain("СИЛЬНЕЕ ОБЩЕГО «ОДИН ВОПРОС ЗА РАЗ»");
    expect(SELLER_INTAKE_RULES).toContain("ТОЛЬКО с продавцом");
    expect(SELLER_INTAKE_RULES).toContain("С покупателем всё по-прежнему");
  });

  it("названо всё — про объект больше не спрашиваем вовсе", () => {
    const facts = collectSellerFacts([
      { role: "user", content: "2-хонага, 360 квадрат, дар тарафи политехникум, 5 етаж, бо ремонт, 3200000 сомони" },
    ]);
    expect(missingSellerFacts(facts)).toHaveLength(0);
    expect(sellerIntakeBlock(facts)).toContain("НАЗВАНО ВСЁ");
  });
});

describe("уже названное не переспрашивается", () => {
  it("реплика клиента «2 етаж 8 дар хона / 360 квадрат» закрывает этаж и площадь", () => {
    const facts = extractSellerFacts("2 етаж 8 дар хона\n360 квадрат");
    expect(facts.floor).toBe(true);
    expect(facts.area).toBe(true);
    // Цену голое число не закрывает: без валюты «360» ценой не является.
    expect(facts.price).toBeUndefined();
  });

  it("считаются только слова клиента, вопросы бота ответом не являются", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "Хона чандҳуҷрагӣ аст? Нархаш чанд?" },
      { role: "user", content: "360 квадрат" },
    ];
    const facts = collectSellerFacts(history);
    expect(facts.area).toBe(true);
    expect(facts.rooms).toBeUndefined();
    expect(facts.price).toBeUndefined();
  });

  it("ориентир засчитывается как район: «Дар тарафи политехникум»", () => {
    expect(extractSellerFacts("Дар тарафи политехникум").district).toBe(true);
  });

  it("вопрос про уже названный параметр снимается кодом", () => {
    const facts = extractSellerFacts("360 квадрат, 2 етаж, бо ремонт");
    expect(asksKnownSellerFact("Хона чанд метр аст?", facts)).toBe("area");
    expect(asksKnownSellerFact("Кадом ошёна?", facts)).toBe("floor");
    expect(asksKnownSellerFact("Хона бо ремонт аст ё каробка?", facts)).toBe("condition");
    // Недостающее спрашивать по-прежнему можно — иначе бот замолчал бы совсем.
    expect(asksKnownSellerFact("Нархашро чанд дар назар доред?", facts)).toBeNull();
  });

  it("в блок промта уже названное попадает как прямой запрет", () => {
    const block = sellerIntakeBlock(extractSellerFacts("360 квадрат, 2 етаж"));
    expect(block).toContain("переспрашивать ЗАПРЕЩЕНО");
    expect(block).toContain("площадь");
    expect(block).toContain("этаж");
  });
});

describe("«не могу открыть видео» говорится один раз", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "https://www.instagram.com/reel/DcJJgsTIB56/" },
    { role: "assistant", content: "Мутаассифона, видео кушода нашуд. Хона чандҳуҷрагӣ аст?" },
    { role: "user", content: "Видео кушода шид йо не" },
  ];

  it("повтор извинения вырезается, полезный вопрос остаётся", () => {
    expect(alreadyApologizedForMedia(history)).toBe(true);
    const cleaned = stripRepeatedMediaApology(
      ["Мутаассифона, ин пайванд ҳам кушода намешавад. Нархашро чанд дар назар доред?"],
      history
    );
    expect(cleaned).toEqual(["Нархашро чанд дар назар доред?"]);
  });

  it("если кроме извинения ничего не было — молчать нельзя, оставляем как есть", () => {
    const bubbles = ["Мутаассифона, видео кушода нашуд."];
    expect(stripRepeatedMediaApology(bubbles, history)).toEqual(bubbles);
  });

  it("предписание требует ответить на прямой вопрос и на подсказку про другой источник", () => {
    const directive = mediaApologyDirective(history);
    expect(directive).toContain("ПОВТОРЯТЬ ЭТУ ФРАЗУ ЗАПРЕЩЕНО");
    expect(directive).toContain("другой источник");
    expect(directive).toContain("ОДНИМ сообщением");
  });

  it("первого извинения ещё не было — промт не меняется ни на байт", () => {
    const fresh: ChatMessage[] = [{ role: "user", content: "Салом" }];
    expect(mediaApologyDirective(fresh)).toBe("");
    expect(stripRepeatedMediaApology(["Салом! Чӣ хизмат?"], fresh)).toEqual(["Салом! Чӣ хизмат?"]);
  });
});
