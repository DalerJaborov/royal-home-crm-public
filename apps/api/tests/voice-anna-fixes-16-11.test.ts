import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConsultantSystemPrompt, type ConsultantCaller } from "../src/ai/liveVoiceConsultantPersona.js";
import { buildLiveVoiceSystemPrompt, LIVE_VOICE_SPEECH_RULES } from "../src/ai/liveVoicePersona.js";
import { TAJIK_PHONE_SPEECH_RULES } from "../src/ai/tajikPhoneSpeech.js";
import { buildInterviewInviteCallPrompt } from "../src/ai/interviewInviteCallPersona.js";
import { buildLiveVoiceKnowledge } from "../src/ai/liveVoiceKnowledge.js";

import { CallerLanguageTracker, isConfidentTajik, tajikWordCount } from "../src/lib/telephony/liveVoiceCallerLanguage.js";
import { poorLineBreakNote } from "../src/lib/telephony/liveVoicePoorLine.js";
import { ELEVENLABS_PHONE_AGENT_TUNING } from "../src/ai/elevenLabsAgentSync.js";
import { detectOutsideCoverage } from "../src/ai/coverageGuard.js";
import { SALES_FACTS } from "../src/ai/salesPlaybook.js";
import { companyInfoBlock } from "../src/ai/agencyFacts.js";
import { SCENARIO_SELL } from "../src/ai/leadQualifier.js";
import { mentionsRudakiDistrict, RUDAKI_SELLER_RULE, SERVICE_AREA_RU, SERVICE_AREA_SALES_RULE } from "../src/lib/serviceArea.js";
import { textMentionsSuburb } from "../src/lib/suburbanProperty.js";
import { missingRequestFields } from "../src/lib/telephony/liveVoiceClientTools.js";
import { PROPERTY_TOOLS, RUDAKI_VOICE_HINT } from "../src/lib/telephony/liveVoicePropertyTools.js";

/**
 * РАЗБОР ЗВОНКОВ ГОЛОСА ANNA 16.11.2026 (D:/TASKS-2026-11-14/reports/voice-anna-2026-11-16.md):
 * п. 2 — готовые «плохо слышно / хуб нашунидам» и правило «на слух»; п. 3 — «говорите по-таджикски?» → «Ҳа»;
 * п. 4 — переход на таджикский с одной твёрдой фразы; п. 5 — turn_eagerness normal; Рудаки — зона работы
 * одним источником (lib/serviceArea.ts) для чат-бота и голоса. Тесты — на КЛАСС: все варианты промта.
 */

const stranger: ConsultantCaller = { numberKnown: true, selfName: null, agentName: null, dossier: "", language: null };
const knowledge = buildLiveVoiceKnowledge({
  folkGeography: "",
  sellerRules: "",
  learnedRules: "",
  usdToTjs: null,
  wallClock: new Date("2026-11-16T10:00:00Z"),
});

/** Все промты голоса, какие собирает CRM: консультант (язык × кто набрал × замок), исходящий, чужая роль, сценарий. */
function allVoicePrompts(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const forceRussianOnly of [false, true]) {
    for (const language of [null, "ru", "tg"] as const) {
      for (const weCalled of [false, true]) {
        out.push([
          `консультант lock=${forceRussianOnly} lang=${language} weCalled=${weCalled}`,
          buildConsultantSystemPrompt({ knowledge, caller: { ...stranger, language, weCalled }, withinWorkingHours: true, forceRussianOnly }),
        ]);
      }
    }
    out.push([`исходящий lock=${forceRussianOnly}`, buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly })]);
    out.push([`чужая роль lock=${forceRussianOnly}`, buildLiveVoiceSystemPrompt(undefined, { roleOverride: "Ты звонишь клиенту.", forceRussianOnly })]);
  }
  for (const language of ["ru", "tg"] as const) {
    out.push([
      `приглашение на собеседование ${language}`,
      buildInterviewInviteCallPrompt({ candidateName: "Далер", interviewAt: new Date("2026-11-18T06:00:00Z"), address: null, language }),
    ]);
  }
  return out;
}

describe("п. 2: готовых фраз «плохо слышно / хуб нашунидам» в промтах голоса нет (класс: все промты)", () => {
  const READY_REPROMPT = /плохо слышно|нашунидам|не расслышал|як бори дигар гӯед/iu;
  it.each(allVoicePrompts())("%s", (_name, prompt) => {
    expect(prompt).not.toMatch(READY_REPROMPT);
    // «Определяй на слух» писалось под Gemini: модель ElevenLabs получает только текст.
    expect(prompt).not.toMatch(/на слух/iu);
  });

  it("правило: понял часть — отвечай по догадке или один вопрос; язык — по тексту распознавания", () => {
    expect(LIVE_VOICE_SPEECH_RULES).toContain("ПОНЯЛ ЧАСТЬ — ОТВЕЧАЙ ПО ДОГАДКЕ");
    expect(TAJIK_PHONE_SPEECH_RULES).toContain("Мехаред ё мефурӯшед?");
    const tg = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: false });
    expect(tg).toContain("ТЕКСТОМ РАСПОЗНАВАНИЯ");
  });

  it("служебная реплика разрыва петли — без запрещённых «лутфан» и «қулай»", () => {
    for (const tajikAllowed of [true, false]) {
      for (const numberKnown of [true, false]) {
        expect(poorLineBreakNote({ tajikAllowed, numberKnown })).not.toMatch(/лутфан|қулай/iu);
      }
    }
  });
});

describe("п. 3: «говорите по-таджикски?» — всегда «Ҳа», никогда «нет»", () => {
  it("без замка: в промте консультанта и исходящего есть ответ «Ҳа», запрета говорить о языках нет", () => {
    const prompts = [
      buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: false }),
      buildConsultantSystemPrompt({ knowledge, caller: { ...stranger, language: "ru" }, withinWorkingHours: true, forceRussianOnly: false }),
      buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: false }),
      buildLiveVoiceSystemPrompt(undefined, { roleOverride: "Ты звонишь клиенту.", forceRussianOnly: false }),
    ];
    for (const prompt of prompts) {
      expect(prompt).toMatch(/говорите по-таджикски\?».{0,80}«Ҳа»|говоришь ли ты по-таджикски, — «Ҳа»/u);
      expect(prompt).not.toContain("Никогда не говори, на каких языках");
      expect(prompt).not.toContain("Не говори, на каких языках ты говоришь");
    }
  });
});

describe("п. 4: переход на таджикский после одной твёрдой фразы, без ложного перехода у русскоязычных", () => {
  it("одна твёрдо таджикская фраза — сразу таджикский", () => {
    for (const line of ["Ман хона мехоҳам дар Сино", "Нархаш чанд аст ҳамин хона?", "Чӣ хел шумо ҳама нақз хоҳед?"]) {
      const t = new CallerLanguageTracker("ru");
      t.onCallerText(line);
      expect(t.language, line).toBe("tg");
    }
  });

  it("русская фраза с одним таджикским словом («рахмат», «салом», «ака») — не переключает", () => {
    for (const line of ["Рахмат, хорошо", "Салом, мне нужна двушка", "Рахмат, мне нужна квартира в Сино", "Да ака, в Сино", "Ассалому алейкум, сколько стоит?"]) {
      const t = new CallerLanguageTracker("ru");
      t.onCallerText(line);
      t.onModelTurnComplete();
      expect(t.language, line).toBe("ru");
      expect(isConfidentTajik(line), line).toBe(false);
    }
  });

  it("слабая таджикская фраза — прежний путь: две подряд", () => {
    const t = new CallerLanguageTracker("ru");
    t.onCallerText("Да ака, в Сино");
    t.onModelTurnComplete();
    expect(t.language).toBe("ru");
    expect(t.onCallerText("Хуб, ака")).toEqual({ kind: "switch", to: "tg" });
  });

  it("на русский — по-прежнему только после двух русских фраз", () => {
    const t = new CallerLanguageTracker("tg");
    expect(t.onCallerText("Мне нужна квартира в Сино")).toBeNull();
    t.onModelTurnComplete();
    expect(t.language).toBe("tg");
  });

  it("tajikWordCount: приветствия и «спасибо» не в счёт, слово с ҳ и по списку — одно слово", () => {
    expect(tajikWordCount("Рахмат, хорошо")).toBe(0);
    expect(tajikWordCount("Раҳмат, салом")).toBe(0);
    expect(tajikWordCount("мехоҳам")).toBe(1);
    expect(tajikWordCount("Ман хона мехоҳам")).toBe(3);
    expect(tajikWordCount("Ака, ака, в Сино")).toBe(1);
  });
});

describe("п. 5: ElevenLabs отвечает в обычном режиме, а не «как можно раньше»", () => {
  it("turn_eagerness normal", () => {
    expect(ELEVENLABS_PHONE_AGENT_TUNING.turn.turn_eagerness).toBe("normal");
  });
});

describe("Рудаки — зона работы (решение владельца 15.11.2026), один источник для чата и голоса", () => {
  it("отсечка чужой географии: район Рудаки — наш, Куляб — нет", () => {
    expect(detectOutsideCoverage("Хонаам дар ноҳияи Рӯдакӣ, Сомониён")).toBeNull();
    expect(detectOutsideCoverage("Дом в Рудакинском районе продаю")).toBeNull();
    expect(detectOutsideCoverage("Хона дар Кӯлоб")).not.toBeNull();
  });

  it("общие тексты обоих ботов говорят «Душанбе и район Рудаки», а не «только Душанбе»", () => {
    expect(SALES_FACTS).toContain(SERVICE_AREA_SALES_RULE);
    expect(SALES_FACTS).not.toContain("Только Душанбе");
    expect(companyInfoBlock()).toContain("район Рудаки");
    expect(SCENARIO_SELL).toContain(RUDAKI_SELLER_RULE);
  });

  it("голос получает зону в справочнике: промт консультанта знает про Рудаки", () => {
    for (const forceRussianOnly of [false, true]) {
      const prompt = buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly });
      expect(prompt).toContain(SERVICE_AREA_RU);
      expect(prompt).not.toContain("Только Душанбе");
    }
  });

  it("район Рудаки ≠ проспект Рудаки: район — «за городом», проспект — город", () => {
    for (const text of ["ноҳияи Рӯдакӣ", "н. Рудаки", "район Рудаки", "Сомониён", "Рудакинский район"]) {
      expect(mentionsRudakiDistrict(text), text).toBe(true);
      expect(textMentionsSuburb(text), text).toBe(true);
    }
    for (const text of ["пр. Рудаки 45", "проспект Рудаки", "Рӯдакӣ 177"]) {
      expect(mentionsRudakiDistrict(text), text).toBe(false);
      expect(textMentionsSuburb(text), text).toBe(false);
    }
  });

  it("робот: продавец из района Рудаки не слышит «не хватает: район» по кругу", () => {
    const base = { intent: "sell" as const, type: "HOUSE", budgetMax: 90_000, currency: "USD", timeframe: "в этом месяце" };
    expect(missingRequestFields({ ...base, notes: "район Рудаки, Сомониён" })).not.toContain("district");
    expect(missingRequestFields({ ...base, notes: "проспект Рудаки" })).toContain("district");
    expect(missingRequestFields(base)).toContain("district");
  });

  it("поиск робота: подсказка про район Рудаки в описании функции", () => {
    const search = PROPERTY_TOOLS.find((t) => t.name === "search_properties");
    const props = (search?.parameters as { properties: Record<string, { description?: string }> }).properties;
    expect(props.district.description).toContain(RUDAKI_VOICE_HINT);
    expect(props.suburban.description).toContain("район Рудаки");
  });

  // Сторож одной двери: Рудаки распознаёт и описывает только lib/serviceArea.ts.
  it("ни один модуль не держит свою копию правила о Рудаки", () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const read = (rel: string) => fs.readFileSync(path.join(src, rel), "utf8");
    expect(read("ai/coverageGuard.ts")).not.toContain("р[уӯ]да[кқ][иӣ]");
    expect(read("ai/leadQualifier.ts")).not.toContain("РАЙОН РУДАКИ (Рӯдакӣ");
    expect(read("lib/suburbanProperty.ts")).not.toMatch(/нохияи рудаки|сомониен/u);
    expect(read("ai/salesPlaybook.ts")).not.toContain("Только Душанбе");
  });
});
