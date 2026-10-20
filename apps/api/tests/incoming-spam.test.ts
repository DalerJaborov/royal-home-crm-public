import { describe, expect, it } from "vitest";
import { detectSpam, sharedPostSpamContext } from "../src/lib/incomingSpam.js";

/**
 * Отсечка рассылок до вызова ИИ.
 *
 * Половина этих тестов стережёт НЕ срабатывание: ложно принятый за спам клиент не
 * получает ответа вовсе и уходит молча — мы даже не узнаем, что его потеряли.
 * Поэтому «не спам» здесь важнее, чем «спам».
 */

describe("Что отсекаем", () => {
  it("приглашение в телеграм-канал — одного признака достаточно", () => {
    expect(detectSpam("Заходи к нам https://t.me/+AbCdEf12345")).not.toBeNull();
  });

  it("приглашение в группу WhatsApp", () => {
    expect(detectSpam("Присоединяйся https://chat.whatsapp.com/XYZ")).not.toBeNull();
  });

  it("сокращённая ссылка от незнакомого человека", () => {
    expect(detectSpam("Смотри тут bit.ly/2abcd")).not.toBeNull();
  });

  it("два слова чужого бизнеса — без всякой ссылки", () => {
    expect(detectSpam("Обучаем трейдингу, заработок от 500$ в день")).not.toBeNull();
  });

  it("одно слово плюс ссылка", () => {
    expect(detectSpam("Крипта для всех, подробности https://example.com/course")).not.toBeNull();
  });

  it("длинная простыня со ссылкой и без единого вопроса", () => {
    const blast = `${"Предлагаем услуги по продвижению. ".repeat(50)} https://example.com`;
    expect(detectSpam(blast)).not.toBeNull();
  });
});

describe("Кого не трогаем НИ ПРИ КАКИХ УСЛОВИЯХ", () => {
  /**
   * Эти слова — обычный разговор о недвижимости. «Можно в рассрочку?» — самый
   * желанный вопрос из всех, и молчание в ответ на него означает потерянную сделку.
   */
  it("рассрочка, ипотека, кредит, инвестиции — не спам", () => {
    expect(detectSpam("Здравствуйте, а в рассрочку можно купить?")).toBeNull();
    expect(detectSpam("Вы работаете с ипотекой?")).toBeNull();
    expect(detectSpam("Хочу вложить деньги в недвижимость, что посоветуете?")).toBeNull();
    expect(detectSpam("Какой доход даёт сдача такой квартиры?")).toBeNull();
  });

  it("одно подозрительное слово без ссылки — не спам", () => {
    // Заплатить криптой в Душанбе предлагают редко, но предлагают.
    expect(detectSpam("А криптой можно оплатить?")).toBeNull();
  });

  it("обычная ссылка без рекламных слов — не спам", () => {
    expect(detectSpam("Вот эта квартира https://royalhome.tj/listing/42 ещё свободна?")).toBeNull();
    expect(detectSpam("Нашёл на somon.tj объявление https://somon.tj/adv/123, у вас есть похожее?")).toBeNull();
  });

  it("длинный рассказ о своей квартире с вопросом — не спам", () => {
    const long = `${"Продаю трёхкомнатную в Сино, ремонт свежий, окна во двор. ".repeat(30)} Сколько будет стоить?`;
    expect(detectSpam(`${long} https://royalhome.tj`)).toBeNull();
  });

  it("пустое сообщение (пришло одно фото) — не спам", () => {
    expect(detectSpam("")).toBeNull();
    expect(detectSpam("   ")).toBeNull();
  });

  it("таджикское приветствие — не спам", () => {
    expect(detectSpam("Салом, хонаи 2 хона доред?")).toBeNull();
  });
});

/**
 * НАКРУТКА ЛАЙКОВ И ПРОСМОТРОВ (замечание владельца 16.08.2026).
 *
 * Присылают в директ чужой ролик и просят лайкнуть или посмотреть. Бот отвечал им
 * как клиентам и однажды спросил, сколько комнат в квартире на музыкальном видео.
 */
describe("накрутка лайков", () => {
  it("чужой ролик с просьбой про лайк — рассылка", () => {
    expect(detectSpam("Салом, лайк монед лутфан", { sharedPost: true })?.reason).toContain("накрутка");
    expect(detectSpam("like plz", { sharedPost: true })?.reason).toContain("накрутка");
  });

  it("НАША публикация с теми же словами — не спам: это живой клиент", () => {
    // Человек пишет «видел ваш пост, лайк поставил» — самый тёплый вход из всех.
    expect(detectSpam("лайк зада будам, ин хона ҳаст?", { sharedPost: true, ourPost: true })).toBeNull();
  });

  it("чужой ролик БЕЗ просьбы — не спам: так присылают чужие объявления", () => {
    expect(detectSpam("", { sharedPost: true })).toBeNull();
    expect(detectSpam("Ин хона чанд пул?", { sharedPost: true })).toBeNull();
    expect(detectSpam("такое есть у вас?", { sharedPost: true })).toBeNull();
  });

  it("две просьбы про подписку без вложения — тоже рассылка", () => {
    expect(detectSpam("подпишись на меня, взаимно лайк")?.reason).toContain("лайк");
  });

  it("обычный разговор о квартире не задет", () => {
    expect(detectSpam("Хонаро дидан мехоҳам, кай мумкин?")).toBeNull();
    expect(detectSpam("Сколько просмотров квартиры было?")).toBeNull();
  });
});

/**
 * ПРИХОД С РЕКЛАМЫ БОЛЬШЕ НЕ ОСВОБОЖДАЕТ ОТ ПРОВЕРКИ НА НАКРУТКУ
 * (жалоба владельца 21.09.2026: «на спам отвечает, когда по рекламе нам
 * отправляют своё видео»).
 *
 * Решение «пересланное чужое или наше» жило строчкой в разборе вебхука, и в ней
 * была дыра: ЛЮБОЙ приход с рекламы выключал проверку целиком. А реклама — это
 * ровно то, как нас находят рассылки: спамер кликает объявление и присылает свой
 * ролик с «подпишись, поставь лайк».
 */
describe("sharedPostSpamContext — чужое пересланное или наше", () => {
  it("публикация опознана в нашей ленте — это наш горячий клиент", () => {
    const ctx = sharedPostSpamContext({
      sharedPost: true,
      ownMedia: true,
      adProperty: false,
      vacancyPost: false,
    });
    expect(ctx).toEqual({ sharedPost: true, ourPost: true });
    // Значит просьба про лайк тут накруткой НЕ считается.
    expect(detectSpam("поставь лайк", ctx)).toBeNull();
  });

  it("объявление сопоставлено с объектом или это пост вакансии — тоже наше", () => {
    expect(
      sharedPostSpamContext({ sharedPost: true, ownMedia: false, adProperty: true, vacancyPost: false }).ourPost
    ).toBe(true);
    expect(
      sharedPostSpamContext({ sharedPost: true, ownMedia: false, adProperty: false, vacancyPost: true }).ourPost
    ).toBe(true);
  });

  it("просто пришёл с рекламы — этого мало, проверка работает", () => {
    // Ни ленты, ни сопоставленного объекта: что он переслал, мы не знаем.
    const ctx = sharedPostSpamContext({
      sharedPost: true,
      ownMedia: false,
      adProperty: false,
      vacancyPost: false,
    });
    expect(ctx).toEqual({ sharedPost: true, ourPost: false });
    expect(detectSpam("подпишись и поставь лайк", ctx)).not.toBeNull();
    // А живого клиента по-прежнему не задеваем: голая пересылка без слов и
    // обычный вопрос спамом не считаются.
    expect(detectSpam("", ctx)).toBeNull();
    expect(detectSpam("такая квартира есть?", ctx)).toBeNull();
  });
});
