import { describe, expect, it } from "vitest";
import { buildShortReplySystem } from "../src/ai/leadQualifier.js";

/**
 * Короткие реплики бота вне основного хода: напоминание молчащему клиенту и
 * подтверждение принятой заявки.
 *
 * Владелец поймал это на живой переписке: бот присылал напоминание словами
 * «Ассалом, чем могу помочь?» — как будто видит человека впервые, хотя вся
 * переписка была у него перед глазами. История в модель уходила исправно;
 * не хватало ровно двух вещей — сказать, что разговор УЖЕ идёт, и показать,
 * что клиент про себя уже рассказал.
 */

const INSTRUCTION = "Клиент не отвечает, верни его к разговору.";

describe("правило продолжения разговора", () => {
  it("прямо запрещает здороваться и представляться заново", () => {
    const system = buildShortReplySystem(INSTRUCTION);
    expect(system).toContain("ПРОДОЛЖЕНИЕ разговора");
    expect(system).toContain("здороваться заново");
    expect(system).toContain("представляться");
  });

  it("запрет стоит всегда, даже когда про клиента ничего не известно", () => {
    // Имени может не быть (Instagram его не отдаёт), но разговор всё равно не первый.
    const system = buildShortReplySystem(INSTRUCTION);
    expect(system).toContain("не первое сообщение");
  });

  it("задача не теряется среди правил", () => {
    expect(buildShortReplySystem(INSTRUCTION)).toContain(INSTRUCTION);
  });
});

describe("бот помнит собеседника", () => {
  it("имя попадает в подсказку", () => {
    const system = buildShortReplySystem(INSTRUCTION, { name: "Алишер" });
    expect(system).toContain("Алишер");
  });

  it("собранное по заявке передаётся с запретом переспрашивать", () => {
    const system = buildShortReplySystem(INSTRUCTION, {
      draft: { budgetMax: 60000, districtName: "Сино", rooms: 3 },
    });
    expect(system).toContain("НЕ переспрашивай");
    expect(system).toContain("Сино");
    expect(system).toContain("60000");
  });

  it("пустой черновик не превращается в мусорную строку", () => {
    // Иначе модель получала бы «клиент уже рассказал: {}» и делала из этого выводы.
    const system = buildShortReplySystem(INSTRUCTION, { draft: {} });
    expect(system).not.toContain("НЕ переспрашивай");
  });

  it("отсутствие имени не оставляет пустого «Имя клиента:»", () => {
    const system = buildShortReplySystem(INSTRUCTION, { name: null, draft: null });
    expect(system).not.toContain("Имя клиента");
  });
});

describe("бот не выдумывает того, чего не было", () => {
  it("прямо запрещено спрашивать про варианты, которых не присылали", () => {
    // Живой случай 31.07: клиент ответил на рекламу, бот прислал напоминание
    // «какой вариант вам понравился?» — не отправив ни одного объекта.
    const system = buildShortReplySystem(INSTRUCTION);
    expect(system).toContain("не ссылайся на то, чего в переписке выше НЕ БЫЛО");
    expect(system).toContain("какой вариант вам понравился");
  });

  it("показы и договорённости тоже нельзя придумывать", () => {
    expect(buildShortReplySystem(INSTRUCTION)).toContain("которых не было");
  });
});

describe("обращения по полу запрещены", () => {
  it("бот не должен звать человека «акаҷон» или «апаҷон»", () => {
    // Бот писал «Салом акаҷон» женщине: пол он не знает и знать не может.
    const system = buildShortReplySystem(INSTRUCTION, { name: "Рустамова" });
    expect(system).toContain("ЗАПРЕЩЕНЫ");
    expect(system).toContain("без родовых приставок");
  });
});

describe("прежние правила не потерялись", () => {
  it("язык клиента и запрет на тире остались", () => {
    const system = buildShortReplySystem(INSTRUCTION);
    expect(system).toContain("на языке клиента");
    expect(system).toContain("НИКОГДА не используй тире");
    expect(system).toContain("submit_reply");
  });
});
