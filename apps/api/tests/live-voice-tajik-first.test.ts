import { describe, expect, it } from "vitest";

/**
 * ТАДЖИКСКИЙ В ПРИОРИТЕТЕ И РАЗРЫВ ПЕТЛИ «ПЛОХО СЛЫШНО» (10.10.2026, разбор реальных звонков
 * робота-консультанта и замер записей, docs/journal/2026-10-10-robot-tajik-first.md).
 *
 * Расшифровки ниже — обезличенные формы того, что распознавание выдало на таджикскую и
 * русскую речь по телефону: арабская вязь («урду»), латиница с турецкими ş ğ ı, смесь
 * испанского с итальянским, немецкий и португальский на РУССКУЮ речь владельца (тестовый
 * звонок 15:59). Расшифровка Live ненадёжна в обе стороны: мусор — не сигнал языка. Чистая логика, без базы и сети; врезка в мост проверяется в
 * live-voice-line-reliability-09-10.test.ts.
 */

const {
  CallerLanguageTracker,
  CALLER_LANGUAGE_QUESTION,
  callerLanguageAskNote,
  callerLanguageSwitchNote,
  classifyCallerUtterance,
  createCallerLanguageTracker,
  liveTranscriptUnreliable,
  reliableCallerText,
} = await import("../src/lib/telephony/liveVoiceCallerLanguage.js");
const {
  isRepromptReply,
  PoorLineTracker,
  poorLineBreakNote,
  poorLineCallbackNote,
  poorLineTranscriptLine,
  POOR_LINE_CALLBACK_RU,
  POOR_LINE_CALLBACK_TG,
} = await import("../src/lib/telephony/liveVoicePoorLine.js");
const { LiveVoiceReplyGuard } = await import("../src/lib/telephony/liveVoiceGuards.js");
const persona = await import("../src/ai/liveVoiceConsultantPersona.js");
const { LIVE_VOICE_SPEECH_RULES, LIVE_VOICE_LANGUAGE_NOTE } = await import("../src/ai/liveVoicePersona.js");
const { consultantLanguage } = await import("../src/lib/telephony/liveVoiceConsultant.js");
const { noSpeechPromptTrigger } = await import("../src/lib/telephony/liveVoiceBridge.js");

/** Обезличенные формы расшифровок из звонков 10.10. */
const URDU = "میں آپ کو بتا رہا ہوں گھر چاہیے سینو میں";
const TURKISH_LATIN = "Şu an bir ev arıyorum, iki oda, Sino tarafında değil mi";
const SPANISH_ITALIAN = "Hola quiero una casa per favore molto bene grazie";
const DEVANAGARI = "मैं घर चाहता हूँ";
/** Так встроенная расшифровка записала РУССКУЮ речь владельца 10.10 15:59. */
const OWNER_RU_AS_GERMAN = "Was hast du denn heute am 20 Uhr";
const OWNER_RU_AS_PORTUGUESE = "Não, é para o próximo mês";
const RUSSIAN_1 = "Мне нужна квартира в Сино";
const RUSSIAN_2 = "Сколько стоит двушка, скажите";
const TAJIK = "Ман хона мехоҳам дар Сино";

describe("язык реплики звонящего: мусор — не сигнал, таджикская запись латиницей/арабицей — таджикский", () => {
  it("кириллица: русская и таджикская реплики уверенные, «Алло» — нет", () => {
    expect(classifyCallerUtterance(RUSSIAN_1)).toBe("ru");
    expect(classifyCallerUtterance(TAJIK)).toBe("tg");
    expect(classifyCallerUtterance("Алло")).toBe("unclear");
    // Одно русское слово-заимствование таджикская речь тоже содержит — не повод.
    expect(classifyCallerUtterance("Квартира")).toBe("unclear");
  });

  it("любой мусор не кириллицей — неясно: ни таджикский, ни русский (урду, ş ğ ı, немецкий/португальский на русскую речь)", () => {
    for (const garbage of [URDU, TURKISH_LATIN, SPANISH_ITALIAN, DEVANAGARI, OWNER_RU_AS_GERMAN, OWNER_RU_AS_PORTUGUESE]) {
      expect(classifyCallerUtterance(garbage)).toBe("unclear");
    }
  });
});

/** Прогнать реплики звонящего через трекер (каждая — отдельный ход). */
function feed(tracker: InstanceType<typeof CallerLanguageTracker>, lines: string[]) {
  const actions = [];
  for (const line of lines) {
    const a = tracker.onCallerText(line);
    if (a) actions.push(a);
    const b = tracker.onModelTurnComplete();
    if (b) actions.push(b);
  }
  return actions;
}

describe("гистерезис языка звонка", () => {
  it("мусор на урду и испанском — язык не переключается; после трёх неясных — только вопрос о языке", () => {
    const t = new CallerLanguageTracker("tg");
    expect(feed(t, [URDU, SPANISH_ITALIAN, URDU, TURKISH_LATIN])).toEqual([{ kind: "ask" }]);
    expect(t.language).toBe("tg");
    expect(t.knownLanguage).toBeNull();
  });

  it("одна русская реплика — не переключение; две подряд — переключение на русский", () => {
    const t = new CallerLanguageTracker("tg");
    expect(feed(t, [RUSSIAN_1])).toEqual([]);
    expect(t.language).toBe("tg");
    expect(feed(t, [RUSSIAN_2])).toEqual([{ kind: "switch", to: "ru" }]);
    expect(t.language).toBe("ru");
  });

  it("мусор между русскими репликами — ни за, ни против; таджикская между ними — сбрасывает счёт", () => {
    const a = new CallerLanguageTracker("tg");
    expect(feed(a, [RUSSIAN_1, SPANISH_ITALIAN, RUSSIAN_2])).toEqual([{ kind: "switch", to: "ru" }]);
    const b = new CallerLanguageTracker("tg");
    expect(feed(b, [RUSSIAN_1, TAJIK, RUSSIAN_2])).toEqual([]);
    expect(b.language).toBe("tg");
  });

  it("с русского на таджикский — тоже после двух кириллических реплик; арабская запись — не в счёт", () => {
    const t = new CallerLanguageTracker("ru");
    expect(feed(t, [URDU, TAJIK])).toEqual([]);
    expect(feed(t, ["Нархаш чанд аст ҳамин хона?"])).toEqual([{ kind: "switch", to: "tg" }]);
  });

  it("звонок владельца 15:59: русская речь, записанная немецким и португальским, — язык не меняется и не определяется", () => {
    const t = new CallerLanguageTracker("tg");
    expect(feed(t, [OWNER_RU_AS_GERMAN, OWNER_RU_AS_PORTUGUESE])).toEqual([]);
    expect(t.language).toBe("tg");
    expect(t.knownLanguage).toBeNull();
  });

  it("язык так и не ясен три реплики — один раз спросить; уверенная реплика раньше — не спрашивать", () => {
    const t = new CallerLanguageTracker("tg");
    expect(feed(t, [SPANISH_ITALIAN, DEVANAGARI])).toEqual([]);
    expect(feed(t, [SPANISH_ITALIAN])).toEqual([{ kind: "ask" }]);
    expect(feed(t, [SPANISH_ITALIAN, SPANISH_ITALIAN])).toEqual([]);
    const known = new CallerLanguageTracker("tg");
    expect(feed(known, [TAJIK, SPANISH_ITALIAN, SPANISH_ITALIAN, SPANISH_ITALIAN])).toEqual([]);
  });

  it("ход модели без реплики звонящего (приветствие) — не неясная реплика", () => {
    const t = new CallerLanguageTracker("tg");
    for (let i = 0; i < 5; i++) expect(t.onModelTurnComplete()).toBeNull();
  });

  it("служебные реплики: переход и вопрос о языке — таджикский первым", () => {
    expect(callerLanguageSwitchNote("ru")).toContain("по-русски");
    expect(callerLanguageSwitchNote("tg")).toContain("по-таджикски");
    expect(CALLER_LANGUAGE_QUESTION.indexOf("тоҷикӣ")).toBeLessThan(CALLER_LANGUAGE_QUESTION.indexOf("таджикском"));
    expect(callerLanguageAskNote()).toContain(CALLER_LANGUAGE_QUESTION);
    expect(callerLanguageAskNote()).toContain("Не говори, что плохо слышно");
  });

  it("замок «только русский» — трекера нет (свой путь: извинение и человек)", () => {
    expect(createCallerLanguageTracker(true, "ru")).toBeNull();
    expect(createCallerLanguageTracker(false, "tg")).not.toBeNull();
  });
});

describe("язык по умолчанию — таджикский, приветствие — таджикское слово первым", () => {
  const voices = { liveVoiceForceRussianOnly: false };
  it("consultantLanguage: незнакомец без замка — таджикский; досье «ru» — русский; замок — русский", () => {
    expect(consultantLanguage(voices, null)).toBe("tg");
    expect(consultantLanguage(voices, "tg")).toBe("tg");
    expect(consultantLanguage(voices, "ru")).toBe("ru");
    expect(consultantLanguage({ liveVoiceForceRussianOnly: true }, null)).toBe("ru");
    expect(consultantLanguage({ liveVoiceForceRussianOnly: true }, "tg")).toBe("ru");
    expect(consultantLanguage(null, null)).toBe("ru");
  });

  it("служебная реплика-старт незнакомцу: «Ассалому алайкум» раньше «здравствуйте»; замок — без изменений", () => {
    const lang = persona.consultantGreetingLanguage(false, null);
    expect(lang).toBe("tg-first");
    const trigger = persona.withGreetingLanguage(persona.CONSULTANT_GREETING_TRIGGER, lang);
    expect(trigger.indexOf("Ассалому алайкум")).toBeGreaterThan(-1);
    expect(trigger.indexOf("Ассалому алайкум")).toBeLessThan(trigger.toLowerCase().indexOf("здравствуйте"));
    expect(trigger).toContain("на двух языках");
    expect(trigger.endsWith(")")).toBe(true);
    const locked = persona.consultantGreetingLanguage(true, null);
    expect(persona.withGreetingLanguage(persona.CONSULTANT_GREETING_TRIGGER, locked)).toBe(persona.CONSULTANT_GREETING_TRIGGER);
    expect(persona.withGreetingLanguage(persona.CONSULTANT_GREETING_TRIGGER, persona.consultantGreetingLanguage(false, "tg"))).toContain("гӯш мекунам");
    expect(persona.consultantGreetingLanguage(false, "ru")).toBe("ru");
  });

  it("промт незнакомцу без замка: язык звонка таджикский, образец приветствия — таджикское слово первым", () => {
    const prompt = persona.buildConsultantSystemPrompt({
      knowledge: "",
      caller: { numberKnown: true, selfName: null, agentName: null, dossier: "", language: null },
      withinWorkingHours: true,
      forceRussianOnly: false,
    });
    // Язык незнакомца не известен: двуязычное приветствие, дальше — на слух, не по расшифровке.
    expect(prompt).toContain("ЯЗЫК ЗВОНЯЩЕГО ПОКА НЕ ИЗВЕСТЕН");
    expect(prompt).not.toContain("ЯЗЫК ЭТОГО ЗВОНКА — ТАДЖИКСКИЙ");
    expect(prompt).toContain("определяй НА СЛУХ, по звуку его речи, а не по тексту расшифровки");
    expect(prompt).toContain("Слышишь русскую речь — отвечай по-русски сразу");
    expect(prompt).toContain("«Тоҷикӣ ё русӣ?»");
    expect(prompt).toContain("«Плохо слышно» не говори, если разобрал хоть часть");
    const greeting = prompt.slice(prompt.indexOf("КАК БРАТЬ ТРУБКУ")).toLowerCase();
    expect(greeting.indexOf("ассалому алайкум")).toBeLessThan(greeting.indexOf("здравствуйте"));
    // Таджикская речь, принятая распознаванием за персидскую/турецкую, — не помеха.
    expect(prompt).toContain("персидский");
    expect(prompt).toContain("турецкий");
    expect(prompt).not.toContain("Простите, плохо слышно — повторите");
  });

  it("с замком промт как раньше: русский, «плохо слышно» как образец переспроса", () => {
    const prompt = persona.buildConsultantSystemPrompt({
      knowledge: "",
      caller: { numberKnown: true, selfName: null, agentName: null, dossier: "", language: null },
      withinWorkingHours: true,
      forceRussianOnly: true,
    });
    expect(prompt).toContain("ЯЗЫК ЭТОГО ЗВОНКА — РУССКИЙ");
    expect(prompt).not.toContain("Ассалому");
    expect(prompt).toContain("ГОВОРИ ТОЛЬКО ПО-РУССКИ");
  });

  it("общие правила: переспрос не больше раза подряд и двух за звонок; «не знаешь — по-русски» больше не правило", () => {
    expect(LIVE_VOICE_SPEECH_RULES).toContain("не больше ОДНОГО раза подряд и не больше двух раз за звонок");
    expect(LIVE_VOICE_SPEECH_RULES).not.toContain("не знаешь — по-русски.");
    expect(LIVE_VOICE_LANGUAGE_NOTE).toContain("определяй на слух, по звуку речи, а не по тексту расшифровки");
  });

  it("сторож тишины без замка: таджикский вопрос первым; с замком — только русский", () => {
    const both = noSpeechPromptTrigger(false);
    expect(both.indexOf("шумо маро мешунавед")).toBeLessThan(both.indexOf("вы меня слышите"));
    expect(noSpeechPromptTrigger(true)).not.toContain("шумо");
  });
});

describe("сторож выхода: только русский и таджикский, но без отбоя из-за персидской записи", () => {
  const PERSIAN = "سلام، من یک خانه خوب در سینو دارم برای شما";
  it("без замка: робот «по-таджикски» в арабской записи дважды — находка и поправка, но трубку не кладём", () => {
    const g = new LiveVoiceReplyGuard({ language: "tg", tajikAllowed: true });
    const first = g.onModelText(PERSIAN);
    g.onTurnComplete();
    const second = g.onModelText(PERSIAN);
    expect(first[0]).toMatchObject({ kind: "wrong_language", sendCorrection: true, endCall: false });
    expect(second[0]).toMatchObject({ kind: "wrong_language", endCall: false });
  });

  it("без замка: немецкий дважды — по-прежнему отбой (пропускаем только русский и таджикский)", () => {
    const g = new LiveVoiceReplyGuard({ language: "tg", tajikAllowed: true });
    g.onModelText("Unser Büro befindet sich in Duschanbe, wir helfen Ihnen gern.");
    g.onTurnComplete();
    expect(g.onModelText("Wir haben viele Wohnungen in Duschanbe für Sie.")[0]).toMatchObject({ kind: "wrong_language", endCall: true });
  });

  it("с замком: арабская запись дважды — отбой, как раньше", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.onModelText(PERSIAN);
    g.onTurnComplete();
    expect(g.onModelText(PERSIAN)[0]).toMatchObject({ kind: "wrong_language", endCall: true });
  });
});

describe("разрыв петли «плохо слышно / повторите»", () => {
  it("переспрос узнаётся по-русски и по-таджикски; ответ по делу — не переспрос", () => {
    expect(isRepromptReply("Простите, плохо слышно, повторите, пожалуйста?")).toBe(true);
    expect(isRepromptReply("Алло, прервалось…")).toBe(true);
    expect(isRepromptReply("Не расслышала, ещё раз?")).toBe(true);
    expect(isRepromptReply("Бубахшед, як бори дигар гӯед?")).toBe(true);
    expect(isRepromptReply("Есть одна двушка в Сино, по цене как раз. Хотите, расскажу подробнее?")).toBe(false);
  });

  /** Ходы: «r» — робот переспросил, «a» — ответил по делу. */
  function robot(t: InstanceType<typeof PoorLineTracker>, kind: "r" | "a") {
    t.onModelText(kind === "r" ? "Простите, плохо слышно, повторите?" : "Есть двушка в Сино, по цене как раз подходит под ваш бюджет.");
    t.onModelTurnComplete();
  }

  it("мусор в расшифровке сам по себе счётчик «плохо слышно» не растит: робот отвечает по делу — ничего не происходит", () => {
    const t = new PoorLineTracker();
    for (const garbage of [OWNER_RU_AS_GERMAN, OWNER_RU_AS_PORTUGUESE, URDU, SPANISH_ITALIAN]) {
      expect(t.onCallerText(garbage, false)).toBeNull();
      robot(t, "a");
    }
    expect(t.onCallerText(OWNER_RU_AS_GERMAN, false)).toBeNull();
  });

  it("переспрос после реплики, записанной чистой кириллицей, — не неудача линии (речь была разборчивой)", () => {
    const t = new PoorLineTracker();
    for (let i = 0; i < 3; i++) {
      expect(t.onCallerText(RUSSIAN_1, true)).toBeNull();
      robot(t, "r");
    }
    expect(t.onCallerText(RUSSIAN_2, true)).toBeNull();
  });

  it("два переспроса подряд, язык ясен — на третьей реплике звонящего перезвон, а не «повторите»", () => {
    const t = new PoorLineTracker();
    expect(t.onCallerText(URDU, true)).toBeNull();
    robot(t, "r");
    expect(t.onCallerText(URDU, true)).toBeNull();
    robot(t, "r");
    expect(t.onCallerText(URDU, true)).toBe("callback");
    // Один раз за звонок.
    robot(t, "r");
    expect(t.onCallerText(URDU, true)).toBeNull();
  });

  it("язык не ясен: после двух переспросов — вопрос о языке, после третьего — перезвон", () => {
    const t = new PoorLineTracker();
    robot(t, "r");
    robot(t, "r");
    expect(t.onCallerText(SPANISH_ITALIAN, false)).toBe("ask");
    robot(t, "a"); // вопрос о языке — не переспрос
    expect(t.onCallerText(SPANISH_ITALIAN, false)).toBeNull();
    robot(t, "r");
    expect(t.onCallerText(SPANISH_ITALIAN, false)).toBe("callback");
  });

  it("переспросы вразбивку: два за звонок — терпим, третий — перезвон", () => {
    const t = new PoorLineTracker();
    robot(t, "r");
    robot(t, "a");
    robot(t, "r");
    robot(t, "a");
    expect(t.onCallerText(SPANISH_ITALIAN, true)).toBeNull();
    robot(t, "r");
    expect(t.onCallerText(SPANISH_ITALIAN, true)).toBe("callback");
  });

  it("служебная реплика перезвона: таджикская фраза первой, вопрос «удобно сейчас?», перевод к человеку, без отбоя первым", () => {
    const note = poorLineBreakNote({ tajikAllowed: true, numberKnown: true });
    expect(note.indexOf(POOR_LINE_CALLBACK_TG)).toBeGreaterThan(-1);
    expect(note.indexOf(POOR_LINE_CALLBACK_TG)).toBeLessThan(note.indexOf(POOR_LINE_CALLBACK_RU));
    expect(note).toContain("удобно");
    expect(note).toContain("transfer_to_agent");
    expect(note).toContain("Трубку первым не клади");
    expect(note).toContain("Повторить больше НЕ проси");
    const locked = poorLineBreakNote({ tajikAllowed: false, numberKnown: true });
    expect(locked).toContain(POOR_LINE_CALLBACK_RU);
    expect(locked).not.toMatch(/[ҳҷӣӯқғ]/u);
    expect(poorLineBreakNote({ tajikAllowed: true, numberKnown: false })).not.toContain(POOR_LINE_CALLBACK_RU);
  });

  it("расшифровка с мусором — пометка «сверить основным распознаванием»; язык в досье — только по кириллице", () => {
    const owner = ["Бот: Ассалому алейкум! Здравствуйте, Royal Home", `Клиент: ${OWNER_RU_AS_GERMAN}`, `Клиент: ${OWNER_RU_AS_PORTUGUESE}`];
    expect(liveTranscriptUnreliable(owner)).toBe(true);
    expect(reliableCallerText(owner)).toBe("");
    const clean = ["Бот: Алло", `Клиент: ${RUSSIAN_1}`];
    expect(liveTranscriptUnreliable(clean)).toBe(false);
    expect(reliableCallerText([...clean, `Клиент: ${URDU}`])).toBe(RUSSIAN_1);
  });

  it("строка расшифровки → пометка задачи «плохая слышимость, язык …»", () => {
    const line = poorLineTranscriptLine("tg");
    expect(poorLineCallbackNote(["Бот: Алло", line])).toBe("плохая слышимость, язык: таджикский");
    expect(poorLineCallbackNote(["Бот: Алло", poorLineTranscriptLine(null)])).toBe("плохая слышимость, язык: не определён");
    expect(poorLineCallbackNote(["Бот: Алло"])).toBeNull();
  });
});
