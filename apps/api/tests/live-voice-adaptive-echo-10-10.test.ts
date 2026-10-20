import { describe, expect, it } from "vitest";

/**
 * ПОДАВЛЕНИЕ ЭХА И VAD ОТ САМОЙ ЛИНИИ (10.10.2026, docs/robot-audio-analysis-2026-10-10.md).
 * Синтетические звонки кадрами по 20 мс на 8 кГц: канал бота (что ушло в линию) и канал
 * клиента (что пришло со станции). Каждый тест падает на прежнем постоянном пороге
 * 1200 / 400 — это проверено нарочной поломкой (echoThreshold → ECHO_BARGE_IN_ENERGY,
 * vadThreshold → 400, adaptiveEchoEnabled → всегда true, оценка эха не копится).
 * Базы не нужно.
 */

const {
  LiveVoiceEchoGate,
  adaptiveEchoEnabled,
  frameEnergy,
  ECHO_BARGE_IN_ENERGY,
  ECHO_TAIL_MS,
  VAD_SPEECH_ENERGY_THRESHOLD,
} = await import("../src/lib/telephony/liveVoiceEchoGate.js");
const { detectClientSpeechEnd } = await import("../src/lib/telephony/liveVoiceBridge.js");
const { LiveVoiceMetricsTracker } = await import("../src/lib/telephony/liveVoiceMetrics.js");
const scriptMetrics = await import("../../../scripts/robot-call-metrics.mjs");

const N = 160; // 20 мс на 8 кГц
const FS = 32768;
const dbfs = (db: number) => FS * 10 ** (db / 20);

/** Детерминированный шум: одинаковые прогоны на любой машине. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Кадр «речи»: смесь двух синусов с RMS `rmsDb` дБFS, огибающая `env`. */
function speechFrame(t: number, rmsDb: number, env = 1, hz = 220): Float64Array {
  const out = new Float64Array(N);
  const a = (dbfs(rmsDb) / Math.sqrt((0.8 ** 2 + 0.2 ** 2) / 2)) * env;
  for (let i = 0; i < N; i++) {
    const k = t * N + i;
    out[i] = a * (0.8 * Math.sin((2 * Math.PI * hz * k) / 8000) + 0.2 * Math.sin((2 * Math.PI * 3.1 * hz * k) / 8000));
  }
  return out;
}

function noiseFrame(rand: () => number, rmsDb: number): Float64Array {
  const out = new Float64Array(N);
  const a = dbfs(rmsDb) * Math.sqrt(3); // равномерный шум: RMS = a/√3
  for (let i = 0; i < N; i++) out[i] = (rand() * 2 - 1) * a;
  return out;
}

function toPcm(...parts: Float64Array[]): Int16Array {
  const out = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (const p of parts) v += p[i];
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)));
  }
  return out;
}

/** Слоговая огибающая: речь не ровная, часть кадров тише. */
const syllable = (t: number, lo = 0.5) => lo + (1 - lo) * (0.5 + 0.5 * Math.sin(t * 0.9));

interface FrameSpec {
  bot: Float64Array | null;
  client: Float64Array;
  clientSpeaks: boolean;
}

interface Result {
  frames: { inTail: boolean; clientSpeaks: boolean; echo: boolean; legacyEcho: boolean; energy: number; vad: number; bargeIn: boolean }[];
  gate: InstanceType<typeof LiveVoiceEchoGate>;
}

/** Прогон звонка: пейсер отдаёт кадр бота, затем приходит кадр клиента — как в мосте. */
function run(specs: FrameSpec[], adaptive = true): Result {
  const gate = new LiveVoiceEchoGate(adaptive);
  let lastBotAt = -1;
  const frames: Result["frames"] = [];
  specs.forEach((s, t) => {
    if (s.bot) {
      const pcm = toPcm(s.bot);
      gate.onBotFrame(frameEnergy(pcm));
      lastBotAt = t;
    } else gate.onBotFrame(0);
    const ms = lastBotAt < 0 ? Number.POSITIVE_INFINITY : (t - lastBotAt) * 20;
    const d = gate.classify(toPcm(s.client), ms);
    frames.push({
      inTail: ms <= ECHO_TAIL_MS,
      clientSpeaks: s.clientSpeaks,
      echo: d.echo,
      legacyEcho: d.legacyEcho,
      energy: d.energy,
      vad: d.vadThreshold,
      bargeIn: d.bargeIn,
    });
  });
  return { frames, gate };
}

/**
 * Звонок без эха: 1,5 с тишины бота, 3 с бот говорит один, дальше циклы «бот 2 с, тишина 1 с»,
 * а клиент вступает в конце каждой реплики бота (последние 0,6 с) и говорит 1 с.
 */
function callWithoutEcho(opts: { clientDb: number; floorDb: number; envLo?: number; cycles?: number; botDb?: number }): FrameSpec[] {
  const rand = rng(42);
  const specs: FrameSpec[] = [];
  const botDb = opts.botDb ?? -20;
  const push = (bot: boolean, client: boolean) => {
    const t = specs.length;
    const noise = noiseFrame(rand, opts.floorDb);
    specs.push({
      bot: bot ? speechFrame(t, botDb, syllable(t, 0.4), 180) : null,
      client: client ? toFloat(toPcm(noise, speechFrame(t, opts.clientDb, syllable(t + 7, opts.envLo ?? 0.6), 240))) : noise,
      clientSpeaks: client,
    });
  };
  for (let i = 0; i < 75; i++) push(false, false);
  for (let i = 0; i < 150; i++) push(true, false);
  for (let c = 0; c < (opts.cycles ?? 6); c++) {
    for (let i = 0; i < 100; i++) push(true, i >= 70);
    for (let i = 0; i < 50; i++) push(false, i < 20);
  }
  return specs;
}

function toFloat(pcm: Int16Array): Float64Array {
  return Float64Array.from(pcm);
}

/** Доля кадров речи клиента ПОД ботом (в хвосте), ушедших в модель тишиной. */
function cutShare(r: Result, pick: "echo" | "legacyEcho"): number {
  const speech = r.frames.filter((f) => f.clientSpeaks && f.inTail);
  return speech.filter((f) => f[pick]).length / speech.length;
}

describe("линия без эха: речь клиента поверх бота не вырезается", () => {
  it("речь −25 дБFS поверх бота: прежнее правило режет, порог от линии — нет", () => {
    const r = run(callWithoutEcho({ clientDb: -25, floorDb: -67, envLo: 0.3 }));
    expect(cutShare(r, "legacyEcho")).toBeGreaterThan(0.2); // замер 10.10: прежнее правило резало 3–45 %
    expect(cutShare(r, "echo")).toBe(0);
    const st = r.gate.state();
    expect(st.noiseFloor).not.toBeNull();
    expect(st.echoRatioDb!).toBeLessThan(-30); // эха нет — оценка у шумового пола
    expect(st.vadThreshold).toBeLessThan(VAD_SPEECH_ENERGY_THRESHOLD);
  });

  it("тихий абонент −40 дБFS при сигнал/шум 23 дБ: не вырезается и виден VAD", () => {
    // Слоги не тише −3 дБ от среднего: порог шума 8 × пол = 18 дБ над полом.
    const r = run(callWithoutEcho({ clientDb: -40, floorDb: -63, envLo: 0.7 }));
    expect(cutShare(r, "legacyEcho")).toBe(1); // весь тише 1200
    expect(cutShare(r, "echo")).toBeLessThanOrEqual(0.02);
    const late = r.frames.slice(225).filter((f) => f.clientSpeaks);
    // Прежний VAD (400) такого человека не слышал вовсе; новый слышит почти всю речь.
    expect(late.filter((f) => f.energy >= VAD_SPEECH_ENERGY_THRESHOLD)).toHaveLength(0);
    expect(late.filter((f) => !f.echo && f.energy >= f.vad).length / late.length).toBeGreaterThan(0.9);
  });

  it("начало реплики под концом фразы бота сохраняется (первые 150 мс)", () => {
    const rand = rng(7);
    const specs = callWithoutEcho({ clientDb: -25, floorDb: -67, cycles: 2 });
    // Ещё одна реплика бота, клиент вступает под её конец с нарастанием голоса.
    const onsetAt = specs.length + 80;
    for (let i = 0; i < 100; i++) {
      const t = specs.length;
      const talking = i >= 80;
      const env = talking ? Math.min(1, 0.25 + (i - 80) * 0.15) : 0;
      const noise = noiseFrame(rand, -67);
      specs.push({
        bot: speechFrame(t, -20, syllable(t, 0.4), 180),
        client: talking ? toFloat(toPcm(noise, speechFrame(t, -25, env, 240))) : noise,
        clientSpeaks: talking,
      });
    }
    const r = run(specs);
    const onset = r.frames.slice(onsetAt, onsetAt + 8);
    expect(onset.some((f) => f.legacyEcho)).toBe(true); // прежнее правило съедало начало
    expect(onset.filter((f) => f.echo)).toHaveLength(0);
  });
});

describe("эховая линия: эхо бота глушится", () => {
  /** Канал клиента = голос бота −7 дБ с задержкой 60 мс + пол −48 дБFS (звонки 08–09.10);
   *  бот громкий (−14 дБFS), поэтому эхо местами громче прежних 1200. */
  function echoCall(): FrameSpec[] {
    const rand = rng(99);
    const bot: (Float64Array | null)[] = [];
    for (let i = 0; i < 75; i++) bot.push(null);
    for (let c = 0; c < 8; c++) {
      for (let i = 0; i < 150; i++) bot.push(speechFrame(bot.length, -14, syllable(bot.length, 0.4), 180));
      for (let i = 0; i < 50; i++) bot.push(null);
    }
    const gain = 10 ** (-7 / 20);
    return bot.map((b, t) => {
      const delayed = bot[t - 3] ?? null;
      const echo = delayed ? delayed.map((v) => v * gain) : new Float64Array(N);
      return { bot: b, client: toFloat(toPcm(noiseFrame(rand, -48), echo)), clientSpeaks: false };
    });
  }

  it("оценка эха −7 дБ: после разгона в модель уходит тишина почти на всё эхо", () => {
    const r = run(echoCall());
    // После первых двух реплик бота (оценка доверенная) — эхо, громче порога VAD.
    const loudEcho = r.frames.slice(500).filter((f) => f.inTail && f.energy >= f.vad);
    expect(loudEcho.length).toBeGreaterThan(300);
    expect(loudEcho.filter((f) => f.echo).length / loudEcho.length).toBeGreaterThan(0.97);
    // Прежний порог 1200 громкое эхо пропускал в модель — бот перебивал сам себя.
    expect(loudEcho.filter((f) => f.legacyEcho).length / loudEcho.length).toBeLessThan(0.9);
    expect(r.frames.slice(500).filter((f) => f.inTail && f.bargeIn)).toHaveLength(0);
    const st = r.gate.state();
    expect(st.echoRatioDb!).toBeGreaterThan(-14);
    expect(st.echoRatioDb!).toBeLessThan(-3);
  });

  it("безопасный старт: пока оценка не доверенная, порог не выше прежних 1200", () => {
    const r = run(echoCall().slice(0, 75 + 60));
    const tail = r.frames.filter((f) => f.inTail);
    expect(tail.length).toBeGreaterThan(0);
    // Ни одного решения строже прежнего: то, что прежнее правило пропускало, пропущено.
    for (const f of tail) if (!f.legacyEcho) expect(f.echo).toBe(false);
  });
});

describe("безопасный старт и выключатель", () => {
  it("пол не набран — пороги прежние: 1200 и 400", () => {
    const gate = new LiveVoiceEchoGate(true);
    gate.onBotFrame(3000);
    expect(gate.echoThreshold()).toBe(ECHO_BARGE_IN_ENERGY);
    expect(gate.vadThreshold()).toBe(VAD_SPEECH_ENERGY_THRESHOLD);
    const quiet = toPcm(speechFrame(0, -40));
    const d = gate.classify(quiet, 0);
    expect(d.echo).toBe(true);
    expect(d.legacyEcho).toBe(true);
  });

  it("LIVE_VOICE_ADAPTIVE_ECHO=0 — решения ровно как у прежнего правила", () => {
    expect(adaptiveEchoEnabled({})).toBe(true);
    expect(adaptiveEchoEnabled({ LIVE_VOICE_ADAPTIVE_ECHO: "1" })).toBe(true);
    expect(adaptiveEchoEnabled({ LIVE_VOICE_ADAPTIVE_ECHO: "0" })).toBe(false);
    const r = run(callWithoutEcho({ clientDb: -25, floorDb: -67, envLo: 0.3 }), adaptiveEchoEnabled({ LIVE_VOICE_ADAPTIVE_ECHO: "0" }));
    for (const f of r.frames) {
      expect(f.echo).toBe(f.legacyEcho);
      expect(f.vad).toBe(VAD_SPEECH_ENERGY_THRESHOLD);
      expect(f.bargeIn).toBe(!f.echo && f.energy >= ECHO_BARGE_IN_ENERGY);
    }
    expect(cutShare(r, "echo")).toBeGreaterThan(0.2);
    expect(r.gate.state()).toMatchObject({ echoAdaptive: false, echoThreshold: ECHO_BARGE_IN_ENERGY, vadThreshold: 400 });
  });
});

describe("локальный VAD берёт порог от линии", () => {
  it("detectClientSpeechEnd: тихая речь видна при пороге от пола, не видна при 400", () => {
    const quiet = new Int16Array(N).fill(200);
    const silent = new Int16Array(N);
    const seen = (threshold?: number) => {
      const state = { speaking: false, silenceStreak: 0 };
      detectClientSpeechEnd(quiet, state, threshold);
      let ended = false;
      for (let i = 0; i < 4; i++) ended = detectClientSpeechEnd(silent, state, threshold) || ended;
      return ended;
    };
    expect(seen()).toBe(false);
    expect(seen(120)).toBe(true);
  });
});

describe("замеры: эхо в строке [метрики]", () => {
  it("кадры тишиной, вырезанная речь, прежнее правило и пороги — в снимке и в разборе", () => {
    const t = new LiveVoiceMetricsTracker(0);
    t.onEchoDecision({ echo: true, legacyEcho: true, energy: 500, vadThreshold: 100 }); // громкое — «речь»
    t.onEchoDecision({ echo: true, legacyEcho: true, energy: 50, vadThreshold: 100 });
    t.onEchoDecision({ echo: false, legacyEcho: true, energy: 900, vadThreshold: 100 });
    t.onEchoDecision({ echo: false, legacyEcho: false, energy: 900, vadThreshold: 100 });
    const gate = new LiveVoiceEchoGate(true);
    const m = t.snapshot(gate.state());
    expect(m).toMatchObject({ echoFrames: 2, echoSpeechFrames: 1, echoFramesLegacy: 3, echoAdaptive: true, vadThreshold: 400, noiseFloor: null });
    expect(t.snapshot().echoAdaptive).toBeNull();
    const line = scriptMetrics.formatCallMetrics(m);
    expect(line).toContain("эхо 2 кадр. (речь 1, по-старому 3)");
    expect(line).toContain("от линии");
    const s = scriptMetrics.summarizeCallMetrics([m, { ...m, echoFrames: 5 }]);
    expect(s).toMatchObject({ echoFrames: 7, echoSpeechFrames: 2, echoFramesLegacy: 6 });
    expect(scriptMetrics.formatSummary(s)).toContain("прежнее правило заглушило бы 6");
  });
});
