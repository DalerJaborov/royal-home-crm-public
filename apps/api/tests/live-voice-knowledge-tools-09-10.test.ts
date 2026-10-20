import { describe, expect, it } from "vitest";

/**
 * ЗНАНИЯ И РЕЧЬ РОБОТА (09.10.2026): день, время и расстояние словами на русском и
 * таджикском; часы работы и «адреса офиса нет» — из Настроек, а не из головы; промт
 * знает новые функции и правило «записали — только по ответу функции».
 */

const { spokenWhen, spokenClock, spokenDay, spokenDistance } = await import("@royal-home/shared");
const { agencyHoursBlock, buildLiveVoiceKnowledge } = await import("../src/ai/liveVoiceKnowledge.js");
const { buildConsultantSystemPrompt } = await import("../src/ai/liveVoiceConsultantPersona.js");
const { CONSULTANT_TOOLS } = await import("../src/lib/telephony/liveVoiceConsultant.js");

/** Момент по Душанбе (UTC+5). */
const at = (iso: string) => new Date(`${iso}+05:00`);
const NOW = at("2026-10-09T12:00:00"); // пятница

describe("день и время словами", () => {
  it("русский: сегодня/завтра/день недели, часть суток", () => {
    expect(spokenWhen(at("2026-10-10T14:00:00"), NOW, "ru")).toBe("завтра, в два часа дня");
    expect(spokenWhen(at("2026-10-09T18:00:00"), NOW, "ru")).toBe("сегодня, в шесть часов вечера");
    expect(spokenWhen(at("2026-10-13T11:30:00"), NOW, "ru")).toBe("во вторник, в одиннадцать тридцать утра");
    expect(spokenClock(at("2026-10-10T13:00:00"), "ru")).toBe("в час дня");
    expect(spokenDay(at("2026-10-23T10:00:00"), NOW, "ru")).toBe("в пятницу, 23 октября");
  });

  it("таджикский: имрӯз/пагоҳ, соати …", () => {
    expect(spokenWhen(at("2026-10-10T14:00:00"), NOW, "tg")).toBe("пагоҳ, соати чордаҳ");
    expect(spokenDay(at("2026-10-11T10:00:00"), NOW, "tg")).toBe("пасфардо");
    expect(spokenClock(at("2026-10-10T11:30:00"), "tg")).toBe("соати ёздаҳ ва сӣ дақиқа");
  });

  it("по Душанбе, а не по часам процесса: 23:30 UTC — уже завтра утром", () => {
    expect(spokenDay(new Date("2026-10-09T23:30:00Z"), new Date("2026-10-09T10:00:00Z"), "ru")).toBe("завтра");
  });
});

describe("расстояние словами", () => {
  it("метры до километра, округление до пятидесяти; километры с половиной", () => {
    expect(spokenDistance(430, "ru")).toBe("четыреста пятьдесят метров");
    expect(spokenDistance(20, "ru")).toBe("пятьдесят метров");
    expect(spokenDistance(1500, "ru")).toBe("полтора километра");
    expect(spokenDistance(2000, "ru")).toBe("два километра");
    expect(spokenDistance(2500, "ru")).toBe("два с половиной километра");
    expect(spokenDistance(1500, "tg")).toBe("якуним километр");
    expect(spokenDistance(300, "tg")).toMatch(/метр$/);
  });
});

describe("часы и офис — из Настроек, без выдумки", () => {
  it("часы и выходные из Настроек; адрес офиса — из единого источника (10.10.2026, выходные — 11.10.2026)", () => {
    const block = agencyHoursBlock({ start: "09:30", end: "18:00" });
    expect(block).toContain("с 09:30 до 18:00");
    // По умолчанию выходных нет — «воскресенье — выходной» не звучит.
    expect(block).toContain("выходных нет — работаем каждый день");
    expect(block).not.toContain("кроме воскресенья");
    expect(agencyHoursBlock({ start: "09:30", end: "18:00", daysOff: [0] })).toContain("выходной — воскресенье");
    expect(block).toContain("ул. Бухоро 49");
    expect(block).not.toContain("АДРЕСА ОФИСА в справочнике нет");
    expect(block).toContain("с 09:00 до 20:00"); // окно показов — константы записи на показ
  });

  it("часы не прочитались — честное «нет данных», без цифр", () => {
    const block = agencyHoursBlock(null);
    expect(block).not.toMatch(/\d\d:\d\d до \d\d:\d\d по Душанбе/);
    expect(block).toContain("Точных часов работы сейчас нет");
  });

  it("блок входит в справочник голоса", () => {
    const knowledge = buildLiveVoiceKnowledge({
      folkGeography: "",
      sellerRules: "",
      learnedRules: "",
      usdToTjs: 10.9,
      wallClock: new Date("2026-10-09T12:00:00Z"),
      workHours: { start: "09:30", end: "18:00" },
    });
    expect(knowledge).toContain("<часы_и_офис>");
  });
});

describe("промт и список функций", () => {
  const prompt = buildConsultantSystemPrompt({
    knowledge: "",
    caller: { numberKnown: true, selfName: null, agentName: "Нозия", dossier: "" },
    withinWorkingHours: true,
    forceRussianOnly: true,
  });

  it("каждая новая функция зарегистрирована и названа в промте", () => {
    const names = CONSULTANT_TOOLS.map((t) => t.name);
    for (const name of ["my_status", "save_client_request", "request_callback", "showing_slots", "book_showing", "send_property_messenger", "describe_area"]) {
      expect(names).toContain(name);
      expect(prompt).toContain(name);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it("«записали» — только по ответу функции; нет данных — не придумывать", () => {
    expect(prompt).toContain("«Записали на показ» — только если book_showing вернул booked: true");
    expect(prompt).toContain("Не знаешь ответа и функции на это нет — не придумывай");
    expect(prompt).not.toContain("Ты НЕ назначаешь время показа");
    expect(prompt).toContain("вызови my_status и ответь только тем, что она вернула");
  });
});
