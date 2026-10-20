import { describe, expect, it } from "vitest";
import { GEMINI_VOICES, selfGenderRule, voiceGender } from "@royal-home/shared";
import { withSelfGenderReminder, withSelfGenderRule } from "../src/ai/liveVoiceSelfGender.js";
import {
  buildConsultantSystemPrompt,
  CONSULTANT_AGENT_MISSED_TRIGGER,
  CONSULTANT_GREETING_TRIGGERS,
  CONSULTANT_OUTBOUND_GREETING_TRIGGERS,
  CONSULTANT_RETURNED_TRIGGER,
  type ConsultantCaller,
} from "../src/ai/liveVoiceConsultantPersona.js";
import { DEFAULT_LIVE_VOICE_PROMPT, LIVE_VOICE_PROMPT_VERSION } from "../src/ai/liveVoicePersona.js";
import { buildLiveVoiceKnowledge } from "../src/ai/liveVoiceKnowledge.js";
import { buildInterviewInviteCallPrompt, INTERVIEW_INVITE_GREETING_TRIGGER } from "../src/ai/interviewInviteCallPersona.js";
import { buildPostShowingCallPrompt, POST_SHOWING_CALL_GREETING_TRIGGER } from "../src/ai/postShowingCallPersona.js";
import { buildSellerProbeCallPrompt, SELLER_PROBE_CALL_GREETING_TRIGGER } from "../src/ai/sellerProbeCallPersona.js";
import { pickScenarioVoiceName } from "../src/lib/telephony/scenarioVoice.js";

/**
 * Род голоса (02.10.2026, жалоба владельца: женский голос говорил о себе «понял,
 * записал»). Правило берётся от голоса, который звучит, а общие тексты промтов не
 * должны сами задавать род ни в какую сторону.
 */

describe("таблица голосов Gemini", () => {
  it("30 голосов: 14 женских и 16 мужских, проверенные на звонках Kore и Enceladus — как на слух", () => {
    expect(GEMINI_VOICES).toHaveLength(30);
    expect(GEMINI_VOICES.filter((v) => v.gender === "female")).toHaveLength(14);
    expect(voiceGender("Kore")).toBe("female");
    expect(voiceGender("Enceladus")).toBe("male");
    expect(voiceGender("Charon")).toBe("male");
    expect(voiceGender("aoede")).toBe("female");
  });

  it("неизвестное имя и пусто — женский, как голос по умолчанию Kore", () => {
    expect(voiceGender("Нечто")).toBe("female");
    expect(voiceGender(null)).toBe("female");
    expect(voiceGender("")).toBe("female");
  });
});

describe("правило рода", () => {
  it("женский голос — «поняла», мужской «понял» назван ошибкой; мужской — зеркально", () => {
    const female = selfGenderRule("female");
    expect(female).toContain("ЖЕНСКОМ РОДЕ");
    expect(female).toContain("«поняла»");
    expect(female).toMatch(/О себе «понял»[^—]*— грубая ошибка/);
    const male = selfGenderRule("male");
    expect(male).toContain("МУЖСКОМ РОДЕ");
    expect(male).toMatch(/О себе «поняла»[^—]*— грубая ошибка/);
  });

  it("перебивает «сотрудницу»/имя другого рода выше и запрещает выдумывать имя; в таджикском рода нет", () => {
    const male = selfGenderRule("male");
    expect(male).toContain("«сотрудница» или женским именем");
    expect(male).toContain("ты сотрудник");
    expect(male).toContain("Личное имя себе не придумывай никогда");
    expect(male).toContain("По-таджикски");
  });

  it("мост вешает правило в конец промта по имени голоса, и напоминание — в первую реплику", () => {
    const prompt = withSelfGenderRule("РОЛЬ", "Charon");
    expect(prompt.startsWith("РОЛЬ")).toBe(true);
    expect(prompt).toContain("МУЖСКИМ ГОЛОСОМ");
    expect(withSelfGenderRule("РОЛЬ", "Kore")).toContain("ЖЕНСКИМ ГОЛОСОМ");
    expect(withSelfGenderReminder("(Начни.)", "Puck")).toBe("(Начни.) (О себе — в мужском роде.)");
  });
});

/** Глаголы и слова о СЕБЕ с родом, которые раньше стояли в общих текстах промтов. */
const GENDERED_SELF = [
  "ТЫ позвонил",
  "Позвонил ты",
  "Ты соединяла",
  "сама, по своей инициативе",
  "ни говорила",
  "понял отлично",
  "ты правда не уверен",
  "Записал,",
  "ты вызвала",
  "ты его не спросила",
  "ТЫ САМА ВИДИШЬ",
  "вслух попрощался",
  "не разобралась",
  "Поздоровайся первой",
  "Сама эту тему",
  "Ты её не видел",
  "Не расслышала",
  "Сама перезвонить",
];

describe("общие тексты промтов — без рода о себе", () => {
  const stranger: ConsultantCaller = { numberKnown: true, selfName: null, agentName: null, dossier: "" };
  const texts: [string, string][] = [
    ["исходящий", DEFAULT_LIVE_VOICE_PROMPT],
    ...[true, false].map(
      (weCalled) =>
        [
          `консультант weCalled=${weCalled}`,
          buildConsultantSystemPrompt({ knowledge: "", caller: { ...stranger, weCalled }, withinWorkingHours: true, forceRussianOnly: false }),
        ] as [string, string]
    ),
    ...CONSULTANT_GREETING_TRIGGERS.map((t) => ["приветствие", t] as [string, string]),
    ...CONSULTANT_OUTBOUND_GREETING_TRIGGERS.map((t) => ["приветствие от нас", t] as [string, string]),
    ["вернулся от агента", CONSULTANT_RETURNED_TRIGGER],
    ["агент не взял", CONSULTANT_AGENT_MISSED_TRIGGER],
    ["после показа", POST_SHOWING_CALL_GREETING_TRIGGER],
    ["продавец", SELLER_PROBE_CALL_GREETING_TRIGGER],
    ["приглашение кандидата", INTERVIEW_INVITE_GREETING_TRIGGER],
  ];
  for (const [name, text] of texts) {
    it(name, () => {
      for (const phrase of GENDERED_SELF) expect(text, phrase).not.toContain(phrase);
    });
  }

  it("версия промта — отпечаток текста, а не прибитая строка (аудит текстов 02.10.2026, п. 18)", () => {
    expect(LIVE_VOICE_PROMPT_VERSION).toMatch(/^t-[0-9a-f]{10}$/);
  });
});

/** Справочник консультанта целиком, а не пустая строка: именно через него приходили
 *  «ты раньше сдавался» и «Ты её не видел» (аудит текстов 02.10.2026, п. 6). */
describe("справочник консультанта — без рода о себе", () => {
  const knowledge = buildLiveVoiceKnowledge({
    folkGeography: "",
    sellerRules: "",
    learnedRules: "",
    usdToTjs: 10.5,
    wallClock: new Date("2026-10-02T10:00:00Z"),
  });
  it("нет «сдавался», «не видел» и «потом пришлёт агент» вместо СМС", () => {
    for (const phrase of ["ты раньше сдавался", "Ты её не видел", "ты сама", "шлёшь ты сама"]) {
      expect(knowledge, phrase).not.toContain(phrase);
    }
    expect(knowledge).toContain("send_property_sms");
  });
  it("промт консультанта со справочником тоже без женских и мужских форм о себе из списка", () => {
    const prompt = buildConsultantSystemPrompt({
      knowledge,
      caller: { numberKnown: true, selfName: null, agentName: null, dossier: "" },
      withinWorkingHours: true,
      forceRussianOnly: false,
    });
    for (const phrase of GENDERED_SELF) expect(prompt, phrase).not.toContain(phrase);
    expect(prompt).not.toContain("ты раньше сдавался");
  });
});

describe("приглашение кандидата — без рода о себе", () => {
  const base = { candidateName: "Анна", interviewAt: new Date("2026-10-09T06:00:00Z"), address: "ул. Айни, 1", language: "tg" as const };
  it("триггер и роль без «первой», «Не расслышала», «Сама перезвонить»; без пола голоса — без имени и без «сотрудница»", () => {
    expect(INTERVIEW_INVITE_GREETING_TRIGGER).not.toContain("первой");
    const prompt = buildInterviewInviteCallPrompt(base);
    for (const phrase of ["Не расслышала", "Сама перезвонить", "сотрудница", "Мадина", "ассистент агентства"]) {
      expect(prompt, phrase).not.toContain(phrase);
    }
  });
});

describe("опрос после показа и проверка продавца — имя и «сотрудница/сотрудник» от голоса", () => {
  const showing = { clientName: "Далер", propertyTitle: null, agentName: "Ноза", whenLabel: "вчера" };

  it("женский голос — сотрудница Мадина, мужской — сотрудник Фаррух", () => {
    const female = buildPostShowingCallPrompt({ ...showing, voiceGender: "female" });
    expect(female).toContain("Ты — сотрудница отдела качества");
    expect(female).toContain("Тебя зовут Мадина");
    const male = buildPostShowingCallPrompt({ ...showing, voiceGender: "male" });
    expect(male).toContain("Ты — сотрудник отдела качества");
    expect(male).toContain("Тебя зовут Фаррух");
    expect(male).not.toContain("Мадина");

    const seller = buildSellerProbeCallPrompt({ sellerName: "Рахим", propertyLabel: null, voiceGender: "male" });
    expect(seller).toContain("Ты — сотрудник агентства");
    expect(seller).toContain("Тебя зовут Фаррух");
    expect(buildSellerProbeCallPrompt({ sellerName: null, propertyLabel: null })).toContain("Тебя зовут Мадина");
  });

  it("про агента на показе — без «приехал»/«он»", () => {
    const prompt = buildPostShowingCallPrompt(showing);
    expect(prompt).not.toContain("приехал ли вовремя");
    expect(prompt).not.toContain("он перезвонит");
  });

  // Опрос агенту не передаётся, а трубку мог взять не тот: звонков не обещаем.
  it("не тот человек и вопросы про объекты — без обещания перезвонить", () => {
    const showingPrompt = buildPostShowingCallPrompt(showing);
    expect(showingPrompt).not.toContain("Скажи, что перезвонишь позже");
    expect(showingPrompt).not.toContain("передашь агенту и он перезвонит");
    expect(showingPrompt).toContain("написать агенту или в чат агентства");
    const seller = buildSellerProbeCallPrompt({ sellerName: null, propertyLabel: null });
    expect(seller).not.toContain("скажи, что перезвонишь");
    expect(seller).not.toContain("снимем с рекламы");
    expect(seller).toContain("передадим коллегам");
  });

  it("голос сценария выбирается тем же правилом, что в мосте: замок — основной, без замка — таджикский", () => {
    const s = { liveVoiceVoiceName: "Charon", liveVoiceVoiceNameTajik: "Aoede", liveVoiceForceRussianOnly: true };
    expect(pickScenarioVoiceName(s)).toBe("Charon");
    expect(pickScenarioVoiceName({ ...s, liveVoiceForceRussianOnly: false })).toBe("Aoede");
    expect(pickScenarioVoiceName({ ...s, liveVoiceForceRussianOnly: false, liveVoiceVoiceNameTajik: null })).toBe("Charon");
    expect(pickScenarioVoiceName({ liveVoiceVoiceName: null, liveVoiceVoiceNameTajik: null, liveVoiceForceRussianOnly: true })).toBe(
      process.env.LIVE_VOICE_VOICE_NAME || "Kore"
    );
  });
});
