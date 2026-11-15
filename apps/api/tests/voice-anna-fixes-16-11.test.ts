import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildConsultantSystemPrompt, type ConsultantCaller } from "../src/ai/liveVoiceConsultantPersona.js";
import { buildLiveVoiceSystemPrompt, LIVE_VOICE_SPEECH_RULES } from "../src/ai/liveVoicePersona.js";
import { TAJIK_PHONE_SPEECH_RULES } from "../src/ai/tajikPhoneSpeech.js";
import { buildInterviewInviteCallPrompt } from "../src/ai/interviewInviteCallPersona.js";
import { buildLiveVoiceKnowledge } from "../src/ai/liveVoiceKnowledge.js";

import { asksToSpeakTajik, CallerLanguageTracker, callerLanguageSwitchNote, isConfidentTajik, tajikWordCount } from "../src/lib/telephony/liveVoiceCallerLanguage.js";
import { isRepromptReply, poorLineBreakNote } from "../src/lib/telephony/liveVoicePoorLine.js";
import { ELEVENLABS_PHONE_AGENT_TUNING } from "../src/ai/elevenLabsAgentSync.js";
import { detectOutsideCoverage } from "../src/ai/coverageGuard.js";
import { SALES_FACTS } from "../src/ai/salesPlaybook.js";
import { companyInfoBlock } from "../src/ai/agencyFacts.js";
import { SCENARIO_SELL } from "../src/ai/leadQualifier.js";
import { BOT_DISTRICT_NAMES, submitReplyLeadSchema } from "@royal-home/shared";
import { districtListForPrompt, districtPickAllowed, mentionsRudakiDistrict, stripRudakiDistrictWords, RUDAKI_DISTRICT_NAME, RUDAKI_SELLER_RULE, SERVICE_AREA_RU, SERVICE_AREA_SALES_RULE } from "../src/lib/serviceArea.js";
import { isRudakiProperty, isSuburbanProperty, propertyOutsideServiceArea, queryOutsideServiceArea, textMentionsSuburb } from "../src/lib/suburbanProperty.js";
import { SUBURB_SEARCH_REFUSAL, SUBURBS_OWNER_WORDS } from "../src/lib/serviceArea.js";
import { missingRequestFields, sanitizeClientRequest } from "../src/lib/telephony/liveVoiceClientTools.js";
import { resolveDistrict } from "../src/routes/webhooks.js";
import { geoMatchKey } from "../src/lib/geoNormalize.js";
import { officialDistrictIn } from "../src/lib/searchPlace.js";
import { PROPERTY_TOOLS, RUDAKI_VOICE_HINT, voiceDistrictFromModel } from "../src/lib/telephony/liveVoicePropertyTools.js";

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

  it("сторож петли узнаёт таджикские переспросы, которые модель может сочинить сама (ревью #204, С1)", () => {
    for (const line of ["Бубахшед, боз гӯед?", "Боз як маротиба гӯед", "Чӣ гуфтед?", "Чи гуфтед?", "Як маротиба дигар гӯед", "Дубора гӯед, бубахшед", "Ещё раз, пожалуйста?"]) {
      expect(isRepromptReply(line), line).toBe(true);
    }
    expect(isRepromptReply("Хона дар Сино ҳаст, сеҳуҷрагӣ")).toBe(false);
  });

  it("догадку не записывать: перед показом, заявкой и звонком — вопрос «да/нет» (ревью #204, С2)", () => {
    for (const [, prompt] of allVoicePrompts().filter(([name]) => !name.startsWith("приглашение"))) {
      expect(prompt).toMatch(/ДОГАДКУ НЕ ЗАПИСЫВАЙ|понял только по догадке/u);
    }
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

  it("русская фраза с таджикскими обращениями и поддакиваниями («ака», «хуб», «бале», «майлаш») — не переключает (ревью #204, В1)", () => {
    for (const line of [
      "Рахмат, хорошо", "Салом, мне нужна двушка", "Рахмат, мне нужна квартира в Сино", "Да ака, в Сино", "Ассалому алейкум, сколько стоит?",
      "Ака хуб, давайте в Сино", "Мне двушку, ака, бисёр лозим", "Бале, бале, дорам", "Хуб, ака, майлаш",
    ]) {
      const t = new CallerLanguageTracker("ru");
      t.onCallerText(line);
      t.onModelTurnComplete();
      expect(t.language, line).toBe("ru");
      expect(isConfidentTajik(line), line).toBe(false);
    }
  });

  it("твёрдая таджикская фраза без русских слов — переключает", () => {
    const t = new CallerLanguageTracker("ru");
    expect(t.onCallerText("Хона дорам, мефурӯшам")).toEqual({ kind: "switch", to: "tg" });
  });

  it("одни поддакивания — не довод: даже две подряд русского звонящего не уводят на таджикский", () => {
    const t = new CallerLanguageTracker("ru");
    for (const line of ["Хуб, ака", "Бале, майлаш", "Ака хуб"]) {
      expect(t.onCallerText(line), line).toBeNull();
      t.onModelTurnComplete();
    }
    expect(t.language).toBe("ru");
  });

  it("слабая таджикская фраза (одно содержательное слово) — прежний путь: две подряд", () => {
    const t = new CallerLanguageTracker("ru");
    expect(t.onCallerText("Хона в Сино")).toBeNull();
    t.onModelTurnComplete();
    expect(t.language).toBe("ru");
    expect(t.onCallerText("Ака, хона дар Сино")).toEqual({ kind: "switch", to: "tg" });
  });

  it("на русский — по-прежнему только после двух русских фраз", () => {
    const t = new CallerLanguageTracker("tg");
    expect(t.onCallerText("Мне нужна квартира в Сино")).toBeNull();
    t.onModelTurnComplete();
    expect(t.language).toBe("tg");
    expect(t.onCallerText("Сколько стоит двушка, скажите")).toEqual({ kind: "switch", to: "ru" });
  });

  it("«Вы говорите по-таджикски?» на любом языке — сразу таджикский вместе с распознаванием (ревью #204, В2)", () => {
    for (const line of ["Вы говорите по-таджикски?", "А на таджикском можно?", "Можно по-таджикски?", "Таджикский понимаете?", "Знаете таджикский?", "Мама понимает только по-таджикски, можно с ней?", "Тоҷикӣ медонед?", "Бо тоҷикӣ гап мезанед?", "Забони тоҷикиро медонед?"]) {
      expect(asksToSpeakTajik(line), line).toBe(true);
      const t = new CallerLanguageTracker("ru");
      expect(t.onCallerText(line), line).toEqual({ kind: "switch", to: "tg", askedForTajik: true });
      expect(t.language).toBe("tg");
    }
    // Повторное ревью #204, Н-2: отрицание, неспособность и просьба о документе — не просьба говорить по-таджикски.
    for (const line of [
      "Я не говорю по-таджикски", "Не говорите по-таджикски, давайте по-русски", "Вы по-таджикски или по-русски?", "Мне нужна квартира",
      "Я не могу говорить по-таджикски", "Мне сложно говорить по-таджикски", "Я плохо умею говорить по-таджикски",
      "Можете прислать таджикский вариант договора?", "Вы можете по-таджикски или по-русски?",
    ]) {
      expect(asksToSpeakTajik(line), line).toBe(false);
    }
    // Пометка для ElevenLabs: «Ҳа» и вызов language_detection — распознавание переключается вместе с речью.
    const note = callerLanguageSwitchNote("tg", { languageTool: true, askedForTajik: true });
    expect(note).toContain("«Ҳа»");
    expect(note).toContain('language_detection с language "tg"');
  });

  it("с замком «только русский» правила «Ҳа» в промте нет (ревью #204, Н1)", () => {
    for (const prompt of [
      buildConsultantSystemPrompt({ knowledge, caller: stranger, withinWorkingHours: true, forceRussianOnly: true }),
      buildLiveVoiceSystemPrompt(undefined, { forceRussianOnly: true }),
      buildLiveVoiceSystemPrompt(undefined, { roleOverride: "Ты звонишь клиенту.", forceRussianOnly: true }),
    ]) {
      expect(prompt).not.toContain("«Ҳа»");
    }
  });

  it("tajikWordCount: приветствия и «спасибо» не в счёт, слово с ҳ и по списку — одно слово", () => {
    expect(tajikWordCount("Рахмат, хорошо")).toBe(0);
    expect(tajikWordCount("Раҳмат, салом")).toBe(0);
    expect(tajikWordCount("мехоҳам")).toBe(1);
    expect(tajikWordCount("Ман хона мехоҳам")).toBe(3);
    expect(tajikWordCount("Хона, хона, в Сино")).toBe(1);
    expect(tajikWordCount("Ака хуб, бале, майлаш")).toBe(0);
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

  it("Рудаки — район в справочнике: робот, чат-бот и схема ответа его принимают (ревью #204, С3)", () => {
    expect(BOT_DISTRICT_NAMES).toContain(RUDAKI_DISTRICT_NAME);
    expect(RUDAKI_DISTRICT_NAME).toBe("Рудаки (район)");
    expect(submitReplyLeadSchema.safeParse({ districtName: RUDAKI_DISTRICT_NAME }).success).toBe(true);
    const said = "Клиент: Ҳавлӣ дар ноҳияи Рӯдакӣ мефурӯшам";
    expect(sanitizeClientRequest({ intent: "sell", district: RUDAKI_DISTRICT_NAME }, said).districtName).toBe(RUDAKI_DISTRICT_NAME);
    // Повторное ревью #204, Н-3: «квартира на Рудаки» без слова «район» — проспект, район от модели не принимается.
    expect(sanitizeClientRequest({ intent: "buy", district: RUDAKI_DISTRICT_NAME }, "Клиент: Двушку на Рудаки хочу").districtName).toBeUndefined();
    expect(sanitizeClientRequest({ intent: "buy", district: RUDAKI_DISTRICT_NAME }).districtName).toBeUndefined();
    expect(voiceDistrictFromModel("Рудаки", said)).toBeNull(); // старое имя без «(район)» в перечне не существует
    expect(voiceDistrictFromModel("Сино", "Клиент: Двушку на Рудаки хочу")).toBe("Сино");
    // Модель написала «район Рудаки» в notes, а не в district — район всё равно ставится, «не хватает: район» нет.
    const fromNotes = sanitizeClientRequest({ intent: "sell", type: "HOUSE", budget_max: 90_000, currency: "USD", timeframe: "скоро", notes: "район Рудаки, Сомониён" }, said);
    expect(fromNotes.districtName).toBe(RUDAKI_DISTRICT_NAME);
    expect(missingRequestFields(fromNotes)).not.toContain("district");
    expect(sanitizeClientRequest({ intent: "sell", notes: "проспект Рудаки" }).districtName).toBeUndefined();
  });

  it("«район Рудаки» — район, а не проспект Рудаки; адрес «пр. Рудаки» в Рудаки не попадает", () => {
    expect(mentionsRudakiDistrict("Рудаки, район")).toBe(true);
    expect(mentionsRudakiDistrict("мкр-н Рудаки")).toBe(false);
    expect(mentionsRudakiDistrict("Рудаки (район)")).toBe(true);
    // Повторное ревью #204, Н-1: проспект или улица Рудаки и другой район города рядом — не район Рудаки.
    for (const address of ["пр. Рудаки, район Сино", "Шохмансур район, Рудаки 30", "ул. Рудаки, районе Фирдавси"]) {
      expect(mentionsRudakiDistrict(address), address).toBe(false);
      expect(textMentionsSuburb(address), address).toBe(false);
      expect(stripRudakiDistrictWords(geoMatchKey(address)), address).toBe(geoMatchKey(address));
    }
    const districts = [{ id: "rud", name: RUDAKI_DISTRICT_NAME }, { id: "sino", name: "Сино" }];
    expect(resolveDistrict("Сино, пр. Рудаки 45", districts)).toEqual({ id: "sino", matched: true });
    expect(resolveDistrict("ноҳияи Рӯдакӣ, Сомониён", districts)).toEqual({ id: "rud", matched: true });
    expect(officialDistrictIn("район Рудаки")).toBeNull(); // официальные районы города — без Рудаки
    expect(districtPickAllowed(RUDAKI_DISTRICT_NAME, "пр. Рудаки 45")).toBe(false);
    expect(districtPickAllowed(RUDAKI_DISTRICT_NAME, "Сомониён, ҳавлӣ")).toBe(true);
    expect(districtListForPrompt(BOT_DISTRICT_NAMES)).toContain("проспект и улица Рудаки в Душанбе — НЕ этот район");
  });

  it("объект района Рудаки — за городом и «рудакинский» даже без слов в тексте; объект города — нет", () => {
    expect(isSuburbanProperty({ title: "Ҳавлӣ", district: { name: RUDAKI_DISTRICT_NAME } })).toBe(true);
    expect(isRudakiProperty({ title: "Ҳавлӣ", district: { name: RUDAKI_DISTRICT_NAME } })).toBe(true);
    expect(isRudakiProperty({ title: "Дача в Варзобе", district: { name: "Сино" } })).toBe(false);
    expect(isRudakiProperty({ address: "ноҳияи Рӯдакӣ, Сомониён", district: { name: "Шохмансур" } })).toBe(true);
    expect(isSuburbanProperty({ address: "пр. Рудаки 45", district: { name: "Сино" } })).toBe(false);
  });

  it("поиск робота: подсказка про район Рудаки в описании функции", () => {
    const search = PROPERTY_TOOLS.find((t) => t.name === "search_properties");
    const props = (search?.parameters as { properties: Record<string, { description?: string }> }).properties;
    expect(props.district.description).toContain(RUDAKI_VOICE_HINT);
    expect(props.suburban.description).toContain("районе Рудаки");
  });

  // Решение владельца 16.11.2026 по С5: «Загород не берём, только Душанбе». Рудаки — зона (15.11).
  it("пригороды (Вахдат, Варзоб, Гиссар, дачи) — не зона: не предлагаем, не ищем, продавцу и покупателю — зона и предложение", () => {
    expect(SUBURBS_OWNER_WORDS).toBe("Загород не берём, только Душанбе");
    // Объекты: загород не в Рудаки — вне зоны; Рудаки и город — в зоне.
    for (const p of [{ title: "Дача в Варзобе" }, { address: "Вахдат, кишлак" }, { title: "Ҳавлӣ, Гиссар" }, { landmark: "12 км" }]) {
      expect(propertyOutsideServiceArea(p), JSON.stringify(p)).toBe(true);
    }
    for (const p of [{ address: "ноҳияи Рӯдакӣ, Сомониён" }, { title: "Ҳавлӣ", district: { name: RUDAKI_DISTRICT_NAME } }, { address: "пр. Рудаки 45" }]) {
      expect(propertyOutsideServiceArea(p), JSON.stringify(p)).toBe(false);
    }
    // Запросы: «дача в Варзобе» — не ищем; «район Рудаки» — ищем.
    expect(queryOutsideServiceArea({ suburban: true, districtName: null })).toBe(true);
    expect(queryOutsideServiceArea({ suburban: true, districtName: RUDAKI_DISTRICT_NAME })).toBe(false);
    expect(queryOutsideServiceArea({ suburban: false, districtName: "Сино" })).toBe(false);
    // Отсечка: дача в Варзобе больше не исключение; Рудаки — зона.
    expect(detectOutsideCoverage("Дача дар Варзоб, 10 сотих, лаби дарё")).not.toBeNull();
    expect(detectOutsideCoverage("Хона дар Ваҳдат мехарам")).not.toBeNull();
    expect(detectOutsideCoverage("Ҳавлӣ дар ноҳияи Рӯдакӣ")).toBeNull();
    // Тексты: правило пригородов — в общем справочнике обоих ботов и робота; функция поиска робота не зовёт пригороды.
    expect(SALES_FACTS).toContain("ПРИГОРОДЫ — НЕ НАША ЗОНА");
    expect(SUBURB_SEARCH_REFUSAL).toContain("только Душанбе и район Рудаки");
    const search = PROPERTY_TOOLS.find((tool) => tool.name === "search_properties");
    const suburbanDescription = (search?.parameters as { properties: Record<string, { description?: string }> }).properties.suburban.description ?? "";
    expect(suburbanDescription).toContain("не наша зона");
  });

  // Сторож одной двери (ревью #204, С4): фраза о зоне «только Душанбе» и копии правила о Рудаки — только в
  // lib/serviceArea.ts. Проходит по ВСЕМУ src, а не по списку файлов: копия в новом файле тоже красная.
  it("ни один модуль не держит свою копию зоны работы или правила о Рудаки", () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "generated") walk(full); }
        else if (e.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(src);
    const ZONE = /только\s+(?:по|в)\s+(?:городе\s+)?Душанбе(?!\s+и\s+район)|Только Душанбе|танҳо\s+дар\s+Душанбе(?!\s+ва\s+ноҳия)|работаем по Душанбе(?!\s+и\s+район)|дар Душанбе кор мекунем|другие города не обслуживаем\)|р\[уӯ\]да\[кқ\]\[иӣ\]|нохияи рудаки/u;
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join("lib", "serviceArea.ts"))) continue;
      fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const code = line.trim();
        if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return; // комментарии — история, не текст клиенту
        if (ZONE.test(line)) offenders.push(`${path.relative(src, file)}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
