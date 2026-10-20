/**
 * ПОДАВЛЕНИЕ ЭХА И ЛОКАЛЬНЫЙ VAD РОБОТА — ПОРОГИ ОТ САМОЙ ЛИНИИ (10.10.2026).
 *
 * ЗАЧЕМ. Сотовая линия может вернуть часть голоса бота в канал звонящего; серверный
 * VAD Gemini принимает это за речь собеседника и бот перебивает сам себя (24.09.2026).
 * Защита была постоянной: пока бот говорит и ещё ECHO_TAIL_MS, кадр клиента тише
 * ECHO_BARGE_IN_ENERGY (1200) уходит в модель тишиной.
 *
 * ЗАМЕР НА ЖИВЫХ ЗАПИСЯХ (docs/robot-audio-analysis-2026-10-10.md): 1200 — это СРЕДНЯЯ
 * громкость нормальной речи. На пяти звонках 10.10 эха нет вовсе (−44…−51 дБ, ниже
 * шумового пола), а постоянный порог вырезал 3–11 % речи клиента (у таджикского звонка
 * 3,7 с, 14 из 34 реплик без первых ~150 мс), на звонках 02.10 — 34 % и 45 %. Локальный
 * VAD (400) не видел 26–30 % речи, у тихого абонента — 65 %.
 *
 * ПРАВИЛО. Кадр клиента в хвосте речи бота глушится, только если он тише
 *   порог = max(нижняя граница, ECHO_MARGIN × оценка эха × громкость бота за ECHO_TAIL_MS)
 *   нижняя граница = min(1200, max(60, 8 × шумовой пол))
 * - громкость бота — наибольшая энергия кадров, ушедших в линию за последние ECHO_TAIL_MS
 *   (опорный сигнал: сколько эха МОЖЕТ сейчас прийти);
 * - оценка эха — медиана отношения «энергия канала клиента / громкость бота» по кадрам,
 *   где бот говорит. Клиент говорит поверх бота меньшую часть времени (на записях 10.10 —
 *   до 16 %), и медиана такие кадры отбрасывает: она и есть «клиент заведомо молчит»;
 * - шумовой пол — скользящий 10-й процентиль энергии клиента, пока бот молчит.
 * На тех же записях правило не вырезает ничего; на «эховой» линии 08–09.10 (пол
 * −48 дБFS, эхо −7 дБ) глушит эхо, как задумано.
 *
 * Локальный VAD (конец реплики, сторож тишины, перебивание) — от того же пола:
 * clamp(8 × пол, 80, 400).
 *
 * БЕЗОПАСНЫЙ СТАРТ. Пока пол не набран (1 с тишины бота) или эха не набралось
 * (0,5 с речи бота), пороги прежние: 1200 и 400. Пока речи бота меньше 2 с, порог
 * эха не поднимается выше прежних 1200: ранняя оценка, испорченная человеком,
 * говорящим поверх приветствия, не заглушит его сильнее, чем раньше.
 *
 * ВЫКЛЮЧАТЕЛЬ на случай эхо-петли на живой линии: LIVE_VOICE_ADAPTIVE_ECHO=0 —
 * прежние постоянные пороги. По умолчанию правило включено.
 *
 * ГОРЯЧИЙ ПУТЬ: зовётся на каждый кадр 20 мс в обе стороны — только арифметика и
 * кольцевые буферы, сортировка окна раз в несколько кадров.
 */

/** Хвост после последнего кадра речи бота, в который ещё глушится эхо. */
export const ECHO_TAIL_MS = 250;
/** Прежний постоянный порог подавления эха (и порог при безопасном старте). */
export const ECHO_BARGE_IN_ENERGY = 1200;
/** Прежний постоянный порог локального VAD (и порог при безопасном старте). */
export const VAD_SPEECH_ENERGY_THRESHOLD = 400;

/** Запас над оценкой эха: эхо глушится, пока клиент не громче его в 4 раза (12 дБ). */
export const ECHO_MARGIN = 4;
/** Порог подавления не ниже 8 × пол (18 дБ над шумом) и не ниже ECHO_MIN_ENERGY. */
export const ECHO_FLOOR_FACTOR = 8;
export const ECHO_MIN_ENERGY = 60;
/** Потолок порога подавления: громкий человек (≈ −18 дБFS и громче) перебивает всегда. */
export const ECHO_MAX_ENERGY = 4000;
/** Локальный VAD: 8 × пол, в пределах [80, 400]. */
export const VAD_FLOOR_FACTOR = 8;
export const VAD_MIN_ENERGY = 80;

const FRAME_MS = 20;
/** Кадров бота в окне опорного сигнала (ECHO_TAIL_MS). */
const REF_FRAMES = Math.ceil(ECHO_TAIL_MS / FRAME_MS) + 1;
/** Бот «говорит» для оценки эха, если его кадр в окне не тише этого. */
const BOT_REF_MIN_ENERGY = 300;
/** Окно оценки эха: последние 5 с речи бота. */
const ECHO_WINDOW = 250;
/** Оценке эха верим после 0,5 с речи бота… */
const ECHO_READY_FRAMES = 25;
/** …а поднимать порог выше прежних 1200 позволяем только после 2 с. */
const ECHO_TRUSTED_FRAMES = 100;
/** Окно шумового пола: последние 10 с тишины бота. */
const NOISE_WINDOW = 500;
/** Полу верим после 1 с тишины бота. */
const NOISE_READY_FRAMES = 50;
const NOISE_PERCENTILE = 0.1;
/** Как часто пересчитывать медиану и процентиль (кадров). */
const ECHO_RECALC_EVERY = 10;
const NOISE_RECALC_EVERY = 25;

/** Средняя абсолютная амплитуда кадра — единая мера энергии для эха и VAD. */
export function frameEnergy(frame: Int16Array): number {
  let sumAbs = 0;
  for (let i = 0; i < frame.length; i++) sumAbs += Math.abs(frame[i]);
  return frame.length > 0 ? sumAbs / frame.length : 0;
}

/** Прежнее правило с постоянным порогом: глушить ли кадр звонящего. */
export function shouldSuppressAsEcho(frame: Int16Array, msSinceBotAudio: number, threshold = ECHO_BARGE_IN_ENERGY): boolean {
  if (msSinceBotAudio > ECHO_TAIL_MS) return false;
  return frameEnergy(frame) < threshold;
}

/** Адаптивные пороги включены, если LIVE_VOICE_ADAPTIVE_ECHO не равен "0". */
export function adaptiveEchoEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE_VOICE_ADAPTIVE_ECHO !== "0";
}

export interface EchoGateDecision {
  energy: number;
  /** Кадр уходит в модель тишиной как эхо бота. */
  echo: boolean;
  /** Прежнее правило (1200 / ECHO_TAIL_MS) заглушило бы этот кадр — для сравнения в замерах. */
  legacyEcho: boolean;
  /** Порог локального VAD для этого кадра. */
  vadThreshold: number;
  /** Человек говорит: не эхо и громче порога VAD. */
  speech: boolean;
  /** Достаточно громко, чтобы сбросить недоигранный хвост бота (LOCAL_BARGE_IN_FRAMES). */
  bargeIn: boolean;
}

export interface EchoGateState {
  echoAdaptive: boolean;
  /** Порог подавления на последнем кадре в хвосте речи бота; null — бот ещё не говорил. */
  echoThreshold: number | null;
  vadThreshold: number;
  /** Шумовой пол (энергия кадра); null — ещё не набран. */
  noiseFloor: number | null;
  /** Оценка эха, дБ (20·lg отношения энергий); null — ещё не набрана. */
  echoRatioDb: number | null;
}

/** Кольцевой буфер чисел с пересчётом квантиля раз в `every` записей. */
class RollingQuantile {
  private readonly ring: Float64Array;
  private readonly scratch: Float64Array;
  private next = 0;
  private filled = 0;
  private sinceRecalc = 0;
  /** Сколько значений записано за всё время (не только в окне). */
  total = 0;
  value: number | null = null;

  constructor(size: number, private readonly q: number, private readonly every: number, private readonly readyAt: number) {
    this.ring = new Float64Array(size);
    this.scratch = new Float64Array(size);
  }

  push(v: number): void {
    this.ring[this.next] = v;
    this.next = (this.next + 1) % this.ring.length;
    if (this.filled < this.ring.length) this.filled += 1;
    this.total += 1;
    this.sinceRecalc += 1;
    if (this.filled < this.readyAt) return;
    if (this.value !== null && this.sinceRecalc < this.every) return;
    this.sinceRecalc = 0;
    const view = this.scratch.subarray(0, this.filled);
    view.set(this.ring.subarray(0, this.filled));
    view.sort();
    this.value = view[Math.min(this.filled - 1, Math.floor(this.q * this.filled))];
  }
}

export class LiveVoiceEchoGate {
  readonly adaptive: boolean;
  /** Энергия кадров, отданных пейсером в линию (речь бота или 0), за ECHO_TAIL_MS. */
  private readonly botRef = new Float64Array(REF_FRAMES);
  private botRefNext = 0;
  private readonly noise = new RollingQuantile(NOISE_WINDOW, NOISE_PERCENTILE, NOISE_RECALC_EVERY, NOISE_READY_FRAMES);
  private readonly echoRatio = new RollingQuantile(ECHO_WINDOW, 0.5, ECHO_RECALC_EVERY, ECHO_READY_FRAMES);
  private lastEchoThreshold: number | null = null;

  constructor(adaptive: boolean = adaptiveEchoEnabled()) {
    this.adaptive = adaptive;
  }

  /** Пейсер отдал кадр в линию: энергия речи бота или 0 (пауза/фон). */
  onBotFrame(energy: number): void {
    this.botRef[this.botRefNext] = energy;
    this.botRefNext = (this.botRefNext + 1) % this.botRef.length;
  }

  /** Громкость бота за последние ECHO_TAIL_MS — наибольшая энергия кадра. */
  botReference(): number {
    let max = 0;
    for (let i = 0; i < this.botRef.length; i++) if (this.botRef[i] > max) max = this.botRef[i];
    return max;
  }

  noiseFloor(): number | null {
    return this.noise.value;
  }

  vadThreshold(): number {
    const floor = this.noise.value;
    if (!this.adaptive || floor === null) return VAD_SPEECH_ENERGY_THRESHOLD;
    return clamp(VAD_FLOOR_FACTOR * floor, VAD_MIN_ENERGY, VAD_SPEECH_ENERGY_THRESHOLD);
  }

  /** Порог подавления в хвосте речи бота при опорной громкости `ref`. */
  echoThreshold(ref: number = this.botReference()): number {
    const floor = this.noise.value;
    const ratio = this.echoRatio.value;
    if (!this.adaptive || floor === null || ratio === null) return ECHO_BARGE_IN_ENERGY;
    const lower = Math.min(ECHO_BARGE_IN_ENERGY, Math.max(ECHO_MIN_ENERGY, ECHO_FLOOR_FACTOR * floor));
    const ceiling = this.echoRatio.total >= ECHO_TRUSTED_FRAMES ? ECHO_MAX_ENERGY : ECHO_BARGE_IN_ENERGY;
    return Math.min(ceiling, Math.max(lower, ECHO_MARGIN * ratio * ref));
  }

  /**
   * Решение по кадру клиента. `msSinceBotAudio` — с последнего кадра речи бота в линии
   * (Infinity, если бот ещё не говорил). Заодно учит пол и оценку эха.
   */
  classify(frame: Int16Array, msSinceBotAudio: number): EchoGateDecision {
    const energy = frameEnergy(frame);
    const inTail = msSinceBotAudio <= ECHO_TAIL_MS;
    const legacyEcho = inTail && energy < ECHO_BARGE_IN_ENERGY;
    if (!this.adaptive) {
      const speech = !legacyEcho && energy >= VAD_SPEECH_ENERGY_THRESHOLD;
      if (inTail) this.lastEchoThreshold = ECHO_BARGE_IN_ENERGY;
      return {
        energy,
        echo: legacyEcho,
        legacyEcho,
        vadThreshold: VAD_SPEECH_ENERGY_THRESHOLD,
        speech,
        bargeIn: speech && energy >= ECHO_BARGE_IN_ENERGY,
      };
    }
    const ref = this.botReference();
    if (!inTail) this.noise.push(energy);
    else if (ref >= BOT_REF_MIN_ENERGY) this.echoRatio.push(Math.min(1, energy / ref));
    const vadThreshold = this.vadThreshold();
    let echo = false;
    let threshold = 0;
    if (inTail) {
      threshold = this.echoThreshold(ref);
      this.lastEchoThreshold = threshold;
      echo = energy < threshold;
    }
    const speech = !echo && energy >= vadThreshold;
    // Сброс недоигранного хвоста — строже VAD (вдох, шорох в трубке не должны обрывать
    // бота), но не строже прежних 1200: тихий человек тоже может перебить.
    const bargeInLevel = Math.min(ECHO_BARGE_IN_ENERGY, Math.max(threshold, 2 * vadThreshold));
    return { energy, echo, legacyEcho, vadThreshold, speech, bargeIn: speech && energy >= bargeInLevel };
  }

  state(): EchoGateState {
    const ratio = this.echoRatio.value;
    const floor = this.noise.value;
    return {
      echoAdaptive: this.adaptive,
      echoThreshold: this.lastEchoThreshold === null ? null : Math.round(this.lastEchoThreshold),
      vadThreshold: Math.round(this.vadThreshold()),
      noiseFloor: floor === null ? null : Math.round(floor * 10) / 10,
      echoRatioDb: ratio === null ? null : ratio > 0 ? Math.round(20 * Math.log10(ratio) * 10) / 10 : -120,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
