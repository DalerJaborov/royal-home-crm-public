/**
 * Замеры звонка робота из расшифровки LiveVoiceSession (09.10.2026). Мост пишет в конец
 * расшифровки строку «[метрики] {json}» (apps/api/src/lib/telephony/liveVoiceMetrics.ts,
 * префикс — LIVE_VOICE_METRICS_LINE_PREFIX в packages/shared/src/transcript.ts; совпадение
 * сверяет тест apps/api/tests/live-voice-speed-understanding-09-10.test.ts).
 * Чистые функции: их зовёт scripts/robot-calls-review.mjs.
 */

export const METRICS_LINE_PREFIX = "[метрики] ";

/** Замеры звонка или null (звонок до 09.10, строка повреждена). */
export function parseCallMetrics(transcript) {
  if (typeof transcript !== "string") return null;
  const lines = transcript.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trimStart();
    if (!line.startsWith(METRICS_LINE_PREFIX)) continue;
    try {
      const m = JSON.parse(line.slice(METRICS_LINE_PREFIX.length));
      return m && typeof m === "object" ? m : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Расшифровка без строки замеров — для печати разговора. */
export function stripCallMetrics(transcript) {
  return String(transcript ?? "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith(METRICS_LINE_PREFIX))
    .join("\n");
}

const sec = (ms) => (ms == null ? "—" : `${(ms / 1000).toFixed(2)} с`);

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

const mean = (xs) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Одна строка замеров звонка для печати. */
export function formatCallMetrics(m) {
  if (!m) return "замеров нет (звонок до 09.10.2026)";
  const gaps = Array.isArray(m.turnGapsMs) ? m.turnGapsMs : [];
  return [
    `подъём ${sec(m.readyMs)}`,
    `трубка ${sec(m.answerMs)}`,
    `первое слово ${sec(m.firstWordMs)}`,
    `пауза хода ср ${sec(mean(gaps))} (n=${gaps.length})`,
    `перебиваний ${m.bargeIns ?? 0}`,
    `сброшено хвостов ${m.localBargeIns ?? 0}`,
    `interrupted ${m.interrupted ?? 0}`,
    formatEchoMetrics(m),
  ].join(" | ");
}

/**
 * Подавление эха (10.10.2026, liveVoiceEchoGate.ts): сколько кадров ушло в модель тишиной,
 * сколько из них громче порога VAD («вырезанная речь»), сколько заглушило бы прежнее
 * правило 1200 / 250 мс, и пороги на конец звонка. У звонков до 10.10 полей нет.
 */
export function formatEchoMetrics(m) {
  const frames = `эхо ${m.echoFrames ?? 0} кадр. (речь ${m.echoSpeechFrames ?? "—"}, по-старому ${m.echoFramesLegacy ?? "—"})`;
  if (m.echoAdaptive == null) return frames;
  const mode = m.echoAdaptive ? "от линии" : "постоянный (LIVE_VOICE_ADAPTIVE_ECHO=0)";
  const db = m.echoRatioDb == null ? "—" : `${m.echoRatioDb} дБ`;
  return `${frames}, порог ${m.echoThreshold ?? "—"} ${mode}, VAD ${m.vadThreshold ?? "—"}, пол ${m.noiseFloor ?? "—"}, оценка эха ${db}`;
}

/**
 * Сводка по выборке. «% перебиваний, где бот замолк быстро» — доля перебиваний, после
 * начала которых бот говорил не дольше 300 мс (цель исследования ≥ 90 %).
 */
export function summarizeCallMetrics(list) {
  const ms = list.filter(Boolean);
  const gaps = ms.flatMap((m) => (Array.isArray(m.turnGapsMs) ? m.turnGapsMs : [])).sort((a, b) => a - b);
  const talkOver = ms.flatMap((m) => (Array.isArray(m.talkOverMs) ? m.talkOverMs : []));
  const firstWords = ms.map((m) => m.firstWordMs).filter((v) => typeof v === "number");
  const ready = ms.map((m) => m.readyMs).filter((v) => typeof v === "number");
  const turns = gaps.length;
  const bargeIns = ms.reduce((a, m) => a + (m.bargeIns ?? 0), 0);
  const sum = (key) => ms.reduce((a, m) => a + (typeof m[key] === "number" ? m[key] : 0), 0);
  return {
    calls: ms.length,
    readyAvgMs: mean(ready),
    firstWordAvgMs: mean(firstWords),
    turnGapAvgMs: mean(gaps),
    turnGapP50Ms: percentile(gaps, 50),
    turnGapP90Ms: percentile(gaps, 90),
    turns,
    bargeIns,
    bargeInPerTurnPct: turns > 0 ? (bargeIns / turns) * 100 : null,
    bargeInQuickStopPct: talkOver.length > 0 ? (talkOver.filter((v) => v <= 300).length / talkOver.length) * 100 : null,
    echoFrames: sum("echoFrames"),
    echoSpeechFrames: sum("echoSpeechFrames"),
    echoFramesLegacy: sum("echoFramesLegacy"),
  };
}

export function formatSummary(s) {
  if (s.calls === 0) return "Замеров нет ни у одного звонка выборки.";
  const pct = (v) => (v == null ? "—" : `${Math.round(v)} %`);
  return [
    `Звонков с замерами: ${s.calls}`,
    `подъём ср ${sec(s.readyAvgMs)}; первое слово ср ${sec(s.firstWordAvgMs)}`,
    `пауза хода: ср ${sec(s.turnGapAvgMs)}, p50 ${sec(s.turnGapP50Ms)}, p90 ${sec(s.turnGapP90Ms)} (ходов ${s.turns})`,
    `перебиваний ${s.bargeIns} (${pct(s.bargeInPerTurnPct)} от ходов); бот замолк ≤ 0,3 с: ${pct(s.bargeInQuickStopPct)}`,
    `эхо: в модель тишиной ${s.echoFrames ?? 0} кадр., из них громче VAD ${s.echoSpeechFrames ?? 0}; прежнее правило заглушило бы ${s.echoFramesLegacy ?? 0}`,
  ].join("\n");
}
