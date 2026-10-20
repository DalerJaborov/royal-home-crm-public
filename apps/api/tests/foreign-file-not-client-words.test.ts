import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";
import { collectSellerFacts, extractSellerFacts, missingSellerFacts } from "../src/ai/sellerIntake.js";
import { clientSelfStatedName } from "../src/ai/replyGuards.js";
import { clientSaidNothingSubstantive } from "../src/ai/adTemplateOpener.js";
import { countNoContactComplaints, looksLikeNoContactComplaint } from "../src/ai/complaintGuard.js";

/**
 * СОДЕРЖИМОЕ ЧУЖОГО ФАЙЛА — НЕ «КЛИЕНТ СКАЗАЛ ЭТО САМ» (находка 3.1 сплошной
 * проверки бота 21.09.2026 и весь её класс).
 *
 * Расшифровка голосового, описание видео, содержимое документа и заметка агента
 * лежат в реплике клиента врезкой `<client_content kind="…">`. Код, который
 * судит по репликам («параметр уже назван», «клиент представился», «он ещё
 * ничего не написал», «это уже вторая жалоба»), читал их вместе со своим
 * текстом. Живой случай: продавец пересылает скрин ЧУЖОГО объявления и пишет
 * «Ман ҳам мефурӯшам» — разбор считал названными комнаты, площадь и цену того
 * объявления, в промт уходило «названо всё, больше не спрашивай», а про его
 * квартиру мы не знали ничего.
 *
 * Голосовое здесь НЕ вырезается нигде: это собственная речь клиента, и потерять
 * её значило бы переспрашивать всё, что он наговорил.
 */

const foreignAd = wrapUntrusted(
  "document",
  "Продаётся 3-комнатная, 90 квадрат, 5 этаж, евроремонт, район Сино, цена 75 000 доллар"
);

describe("чужой файл не засчитывается как слова клиента", () => {
  it("параметры из пересланного объявления не считаются названными", () => {
    const facts = extractSellerFacts(`Ман ҳам мефурӯшам ${foreignAd}`);
    expect(facts).toEqual({});
    // Значит бот по-прежнему спросит про объект всё — это и есть исправление.
    expect(missingSellerFacts(facts)).toEqual(["rooms", "area", "district", "floor", "condition", "price"]);
  });

  it("свои слова в той же реплике считаются по-прежнему", () => {
    const facts = extractSellerFacts(`${foreignAd} Ман ҳам мефурӯшам, 2-хонага, 4 этаж`);
    expect(facts.rooms).toBe(true);
    expect(facts.floor).toBe(true);
    expect(facts.price).toBeUndefined();
    expect(facts.district).toBeUndefined();
  });

  it("сказанное голосом остаётся словами клиента", () => {
    const voice = wrapUntrusted("voice", "Салом, ман 3-хонага дорам, 5 этаж, нархаш 60 000 доллар");
    const facts = extractSellerFacts(voice);
    expect(facts.rooms).toBe(true);
    expect(facts.floor).toBe(true);
    expect(facts.price).toBe(true);
  });

  it("за весь разговор — то же правило", () => {
    const facts = collectSellerFacts([
      { role: "user", content: `Салом ${foreignAd}` },
      { role: "assistant", content: "Чанд хонага?" },
      { role: "user", content: "2-хонага" },
    ]);
    expect(facts.rooms).toBe(true);
    expect(facts.area).toBeUndefined();
    expect(facts.condition).toBeUndefined();
  });

  it("имя из чужого документа не становится обращением", () => {
    const doc = wrapUntrusted("document", "Меня зовут Азиз, продаю квартиру");
    expect(clientSelfStatedName([{ role: "user", content: doc }])).toBeNull();
    // Заметка агента — тоже не представление: в ней приводятся чужие слова.
    const note = wrapUntrusted("crm_note", "Клиент сказал, меня зовут Фируза");
    expect(clientSelfStatedName([{ role: "user", content: note }])).toBeNull();
  });

  it("имя, названное самим клиентом (в том числе голосом), берётся как раньше", () => {
    expect(clientSelfStatedName([{ role: "user", content: "Меня зовут Далер" }])).toBe("Далер");
    const voice = wrapUntrusted("voice", "Меня зовут Далер");
    expect(clientSelfStatedName([{ role: "user", content: voice }])).toBe("Далер");
  });

  it("прислал только скрин — значит своих слов ещё нет", () => {
    expect(clientSaidNothingSubstantive(`Салом ${foreignAd}`)).toBe(true);
    expect(clientSaidNothingSubstantive(`Салом ${foreignAd} 3-хонага мехохам`)).toBe(false);
  });

  it("жалоба внутри чужого файла не будит руководителя", () => {
    const complaint = wrapUntrusted("document", "Мне никто не позвонил, жду звонка уже неделю");
    expect(looksLikeNoContactComplaint(complaint)).toBe(false);
    expect(countNoContactComplaints([complaint, complaint])).toBe(0);
    // Своя жалоба — считается, в том числе сказанная голосом.
    expect(looksLikeNoContactComplaint("мне так и не позвонил агент")).toBe(true);
    expect(countNoContactComplaints([wrapUntrusted("voice", "никто не позвонил"), "жду звонка уже"])).toBe(2);
  });
});
