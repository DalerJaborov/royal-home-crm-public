import { describe, expect, it } from "vitest";
import { applyAvailabilityGuard, availabilityGuardFallbackReply, guardAvailability } from "../src/ai/availabilityGuard.js";

/**
 * «У нас есть варианты» при пустой подборке — промт называет это самой дорогой
 * ложью из возможных, и в первый же день живого трафика (16.08.2026) она случилась.
 *
 * Клиент искал трёшку в центре до 200 тысяч долларов. Район «центр» в карточку не
 * пишется (делится на два официальных), тип он не назвал — подборка не строилась,
 * блока объектов в промте НЕ БЫЛО. Бот всё равно написал «В этом бюджете в центре
 * есть отличные варианты. Напишите ваш номер». Следующей репликой человек спросил
 * «Какие варианты у вас есть?» — и не получил ни одного.
 */
describe("обещание вариантов сверяется с подборкой", () => {
  it("обещание при пустой подборке вырезается, остальное остаётся", () => {
    const r = guardAvailability(
      ["В этом бюджете в центре есть отличные варианты", "Напишите ваш номер телефона, наш агент свяжется"],
      false
    );
    expect(r.removed).toHaveLength(1);
    expect(r.bubbles).toEqual(["Напишите ваш номер телефона, наш агент свяжется"]);
  });

  it("«подберём» — то же обещание другими словами", () => {
    const r = guardAvailability(["Подберём лучший вариант. До скольки тысяч долларов рассматриваете?"], false);
    expect(r.bubbles).toEqual(["До скольки тысяч долларов рассматриваете?"]);
  });

  it("таджикский вариант обещания", () => {
    const r = guardAvailability(["Вариантҳои зӯр дорем. Рақаматонро нависед"], false);
    expect(r.bubbles).toEqual(["Рақаматонро нависед"]);
  });

  it("«ҳавлӣ дорем» — то же обещание, названное предметом, а не словом «вариант»", () => {
    // Живой случай 20.09.2026: клиентка просила ҳавлӣ до 1 200 000 сомони, подборки
    // в промте не было, бот написал «Шохмансурда ҳавлӣ дорем» — и фильтр это
    // пропускал, потому что искал слово «вариант».
    const r = guardAvailability(["Шохмансурда ҳавлӣ дорем. Рақаматонро нависед"], false);
    expect(r.removed).toHaveLength(1);
    expect(r.bubbles).toEqual(["Рақаматонро нависед"]);
  });

  /**
   * ОПРЕДЕЛЕНИЕ ПЕРЕД ПРЕДМЕТОМ ОБХОДИЛО ФИЛЬТР (найдено 20.09.2026,
   * docs/bot-razbor-20-09.md, класс 4 п. 5). Правило требовало предмет СРАЗУ после
   * «есть», а список прилагательных был закрытым — именно такая фраза и была в
   * живом случае 16.08.2026.
   */
  it.each([
    ["прилагательное перед типом", "У нас есть отличная трёшка в Сино"],
    ["два слова перед типом", "У нас есть две хорошие квартиры"],
    ["неописанное прилагательное перед «вариант»", "В этом бюджете есть уютные варианты"],
  ])("обещание с определением тоже вырезается (%s)", (_label, promise) => {
    const r = guardAvailability([promise, "Рақаматонро нависед"], false);
    expect(r.removed).toHaveLength(1);
    expect(r.bubbles).toEqual(["Рақаматонро нависед"]);
  });

  it("вопрос продавцу «у вас есть квартира?» остаётся", () => {
    // Фильтр про НАШЕ обещание, а не про любое «есть»: приём объекта у продавца
    // начинается ровно с такого вопроса.
    const ask = ["У вас есть готовая квартира на продажу?"];
    expect(guardAvailability(ask, false).bubbles).toEqual(ask);
  });

  it("отказ тем же словом не трогаем", () => {
    const denial = ["Ҳозир чунин ҳавлӣ надорем. Рақаматонро нависед"];
    expect(guardAvailability(denial, false).bubbles).toEqual(denial);
  });

  it("обещание при НЕпустой подборке остаётся — обещать есть что", () => {
    const honest = ["Шохмансурда ҳавлӣ дорем. Рақаматонро нависед"];
    expect(guardAvailability(honest, true).bubbles).toEqual(honest);
  });

  /**
   * Самое важное свойство: фильтр труслив. Ложное срабатывание вырезает ЧЕСТНУЮ
   * фразу и оставляет клиента без ответа — это хуже, чем пропущенная ложь.
   */
  it("честный отказ не трогаем — в нём то же слово «вариант»", () => {
    const denial = ["Ҳозир маҳз чунин вариант надорем. Рақаматонро нависед"];
    expect(guardAvailability(denial, false).bubbles).toEqual(denial);
    const ru = ["К сожалению, подходящих вариантов нет вариант сейчас"];
    expect(guardAvailability(ru, false).removed).toHaveLength(0);
  });

  it("подборка есть — не вмешиваемся вовсе, обещание правдиво", () => {
    const promise = ["В этом бюджете есть отличные варианты"];
    expect(guardAvailability(promise, true).bubbles).toEqual(promise);
    expect(guardAvailability(promise, true).removed).toHaveLength(0);
  });

  it("обычный ответ про цену и метраж не задет", () => {
    const plain = ["Нархаш 320 000 сомонӣ, 129 квадрат"];
    expect(guardAvailability(plain, false).bubbles).toEqual(plain);
  });

  /**
   * `\b` в JavaScript определён через [A-Za-z0-9_] и с кириллицей не работает:
   * `/\bесть/` не находит «есть» ни разу. На этом в репозитории молча умерли уже
   * четыре правила, и пятое чуть не умерло здесь — первый прогон на живой фразе
   * не сработал именно поэтому.
   */
  it("русские шаблоны действительно срабатывают (границы слова выписаны явно)", () => {
    expect(guardAvailability(["У нас есть квартиры в этом районе"], false).removed).toHaveLength(1);
    expect(guardAvailability(["Найдём вам подходящий"], false).removed).toHaveLength(1);
  });

  it("если чистка съедает ответ целиком — отдаём как есть и помечаем", () => {
    // Пустое сообщение клиенту хуже неточного; факт всё равно уйдёт в журнал.
    const r = guardAvailability(["Вариантҳои зӯр дорем"], false);
    expect(r.keptDespiteViolation).toBe(true);
    expect(r.bubbles).toEqual(["Вариантҳои зӯр дорем"]);
  });

  /**
   * Ревью PR #431 (16.09.2026): тот же класс бага, что чинили там у guardPrices/
   * guardDiscounts, был жив и здесь — applyAvailabilityGuard возвращал исходные
   * bubbles (ложное обещание) вместо безопасной заглушки при keptDespiteViolation.
   */
  describe("applyAvailabilityGuard подставляет заглушку вместо выдумки", () => {
    it("ответ целиком — обещание при пустой подборке: уходит заглушка, не исходный текст", () => {
      const out = applyAvailabilityGuard(["Вариантҳои зӯр дорем"], false, "tg");
      expect(out).toEqual(availabilityGuardFallbackReply("tg"));
      // Исходное лживое обещание «зӯр дорем» (отличные — есть) не уходит клиенту.
      expect(out.join(" ")).not.toContain("зӯр дорем");
    });

    it("русский вариант того же случая", () => {
      const out = applyAvailabilityGuard(["В этом бюджете есть отличные варианты"], false, "ru");
      expect(out).toEqual(availabilityGuardFallbackReply("ru"));
      // Исходное лживое обещание «есть отличные варианты» не уходит клиенту.
      expect(out.join(" ")).not.toContain("есть отличные варианты");
    });

    it("частичная вырезка (что-то осталось) заглушку не подставляет", () => {
      const out = applyAvailabilityGuard(
        ["В этом бюджете в центре есть отличные варианты", "Напишите ваш номер телефона"],
        false,
        "ru"
      );
      expect(out).toEqual(["Напишите ваш номер телефона"]);
    });

    it("подборка есть — щит не вмешивается, заглушка не нужна", () => {
      const promise = ["В этом бюджете есть отличные варианты"];
      expect(applyAvailabilityGuard(promise, true, "ru")).toEqual(promise);
    });
  });

  describe("availabilityGuardFallbackReply — текст не про цену", () => {
    it("русский и таджикский варианты заданы, «цифра» из priceGuardFallbackReply не используется", () => {
      const ru = availabilityGuardFallbackReply("ru");
      const tg = availabilityGuardFallbackReply("tg");
      expect(ru[0]).not.toContain("цифр");
      expect(ru[0].length).toBeGreaterThan(0);
      expect(tg[0].length).toBeGreaterThan(0);
      expect(ru).not.toEqual(tg);
    });

    it("mixed — одна таджикская фраза (ревизия 02.10), unknown — русский по умолчанию", () => {
      expect(availabilityGuardFallbackReply("mixed")).toEqual(availabilityGuardFallbackReply("tg"));
      expect(availabilityGuardFallbackReply("ru")[0]).not.toMatch(/вернусь/);
      expect(availabilityGuardFallbackReply("unknown")).toEqual(availabilityGuardFallbackReply("ru"));
    });
  });
});
