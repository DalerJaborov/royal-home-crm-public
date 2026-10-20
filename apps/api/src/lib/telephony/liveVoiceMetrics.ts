/**
 * ЗАМЕРЫ ЗВОНКА РОБОТА (09.10.2026, docs/robot-upgrade-speed-understanding-2026-10-09.md,
 * п.1 плана и П8 «нет приборов»). Без них любое «стало быстрее» — на слух.
 *
 * Что меряется (всё по часам процесса, в миллисекундах):
 *  - readyMs     — подъём: от начала сессии (StasisStart) до готовности модели (setupComplete);
 *  - answerMs    — от начала сессии до снятия трубки;
 *  - firstWordMs — от снятия трубки до первого кадра речи бота в линии (то, что слышит человек);
 *  - turnGapsMs  — пауза хода: конец реплики клиента (локальный VAD моста) → первый кадр
 *                  ответа в линии. Конец реплики — последний громкий кадр (VAD видит его
 *                  через VAD_SILENCE_HANGOVER кадров тишины, мост передаёт уже поправленное
 *                  время). Если включён «вдох», первым кадром ответа считается он;
 *  - bargeIns    — клиент заговорил поверх бота (громкий кадр, не эхо, пока речь бота в линии);
 *  - talkOverMs  — на каждое такое перебивание: сколько бот ещё говорил после его начала;
 *  - interrupted — событий `interrupted` от модели; localBargeIns — хвостов, сброшенных мостом;
 *  - echoFrames  — кадров клиента, ушедших в модель тишиной как эхо бота;
 *  - echoSpeechFrames — из них громче порога VAD: «вырезанная речь» (на линии без эха —
 *                  потерянные слова клиента, на эховой — громкое эхо);
 *  - echoFramesLegacy — сколько кадров заглушило бы прежнее правило (1200 / 250 мс):
 *                  сравнение «до/после» на одном и том же звонке;
 *  - echoAdaptive, echoThreshold, vadThreshold, noiseFloor, echoRatioDb — пороги на конец
 *                  звонка (liveVoiceEchoGate.ts, 10.10.2026).
 *
 * Где лежит: строкой «[метрики] {json}» в конце расшифровки LiveVoiceSession (без
 * миграции схемы; людям на экране строка не показывается, см. mergeTranscriptFragments)
 * и строкой в лог API. Читает scripts/robot-call-metrics.mjs.
 *
 * ГОРЯЧИЙ ПУТЬ: методы зовутся из каждого кадра звука — только присваивания и счётчики,
 * без исключений и без await.
 */
import { LIVE_VOICE_METRICS_LINE_PREFIX } from "@royal-home/shared";
import type { EchoGateDecision, EchoGateState } from "./liveVoiceEchoGate.js";

/** Версия формата строки — поднимать при несовместимой правке полей. */
export const LIVE_VOICE_METRICS_VERSION = 1;
/** Потолок длины списков за звонок: строка расшифровки не должна разрастаться. */
const LIST_CAP = 200;

export interface LiveVoiceCallMetrics {
  v: number;
  readyMs: number | null;
  answerMs: number | null;
  firstWordMs: number | null;
  turnGapsMs: number[];
  bargeIns: number;
  talkOverMs: number[];
  interrupted: number;
  localBargeIns: number;
  echoFrames: number;
  echoSpeechFrames: number;
  echoFramesLegacy: number;
  echoAdaptive: boolean | null;
  echoThreshold: number | null;
  vadThreshold: number | null;
  noiseFloor: number | null;
  echoRatioDb: number | null;
}

export class LiveVoiceMetricsTracker {
  private modelReadyAt: number | null = null;
  private answeredAt: number | null = null;
  private firstWordAt: number | null = null;
  private readonly turnGaps: number[] = [];
  private readonly talkOver: number[] = [];
  private pendingSpeechEndAt: number | null = null;
  private bargeInAt: number | null = null;
  private bargeIns = 0;
  private interrupted = 0;
  private localBargeIns = 0;
  private echoFrames = 0;
  private echoSpeechFrames = 0;
  private echoFramesLegacy = 0;
  /** Речь бота сейчас в линии (пейсер отдал кадр речи, а не тишину). */
  botOnLine = false;

  constructor(readonly startedAt: number) {}

  markModelReady(at: number): void {
    if (this.modelReadyAt === null) this.modelReadyAt = at;
  }

  markAnswered(at: number): void {
    if (this.answeredAt === null) this.answeredAt = at;
  }

  /** Пейсер отдал в линию кадр речи бота. */
  onBotFrame(at: number): void {
    if (this.botOnLine) return;
    this.botOnLine = true;
    if (this.firstWordAt === null) this.firstWordAt = at;
    if (this.pendingSpeechEndAt !== null) {
      push(this.turnGaps, at - this.pendingSpeechEndAt);
      this.pendingSpeechEndAt = null;
    }
  }

  /** Пейсер отдал тишину: речь бота в линии кончилась (доиграла или сброшена). */
  onBotSilence(at: number): void {
    if (!this.botOnLine) return;
    this.botOnLine = false;
    if (this.bargeInAt !== null) {
      push(this.talkOver, at - this.bargeInAt);
      this.bargeInAt = null;
    }
  }

  /** Локальный VAD: клиент договорил; `at` — время последнего громкого кадра. */
  onClientSpeechEnd(at: number): void {
    this.pendingSpeechEndAt = at;
  }

  /** Громкий кадр клиента, не эхо бота. */
  onClientLoudFrame(at: number): void {
    // Человек заговорил снова — прежний «конец реплики» уже не конец.
    this.pendingSpeechEndAt = null;
    if (this.botOnLine && this.bargeInAt === null) {
      this.bargeIns += 1;
      this.bargeInAt = at;
    }
  }

  /** Решение подавления эха по кадру клиента (LiveVoiceEchoGate.classify). */
  onEchoDecision(d: Pick<EchoGateDecision, "echo" | "legacyEcho" | "energy" | "vadThreshold">): void {
    if (d.legacyEcho) this.echoFramesLegacy += 1;
    if (!d.echo) return;
    this.echoFrames += 1;
    if (d.energy >= d.vadThreshold) this.echoSpeechFrames += 1;
  }

  onModelInterrupted(): void {
    this.interrupted += 1;
  }

  onLocalBargeIn(): void {
    this.localBargeIns += 1;
  }

  snapshot(gate?: EchoGateState): LiveVoiceCallMetrics {
    const since = (at: number | null, from: number | null) => (at === null || from === null ? null : Math.max(0, Math.round(at - from)));
    return {
      v: LIVE_VOICE_METRICS_VERSION,
      readyMs: since(this.modelReadyAt, this.startedAt),
      answerMs: since(this.answeredAt, this.startedAt),
      firstWordMs: since(this.firstWordAt, this.answeredAt),
      turnGapsMs: this.turnGaps.map((v) => Math.max(0, Math.round(v))),
      bargeIns: this.bargeIns,
      talkOverMs: this.talkOver.map((v) => Math.max(0, Math.round(v))),
      interrupted: this.interrupted,
      localBargeIns: this.localBargeIns,
      echoFrames: this.echoFrames,
      echoSpeechFrames: this.echoSpeechFrames,
      echoFramesLegacy: this.echoFramesLegacy,
      echoAdaptive: gate?.echoAdaptive ?? null,
      echoThreshold: gate?.echoThreshold ?? null,
      vadThreshold: gate?.vadThreshold ?? null,
      noiseFloor: gate?.noiseFloor ?? null,
      echoRatioDb: gate?.echoRatioDb ?? null,
    };
  }
}

function push(list: number[], value: number): void {
  if (list.length < LIST_CAP) list.push(value);
}

/** Строка для расшифровки: «[метрики] {json}» — формат читает scripts/robot-call-metrics.mjs. */
export function formatLiveVoiceMetricsLine(metrics: LiveVoiceCallMetrics): string {
  return `${LIVE_VOICE_METRICS_LINE_PREFIX}${JSON.stringify(metrics)}`;
}
