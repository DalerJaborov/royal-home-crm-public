/**
 * Фильтры исходящей реплики бота на настоящих фразах (ревизия 02.10.2026).
 * Каждый тест — находка прогона 161 живой реплики через всю цепочку фильтров:
 * законный текст не ломается (F*), запрещённое не проходит (M*).
 * Разбор — docs/journal/2026-10-02-filtry-otveta-bota.md.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: vi.fn(async () => {}),
}));

import { cleanOutgoingReply, stripRepeatGreeting, stripLeadingAck, stripFillerWords } from "../src/ai/replyGuards.js";
import { normalizeReplyBubbles } from "../src/ai/leadQualifier.js";
import { guardPrices, guardDiscounts } from "../src/ai/priceGuard.js";
import { guardAvailability } from "../src/ai/availabilityGuard.js";
import { stripRecruiting } from "../src/ai/recruitingGuard.js";
import { guardDirectionQuestion } from "../src/ai/intentDirectionGuard.js";
import { clientMeansHousingDeal } from "../src/ai/housingIntent.js";

describe("ложные срабатывания: ломают законный текст", () => {
  it("F1 цена с пересчётом в скобках не съедается телефонным фильтром", () => {
    expect(cleanOutgoingReply("Цена 85 000 (926 500 сомони)")).toBe("Цена 85 000 (926 500 сомони)");
    expect(cleanOutgoingReply("Нархаш 650 000 (59 600 $)")).toBe("Нархаш 650 000 (59 600 $)");
  });

  it("F1b цена в конце строки + число в начале следующей — не телефон", () => {
    expect(cleanOutgoingReply("Цена 1 250 000\n120 м², 5 этаж")).toBe("Цена 1 250 000\n120 м², 5 этаж");
  });

  it("F2 подтверждение номера клиента не превращается в «уточню цену»", () => {
    const r = guardPrices({ bubbles: ["Записал ваш номер 93 555 12 34, агент перезвонит."], allowedText: "мой номер +992935551234" });
    expect(r.invented).toEqual([]);
  });

  it("F3 ответ про цену объекта не подменяется вопросом «купить или продать?»", () => {
    const bubble = "Квартира стоит 85 000 $. Если решите купить, оформим ипотеку. Когда удобно посмотреть?";
    const out = guardDirectionQuestion({ bubbles: [bubble], clientText: "Сколько стоит квартира №45?", botSpokeBefore: true, language: "ru" });
    expect(out.join(" ")).toContain("85 000 $");
    const first = guardDirectionQuestion({ bubbles: [bubble], clientText: "Сколько стоит квартира №45?", botSpokeBefore: false, language: "ru" });
    expect(first.join(" ")).toContain("85 000 $");
  });

  it("F4 вопрос продавцу «Ҳуҷҷатҳои хона ҳаст?» — не обещание наличия", () => {
    expect(guardAvailability(["Ҳуҷҷатҳои хона ҳаст?"], false).removed).toEqual([]);
    expect(guardAvailability(["Подберём удобное время для показа. Когда вам удобно?"], false).removed).toEqual([]);
    expect(guardAvailability(["Есть варианты оплаты: наличные или рассрочка."], false).removed).toEqual([]);
  });

  it("F5 «лутфан» не оставляет «,,» и «,!»", () => {
    expect(cleanOutgoingReply("Рақаматонро, лутфан, нависед.")).toBe("Рақаматонро, нависед");
    expect(cleanOutgoingReply("Рақаматонро нависед, лутфан!")).toBe("Рақаматонро нависед!");
  });

  it("F6 «Приветствую»/«Приветик» не превращаются в «Ствую»/«Ик»", () => {
    expect(stripRepeatGreeting("Приветствую! Квартира ещё в продаже.")).not.toMatch(/^Ствую/);
    expect(stripRepeatGreeting("Приветик! Хона ҳаст")).not.toMatch(/^Ик/);
  });

  it("F7 «Хорошо, что…»/«Хуб, ки…» — не отчёт о приёме", () => {
    expect(stripLeadingAck("Хорошо, что вы написали!")).toBe("Хорошо, что вы написали!");
    expect(stripLeadingAck("Хуб, ки навиштед!")).toBe("Хуб, ки навиштед!");
    expect(stripLeadingAck("Ясно, что бюджет важен.")).toBe("Ясно, что бюджет важен.");
  });

  it("F8 слова-паразиты не оставляют обрубков", () => {
    expect(stripFillerWords("Всё оформлено, в общем-то всё чисто.")).not.toContain("-то");
    expect(cleanOutgoingReply("Рад сообщить, что квартира ещё свободна!")).not.toMatch(/^Что /);
  });

  it("F9 техпаспорт без ошибок — не «системный сбой»", () => {
    expect(cleanOutgoingReply("Технический паспорт в порядке, ошибок в документах нет.")).not.toBe("");
    expect(cleanOutgoingReply("Ҳуҷҷатҳои техникӣ бе хато тайёранд.")).not.toBe("");
  });

  it("F10 «в системе рассрочки» не превращается в «Работаем рассрочки»", () => {
    expect(cleanOutgoingReply("Работаем в системе рассрочки банка: первый взнос 30%.")).not.toContain("Работаем рассрочки");
  });

  it("F11 сводка объекта в 9 строк — не «чужая работа»", () => {
    const card = "Квартира 3-комн.\nРайон: Сино\nПлощадь: 95 м²\nЭтаж: 5/9\nРемонт: евро\nДокументы: готовы\nЦена: 85 000 $\nФото: royalhome.tj/listing/45\nКогда удобно посмотреть?";
    expect(cleanOutgoingReply(card, "ищу 3-комнатную в Сино")).toContain("85 000 $");
  });

  it("F12 вырезание выдуманной цены не склеивает нумерованный список", () => {
    const r = guardPrices({ bubbles: ["Варианты:\n1. Сино, 85 000 $\n2. Фирдавси, 99 000 $\n3. Сомони, 48 000 $"], allowedText: "85 000 $ 48 000 $" });
    expect(r.bubbles[0]).toBe("Варианты:\n1. Сино, 85 000 $\n3. Сомони, 48 000 $");
  });

  it("F13 «для жизни или работы?» покупателю — не вербовка", () => {
    expect(stripRecruiting(["Квартира нужна для жизни или работы?"], "ru").stripped).toBe(0);
    expect(stripRecruiting(["Барои зиндагӣ ё кор?"], "tg").stripped).toBe(0);
  });

  it("F14 вырезка вербовки не рвёт ссылку и не склеивает строки", () => {
    expect(stripRecruiting(["Сайти мо royalhome.tj. Мо агентони фурӯшро ба кор қабул мекунем."], "tg").bubbles[0]).toBe("Сайти мо royalhome.tj.");
    expect(stripRecruiting(["Нархаш 85 000 $.\nДар Сино.\nРезюме доред?"], "tg").bubbles[0]).toBe("Нархаш 85 000 $.\nДар Сино.");
  });

  it("F15 чужой адрес вырезается без висящего предлога", () => {
    expect(cleanOutgoingReply("Похожие варианты есть на somon.tj, но лучше через нас.")).not.toMatch(/на,/);
  });

  it("F16 «@royalhome.tj — наш инстаграм» не теряет сам ник", () => {
    expect(cleanOutgoingReply("@royalhome.tj — наш инстаграм, там все объекты.")).toContain("royalhome.tj");
  });
});

describe("пропуски: должно резаться, а проходит", () => {
  it("M1 выдуманная цена словами «тысяч/ҳазор/млн/k» ловится", () => {
    expect(guardPrices({ bubbles: ["Стоимость 95 тысяч долларов. Хотите посмотреть?"], allowedText: "85 000 $" }).invented.length).toBeGreaterThan(0);
    expect(guardPrices({ bubbles: ["Нархаш 950 ҳазор сомонӣ. Кай мебинед?"], allowedText: "650 000 сомонӣ" }).invented.length).toBeGreaterThan(0);
    expect(guardPrices({ bubbles: ["Нархаш 1,1 млн сомонӣ. Кай мебинед?"], allowedText: "1 250 000 сомонӣ" }).invented.length).toBeGreaterThan(0);
    expect(guardPrices({ bubbles: ["Хозяин отдаст за 80 тыс. $. Когда смотрим?"], allowedText: "85 000 $" }).invented.length).toBeGreaterThan(0);
  });

  it("M2 размер торга без слова «скидка» ловится", () => {
    expect(guardDiscounts(["Хозяин может снизить цену на 5%, если оформите до конца месяца."]).invented).toEqual([5]);
    expect(guardDiscounts(["Соҳиб нархро 5% кам мекунад."]).invented).toEqual([5]);
  });

  it("M2b «скидка 150%» записывается как 150, а не 50", () => {
    expect(guardDiscounts(["Скидка 150%."]).invented).not.toEqual([50]);
  });

  it("M3 признание сбоя не проходит из-за того, что «в системе» вырезали раньше", () => {
    expect(cleanOutgoingReply("В системе произошёл сбой, извините.")).toBe("");
    expect(cleanOutgoingReply("Дар система хато шуд, бубахшед.")).toBe("");
    expect(cleanOutgoingReply("Дар системаи мо хато шуд.")).toBe("");
  });

  it("M4 чужой телефон в t.me/+…, через точки и в viber-ссылке не уходит", () => {
    expect(cleanOutgoingReply("Хозяин: t.me/+992938887766")).not.toMatch(/938887766/);
    expect(cleanOutgoingReply("Хозяин: 938.887.766")).not.toMatch(/938\.887\.766/);
    expect(cleanOutgoingReply("Пишите в вайбер viber://chat?number=%2B992938887766")).not.toContain("%2B");
  });

  it("M5 номер карты / просьба перевести деньги не уходит клиенту", () => {
    expect(cleanOutgoingReply("Отправьте 200 сомони на карту Алиф 4444 5555 6666 7777 для брони.")).not.toContain("4444 5555 6666 7777");
  });

  it("M6 «Ҳавлӣ дар Шоҳмансур ҳаст» при пустой подборке — обещание", () => {
    expect(guardAvailability(["Ҳавлӣ дар Шоҳмансур ҳаст. Рақаматонро нависед."], false).removed.length).toBe(1);
  });

  it("M7 повторное приветствие во втором пузыре, если первый съеден", () => {
    expect(normalizeReplyBubbles(["Хуб.", "Салом! Нархаш 85 000 $."], true, "")).toEqual(["Нархаш 85 000 $"]);
  });

  it("M8 «Фаҳмо,» после приветствия тоже срезается", () => {
    expect(normalizeReplyBubbles(["Ассалому алейкум! Фаҳмо, дар Сино 3 ҳуҷрагӣ ҳаст."], true, "")).toEqual(["Дар Сино 3 ҳуҷрагӣ ҳаст"]);
  });

  it("M9 таджикские ӣ/ӯ в разложенном виде (NFD) распознаются", () => {
    expect(clientMeansHousingDeal("Ҳавлӣ мефурӯшам".normalize("NFD"))).toBe(true);
    expect(guardAvailability(["Шоҳмансурда ҳавлӣ дорем. Рақаматонро нависед.".normalize("NFD")], false).removed.length).toBe(1);
  });
});
