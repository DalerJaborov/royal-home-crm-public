import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * РОБОТ-КОНСУЛЬТАНТ: ЯЗЫК, НАПРАВЛЕНИЕ ЗВОНКА, ОБЪЕКТЫ ТОЛЬКО ИЗ ПОДБОРКИ (08.10.2026,
 * расшифровки звонков 03.10, docs/agent-briefs/live-voice-language-direction-08-10.md).
 *
 * Три слоя:
 *  1. чистые функции и промты — без базы;
 *  2. LiveVoiceReplyGuard (сторож ответа) — без базы;
 *  3. проводка в мост (liveVoiceBridge.ts): настоящий мост, станция и Gemini подменены
 *     так же, как в live-voice-robot-reliability.test.ts.
 */

const station = vi.hoisted(() => ({ bridges: 0, hangups: [] as string[], continued: [] as string[] }));
const gem = vi.hoisted(() => ({ clients: [] as FakeGemini[] }));
interface FakeGemini {
  texts: string[];
  emit(event: string, ...args: unknown[]): boolean;
}
const logged = vi.hoisted(() => ({ items: [] as { message: string; dedupKey?: string }[] }));

vi.mock("../src/lib/telephony/ariClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/telephony/ariClient.js")>()),
  loadAriCredentials: async () => ({ url: "http://station", username: "u", password: "p" }),
  createBridge: async () => ({ ok: true, bridgeId: `br-${++station.bridges}` }),
  createExternalMediaChannel: async () => ({ ok: true, channelId: `UnicastRTP/127.0.0.1-${station.bridges}` }),
  answerChannel: async () => ({ ok: true }),
  addChannelToBridge: async () => ({ ok: true }),
  readChannelVariable: async (_c: unknown, _id: string, name: string) =>
    // Станция называет адрес звука всегда (без него мост с 09.10.2026 трубку не берёт).
    name === "UNICASTRTP_LOCAL_ADDRESS" ? "127.0.0.1" : name === "UNICASTRTP_LOCAL_PORT" ? "40997" : null,
  deleteBridge: async () => ({ ok: true }),
  hangupCall: async (_creds: unknown, channelId: string) => {
    station.hangups.push(channelId);
    return { ok: true };
  },
  continueInDialplan: async (_creds: unknown, channelId: string) => {
    station.continued.push(channelId);
    return { ok: true };
  },
  listActiveChannels: async () => [],
  playChannelSound: async () => ({ ok: true }),
}));

vi.mock("../src/ai/liveVoiceClient.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeLiveVoiceClient extends EventEmitter {
    texts: string[] = [];
    activeModel = "fake-live";
    constructor() {
      super();
      gem.clients.push(this as unknown as FakeGemini);
    }
    async connect(): Promise<void> {
      this.emit("ready");
    }
    sendText(text: string): void {
      this.texts.push(text);
    }
    sendAudioChunk(): void {}
    sendToolResponse(): void {}
    close(): void {}
  }
  return {
    ...(await importOriginal<typeof import("../src/ai/liveVoiceClient.js")>()),
    LiveVoiceClient: FakeLiveVoiceClient,
  };
});

vi.mock("../src/lib/r2Client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/r2Client.js")>()),
  isR2Configured: () => true,
  r2Upload: async () => {},
}));

vi.mock("../src/lib/systemError.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/systemError.js")>()),
  logSystemError: async (_source: string, message: string, opts?: { dedupKey?: string }) => {
    logged.items.push({ message: String(message), dedupKey: opts?.dedupKey });
  },
}));

const { prisma } = await import("../src/db.js");
const bridge = await import("../src/lib/telephony/liveVoiceBridge.js");
const { onLiveVoiceAriEvent, resetLiveVoiceAudioPathForTests } = bridge;
const { buildLiveVoiceSetupMessage, liveVoiceSpeechLanguageCode } = await import("../src/ai/liveVoiceClient.js");
const { buildConsultantSystemPrompt } = await import("../src/ai/liveVoiceConsultantPersona.js");
const {
  DEFAULT_LIVE_VOICE_PROMPT,
  LIVE_VOICE_DIRECTION_INBOUND,
  LIVE_VOICE_DIRECTION_OUTBOUND,
  buildLiveVoiceSystemPrompt,
} = await import("../src/ai/liveVoicePersona.js");
const {
  LiveVoiceReplyGuard,
  extractStreetMentions,
  findOffCatalogClaims,
  foreignLetterShare,
  isWrongLanguageReply,
  languageCorrectionText,
} = await import("../src/lib/telephony/liveVoiceGuards.js");
const { handlePropertyTool, newPropertyCallMemory } = await import("../src/lib/telephony/liveVoicePropertyTools.js");
const { waitFor } = await import("./helpers/waitFor.js");

const INBOUND_PHRASE = "Клиент позвонил нам сам";
const OUTBOUND_PHRASE = "Мы сами позвонили клиенту";

const baseInput = {
  knowledge: "<справочник>Комиссия по договорённости.</справочник>",
  caller: { numberKnown: true, selfName: null, agentName: null, dossier: "" },
  withinWorkingHours: true,
  forceRussianOnly: true,
};

describe("п.2. Направление звонка однозначно в промте", () => {
  it("входящий: есть «Клиент позвонил нам сам», нет «Мы сами позвонили клиенту»", () => {
    const prompt = buildConsultantSystemPrompt(baseInput);
    expect(prompt).toContain(INBOUND_PHRASE);
    expect(prompt).not.toContain(OUTBOUND_PHRASE);
    expect(prompt).toContain(LIVE_VOICE_DIRECTION_INBOUND);
  });

  it("исходящий (набрали мы): есть «Мы сами позвонили клиенту» и запрет говорить, что он звонил; нет фразы входящего", () => {
    const prompt = buildConsultantSystemPrompt({ ...baseInput, caller: { ...baseInput.caller, weCalled: true } });
    expect(prompt).toContain(OUTBOUND_PHRASE);
    expect(prompt).toContain("Не говори, что он нам звонил");
    expect(prompt).toContain("объясни цель звонка");
    expect(prompt).not.toContain(INBOUND_PHRASE);
    expect(prompt).toContain(LIVE_VOICE_DIRECTION_OUTBOUND);
  });

  it("звонок клиенту из карточки (роль по умолчанию + контекст) тоже несёт фразу исходящего", () => {
    const prompt = buildLiveVoiceSystemPrompt({ clientName: "Фарход" }, { forceRussianOnly: true });
    expect(DEFAULT_LIVE_VOICE_PROMPT).toContain(OUTBOUND_PHRASE);
    expect(prompt).toContain(OUTBOUND_PHRASE);
    expect(prompt).not.toContain(INBOUND_PHRASE);
  });

  it("возврат от агента и пропущенный агент остаются входящими: фраза входящего есть", () => {
    for (const reentry of ["returned", "agentMissed"] as const) {
      const prompt = buildConsultantSystemPrompt({ ...baseInput, reentry });
      expect(prompt).toContain(INBOUND_PHRASE);
      expect(prompt).not.toContain(OUTBOUND_PHRASE);
    }
  });
});

describe("п.1. Язык зафиксирован в промте и в setup", () => {
  it("русский звонок: правило «только выбранный язык», мусорная расшифровка — помеха, не просьба сменить язык", () => {
    const prompt = buildConsultantSystemPrompt(baseInput);
    expect(prompt).toContain("РАЗГОВОР ИДЁТ ТОЛЬКО НА ВЫБРАННОМ ЯЗЫКЕ");
    expect(prompt).toContain("ЯЗЫК ЭТОГО ЗВОНКА — РУССКИЙ");
    expect(prompt).toContain("никогда не переключайся");
    expect(prompt).toContain("Коротко переспроси");
  });

  it("таджикский звонок (замок снят): язык звонка — таджикский, третьего языка нет", () => {
    const prompt = buildConsultantSystemPrompt({
      ...baseInput,
      forceRussianOnly: false,
      language: "tg",
      caller: { ...baseInput.caller, language: "tg" },
    });
    expect(prompt).toContain("ЯЗЫК ЭТОГО ЗВОНКА — ТАДЖИКСКИЙ");
    expect(prompt).not.toContain("ЯЗЫК ЭТОГО ЗВОНКА — РУССКИЙ");
  });

  it("замок на русский при таджикском досье — русский (язык берётся так же, как у consultantLanguage)", () => {
    const prompt = buildConsultantSystemPrompt({ ...baseInput, caller: { ...baseInput.caller, language: "tg" } });
    expect(prompt).toContain("ЯЗЫК ЭТОГО ЗВОНКА — РУССКИЙ");
  });

  it("setup Gemini: код языка речи по умолчанию НЕ отправляется (родной звук его не поддерживает), по флагу — ru/tg", () => {
    const before = process.env.LIVE_VOICE_SPEECH_LANGUAGE_CODE;
    try {
      delete process.env.LIVE_VOICE_SPEECH_LANGUAGE_CODE;
      expect(liveVoiceSpeechLanguageCode("ru")).toBeUndefined();
      const off = buildLiveVoiceSetupMessage({ systemInstruction: "x", voiceName: "Aoede", speechLanguageCode: liveVoiceSpeechLanguageCode("ru") });
      // Только generationConfig: с 11.10.2026 в inputAudioTranscription по умолчанию есть
      // languageCodes (подсказка распознаванию) — это другое поле, не код языка речи.
      expect(JSON.stringify((off.setup as { generationConfig: unknown }).generationConfig)).not.toContain("languageCode");

      process.env.LIVE_VOICE_SPEECH_LANGUAGE_CODE = "1";
      expect(liveVoiceSpeechLanguageCode("ru")).toBe("ru");
      expect(liveVoiceSpeechLanguageCode("tg")).toBe("tg");
      const on = buildLiveVoiceSetupMessage({ systemInstruction: "x", voiceName: "Aoede", speechLanguageCode: "tg" });
      const speech = (on.setup as { generationConfig: { speechConfig: Record<string, unknown> } }).generationConfig.speechConfig;
      expect(speech.languageCode).toBe("tg");
      // Голос при этом не потерян.
      expect(JSON.stringify(speech)).toContain("Aoede");
    } finally {
      if (before === undefined) delete process.env.LIVE_VOICE_SPEECH_LANGUAGE_CODE;
      else process.env.LIVE_VOICE_SPEECH_LANGUAGE_CODE = before;
    }
  });
});

describe("п.1. Сторож языка: чистые функции", () => {
  it("немецкий и португальский ответы — чужой язык; русский с «Royal Home» и короткое «Алло» — нет", () => {
    expect(isWrongLanguageReply("Unser Büro befindet sich in Duschanbe, wir helfen Ihnen gern.")).toBe(true);
    expect(isWrongLanguageReply("Peço desculpas, não consegui entender o que disse.")).toBe(true);
    expect(isWrongLanguageReply("Royal Home, здравствуйте, слушаю вас. Чем вам помочь сегодня?")).toBe(false);
    expect(isWrongLanguageReply("Hello")).toBe(false);
    expect(isWrongLanguageReply("Да, конечно, расскажу про двухкомнатную квартиру в Сино.")).toBe(false);
    expect(isWrongLanguageReply("Салом, шумо чӣ хел ҳастед? Ман ёрдам медиҳам.")).toBe(false);
  });

  it("доля чужих букв считается по буквам, цифры и знаки не в счёт", () => {
    const { letters, share } = foreignLetterShare("Hola 123, привет!");
    expect(letters).toBe(10);
    expect(share).toBeCloseTo(0.4, 5);
  });

  it("поправка модели говорит выбранным языком и не просит читать себя вслух", () => {
    expect(languageCorrectionText("ru")).toContain("по-русски");
    expect(languageCorrectionText("tg")).toContain("по-таджикски");
    expect(languageCorrectionText("ru")).toContain("вслух не читай");
  });
});

describe("п.1. LiveVoiceReplyGuard: язык", () => {
  const german = "Unser Büro befindet sich in Duschanbe, wir helfen Ihnen gern.";

  it("первая плохая реплика: журнал + поправка, отбоя нет; куски одной реплики не плодят находок", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    expect(g.onModelText("Unser Büro")).toEqual([]); // ещё мало букв
    const found = g.onModelText(" befindet sich in Duschanbe, wir helfen Ihnen gern.");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "wrong_language", streak: 1, logIt: true, sendCorrection: true, endCall: false });
    expect(g.onModelText(" Rufen Sie uns an.")).toEqual([]);
  });

  it("вторая плохая реплика подряд: отбой, поправка второй раз не уходит, журнал не дублируется", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.onModelText(german);
    g.onTurnComplete();
    const second = g.onModelText(german);
    expect(second[0]).toMatchObject({ kind: "wrong_language", streak: 2, logIt: false, sendCorrection: false, endCall: true });
  });

  it("хорошая реплика между плохими сбрасывает «подряд»: отбоя нет, поправка не повторяется", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.onModelText(german);
    g.onTurnComplete();
    expect(g.onModelText("Простите, плохо слышно, повторите, пожалуйста.")).toEqual([]);
    g.onTurnComplete();
    const again = g.onModelText(german);
    expect(again[0]).toMatchObject({ streak: 1, endCall: false, sendCorrection: false, logIt: false });
  });

  it("перебитая реплика не считается ни хорошей, ни плохой", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.onModelText(german);
    g.onInterrupted();
    // Отдельная новая плохая реплика — это снова «подряд» (счёт не сбросился).
    expect(g.onModelText(german)[0]).toMatchObject({ streak: 2, endCall: true });
  });
});

describe("п.3. Объекты только из подборки: чистые функции", () => {
  it("улицы вытаскиваются только с заглавной буквы и со словом «улица/проспект/около…»", () => {
    expect(extractStreetMentions("Есть двушка на проспекте Рудаки и ещё на улице Бухоро, около Оригами.")).toEqual([
      "Рудаки",
      "Бухоро",
      "Оригами",
    ]);
    expect(extractStreetMentions("Это рядом, около дома и на улице, где тихо.")).toEqual([]);
  });

  it("цена, которой нет в источниках, и улица, которой нет в источниках, — находка", () => {
    const claims = findOffCatalogClaims({
      text: "Двушка на проспекте Рудаки, 60 метров, 12 этаж, 897 тыс. сомони.",
      allowedText: "",
    });
    expect(claims.prices).toContain(897_000);
    expect(claims.streets).toEqual(["Рудаки"]);
  });

  it("цена и улица из ответа функции — не находка (в том числе склонённая улица)", () => {
    const allowedText = JSON.stringify({ options: [{ where: "проспект Рудаки, Сино", price: 897000, currency: "TJS" }] });
    const claims = findOffCatalogClaims({
      text: "Есть квартира на Рудаки за 897 тысяч сомони, около проспекта Рудаки. Рядом на улице Рудаки тихо.",
      allowedText,
    });
    expect(claims).toEqual({ prices: [], streets: [], areas: [], floors: [] });
  });
});

describe("п.3. LiveVoiceReplyGuard: подборка", () => {
  const claim = "Есть двушка на проспекте Рудаки, 60 метров, 12 этаж, 897 тыс. сомони.";

  it("при пустой выдаче названные цена и улица — находка, один раз за звонок", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.addToolResult({ ok: true, found: 0, note: "ничего нет" });
    const found = g.onModelText(claim);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "off_catalog", streets: ["Рудаки"] });
    expect((found[0] as { prices: number[] }).prices).toContain(897_000);
    g.onTurnComplete();
    expect(g.onModelText(claim)).toEqual([]);
  });

  it("то же самое из ответа search_properties — молчит", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    // Форма прода (09.10.2026): цена, площадь и этаж приходят СЛОВАМИ, а не цифрами.
    g.addToolResult({
      ok: true,
      found: 1,
      options: [
        {
          number: 12,
          where: "проспект Рудаки",
          price: "восемьсот девяносто семь тысяч сомони",
          area: "шестьдесят квадратов",
          floor: "двенадцатый этаж из шестнадцати",
        },
      ],
    });
    expect(g.onModelText(claim)).toEqual([]);
  });

  it("названное самим клиентом робот повторить вправе", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.addClientText("Мне нужно на проспекте Рудаки, метров шестьдесят, этаж двенадцатый, до 897 тысяч сомони");
    expect(g.onModelText(claim)).toEqual([]);
  });

  it("курс из Настроек разрешает пересчёт: в подборке 90 000 $, робот назвал сомони по курсу", () => {
    const g = new LiveVoiceReplyGuard({ language: "ru" });
    g.usdToTjs = 10;
    g.addToolResult({ options: [{ price: 90000, currency: "USD" }] });
    expect(g.onModelText("Это примерно 900 тысяч сомони.")).toEqual([]);
  });
});

describe("п.3. Ответы поиска при пустой выдаче запрещают адреса и цены", () => {
  it("search_properties без результата и get_property «не нашли» говорят об этом прямо", async () => {
    const memory = newPropertyCallMemory({ callerPhone: "+992900000000", clientId: null });
    const empty = await handlePropertyTool(memory, {
      id: "c1",
      name: "search_properties",
      args: { district: "Сино", type: "HOUSE", rooms: 47, budget_max: 1_000_000, currency: "TJS" },
    });
    expect(empty?.response).toMatchObject({ ok: true, found: 0 });
    const note = String(empty?.response.note);
    expect(note).toContain("подходящих объектов нет");
    expect(note).toContain("не называй адреса, площади, этажи и цены");

    const missing = await handlePropertyTool(memory, {
      id: "c2",
      name: "get_property",
      args: { query: `несуществующий-ориентир-${Date.now()}` },
    });
    expect(missing?.response).toMatchObject({ ok: true, found: false });
    expect(String(missing?.response.note)).toContain("не называй адрес, площадь, этаж и цену");
  });

  it("промт консультанта несёт то же правило", () => {
    const prompt = buildConsultantSystemPrompt(baseInput);
    expect(prompt).toContain("ОБЪЕКТЫ ТОЛЬКО ИЗ ПОДБОРКИ");
    expect(prompt).toContain("не называй адреса, площади, этажи и цены");
  });
});

// ── Проводка в мост ─────────────────────────────────────────────────────────

const runId = Date.now().toString(36);
const envBefore = { host: process.env.LIVE_VOICE_RTP_HOST, port: process.env.LIVE_VOICE_RTP_PORT };
let settingsBefore: { liveVoiceEnabled: boolean; liveVoiceInboundMode: string; liveVoiceForceRussianOnly: boolean } | null = null;
let seq = 0;

function stasisStart(channelId: string) {
  return {
    type: "StasisStart",
    application: "royalhome-live-voice",
    args: ["inbound"],
    channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: { number: "931112299" } },
  };
}
function stasisEnd(channelId: string) {
  return { type: "StasisEnd", channel: { id: channelId, name: `SIP/out-${channelId}`, state: "Up", caller: {} } };
}
const messagesWith = (needle: string) => logged.items.filter((i) => i.message.includes(needle));

describe("проводка сторожей в мост", () => {
  beforeAll(async () => {
    process.env.LIVE_VOICE_RTP_HOST = "127.0.0.1";
    process.env.LIVE_VOICE_RTP_PORT = String(42000 + Math.floor(Math.random() * 900));
    settingsBefore = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { liveVoiceEnabled: true, liveVoiceInboundMode: true, liveVoiceForceRussianOnly: true },
    });
    await prisma.settings.update({
      where: { id: "singleton" },
      data: { liveVoiceEnabled: true, liveVoiceInboundMode: "always", liveVoiceForceRussianOnly: true },
    });
  });

  afterAll(async () => {
    for (const [key, value] of [
      ["LIVE_VOICE_RTP_HOST", envBefore.host],
      ["LIVE_VOICE_RTP_PORT", envBefore.port],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (settingsBefore) await prisma.settings.update({ where: { id: "singleton" }, data: settingsBefore });
    await prisma.liveVoiceSession.deleteMany({ where: { channelId: { startsWith: `lv-lang-${runId}` } } });
  });

  beforeEach(() => {
    resetLiveVoiceAudioPathForTests();
    station.hangups.length = 0;
    station.continued.length = 0;
    logged.items.length = 0;
  });

  async function startCall(tag: string) {
    seq += 1;
    const channelId = `lv-lang-${runId}-${tag}-${seq}`;
    await onLiveVoiceAriEvent(stasisStart(channelId) as never);
    return { channelId, client: gem.clients.at(-1)! };
  }

  it("ответ по-немецки: запись в журнал (один раз, постоянный ключ) и одна поправка модели; трубку не кладём", async () => {
    const { channelId, client } = await startCall("de");
    client.emit("transcript", { role: "model", text: "Unser Büro befindet sich in Duschanbe, wir helfen Ihnen gern." });
    expect(messagesWith("Робот ответил не на том языке")).toHaveLength(1);
    expect(logged.items.find((i) => i.message.includes("не на том языке"))?.dedupKey).toBe("live-voice-wrong-language");
    expect(client.texts.filter((t) => t.includes("не по-русски"))).toHaveLength(1);
    expect(station.hangups).not.toContain(channelId);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
  });

  it("вторая плохая реплика подряд: звонок завершается штатным путём эскалации («агент свяжется»)", async () => {
    const { channelId, client } = await startCall("de2");
    client.emit("transcript", { role: "model", text: "Unser Büro befindet sich in Duschanbe, wir helfen Ihnen gern." });
    client.emit("turnComplete");
    client.emit("transcript", { role: "model", text: "Peço desculpas, não consegui entender o que disse." });
    // Поправка ушла только одна, журнал — один.
    expect(client.texts.filter((t) => t.includes("не по-русски"))).toHaveLength(1);
    expect(messagesWith("Робот ответил не на том языке")).toHaveLength(1);
    await waitFor(() => station.hangups.includes(channelId) || station.continued.includes(channelId), {
      timeoutMs: 10_000,
      label: "звонок завершён сторожем языка",
    });
    const row = await waitFor(() => prisma.liveVoiceSession.findFirst({ where: { channelId, endedAt: { not: null } } }), {
      label: "сессия закрыта",
    });
    expect(row.endedReason).toContain("escalate_to_human");
    expect(row.transcript).toContain("[сторож языка]");
  });

  it("робот назвал цену и улицу при пустой подборке: журнал «вне подборки» на каждое НОВОЕ утверждение", async () => {
    const { channelId, client } = await startCall("cat");
    client.emit("transcript", { role: "model", text: "Есть двушка на улице Ломоносова, 60 метров, за 897 тыс. сомони." });
    client.emit("turnComplete");
    client.emit("transcript", { role: "model", text: "И ещё одна на улице Ломоносова за 950 тыс. сомони." });
    // С 09.10.2026 (аудит P0-1, п.4) сторож не замолкает после первой находки: вторая
    // реплика с НОВОЙ ценой — вторая находка; уже названная улица повтором не считается.
    // Текст — offCatalogLogMessage (liveVoiceGuards.ts): одна формулировка для моста и тестов.
    const hits = messagesWith("Робот назвал вне подборки");
    expect(hits).toHaveLength(2);
    expect(hits[0].message).toContain("Ломоносова");
    expect(hits[0].message).toContain("897000");
    expect(hits[1].message).toContain("950000");
    expect(hits[1].message).not.toContain("улицы/ориентиры");
    expect(logged.items.find((i) => i.message.includes("вне подборки"))?.dedupKey).toBe("live-voice-off-catalog-claim");
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
  });

  it("нормальная русская реплика без цен — сторожа молчат", async () => {
    const { channelId, client } = await startCall("ok");
    client.emit("transcript", { role: "user", text: "Алло, здравствуйте" });
    client.emit("transcript", { role: "model", text: "Royal Home, здравствуйте, слушаю вас. Что подсказать?" });
    client.emit("turnComplete");
    expect(logged.items.filter((i) => i.message.includes("Робот "))).toHaveLength(0);
    expect(client.texts.filter((t) => t.includes("Служебное"))).toHaveLength(0);
    await onLiveVoiceAriEvent(stasisEnd(channelId) as never);
  });
});
