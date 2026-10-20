/**
 * ЗВУК ДЛЯ ЖИВОГО ГОЛОСА — ЧИСТЫЕ ФУНКЦИИ (02.10.2026, вынесены из
 * lib/telephony/liveVoiceBridge.ts БЕЗ изменения кода; перенос на свежий main
 * 03.10.2026 — с настоящим ФНЧ и потоковым дециматором из правки моста). Причина
 * переезда — второй поставщик голоса (ai/elevenLabsVoiceClient.ts): ему нужны те
 * же ресемплер и ulaw, а импорт из моста замкнул бы цикл (мост создаёт клиента).
 * Мост переизлучает всё отсюда, прежние импорты не тронуты.
 */

/**
 * Ресемплер линейной интерполяцией — ПРОСТОЙ, а не студийного качества (по
 * заданию задачи: «этого масштаба хватает»). Функция симметрична и годится в обе
 * стороны, но памяти между кусками у неё нет: для непрерывного потока кадров
 * (голос клиента в модель) — StreamingInterpolator ниже.
 */
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate <= 0 || toRate <= 0) throw new Error("Частота дискретизации должна быть положительной");
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  // ПОНИЖЕНИЕ частоты (ratio > 1) без фильтра нижних частот перед прореживанием
  // даёт алиасинг: частоты выше новой частоты Найквиста (toRate/2) заворачиваются
  // вниз и слышны как металлический дребезг. С 02.10.2026 фильтр — настоящий
  // windowed-sinc (см. designLowPassFir), а не скользящее среднее из 3 отсчётов,
  // которое давило 6 кГц всего на −9,5 дБ. Живой путь ответа модели идёт через
  // потоковый StreamingDecimator (состояние между кусками); эта функция — для
  // разовых кусков. При ПОВЫШЕНИИ алиасинга нет — фильтр не нужен.
  const source = ratio > 1 ? applyFir(input, lowPassForRate(fromRate, toRate)) : input;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const output = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const lowIndex = Math.min(Math.floor(srcPos), source.length - 1);
    const highIndex = Math.min(lowIndex + 1, source.length - 1);
    const frac = srcPos - lowIndex;
    const sample = source[lowIndex] * (1 - frac) + source[highIndex] * frac;
    output[i] = Math.max(-32768, Math.min(32767, Math.round(sample)));
  }
  return output;
}

/**
 * ФНЧ windowed-sinc с окном Хэмминга (02.10.2026, аудит моста К-4). Коэффициенты
 * нормированы на единичное усиление на нуле частоты. 63 отсчёта на 24 кГц при
 * срезе 3,4 кГц: 1 кГц проходит без потерь, 6 кГц давится больше чем на 40 дБ.
 */
export function designLowPassFir(numTaps: number, cutoffHz: number, sampleRateHz: number): Float64Array {
  if (numTaps < 1 || numTaps % 2 === 0) throw new Error("Число отсчётов ФНЧ должно быть нечётным и положительным");
  const taps = new Float64Array(numTaps);
  const fc = cutoffHz / sampleRateHz;
  const mid = (numTaps - 1) / 2;
  let sum = 0;
  for (let n = 0; n < numTaps; n++) {
    const x = n - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const window = numTaps === 1 ? 1 : 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (numTaps - 1));
    taps[n] = sinc * window;
    sum += taps[n];
  }
  for (let n = 0; n < numTaps; n++) taps[n] /= sum;
  return taps;
}

/** Срез ФНЧ перед понижением частоты: 85 % новой частоты Найквиста (3,4 кГц для 8 кГц). */
const LOW_PASS_TAPS = 63;
const lowPassCache = new Map<string, Float64Array>();
export function lowPassForRate(fromRate: number, toRate: number): Float64Array {
  const key = `${fromRate}->${toRate}`;
  let taps = lowPassCache.get(key);
  if (!taps) {
    taps = designLowPassFir(LOW_PASS_TAPS, 0.425 * toRate, fromRate);
    lowPassCache.set(key, taps);
  }
  return taps;
}

function clampSample(v: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(v)));
}

/** Свёртка с центрированным ядром (без задержки), за краем — нули. Для разовых кусков. */
function applyFir(input: Int16Array, taps: Float64Array): Int16Array {
  const out = new Int16Array(input.length);
  const mid = (taps.length - 1) / 2;
  for (let i = 0; i < input.length; i++) {
    let acc = 0;
    for (let k = 0; k < taps.length; k++) {
      const j = i + mid - k;
      if (j >= 0 && j < input.length) acc += taps[k] * input[j];
    }
    out[i] = clampSample(acc);
  }
  return out;
}

/**
 * ПОТОКОВЫЙ ДЕЦИМАТОР (02.10.2026, аудит моста К-4/К-5): ФНЧ + прореживание в
 * целое число раз, с историей фильтра и фазой прореживания МЕЖДУ кусками. Gemini
 * присылает куски звука произвольной длины; раньше каждый фильтровался и
 * прореживался отдельно — на стыке фильтр рвался, а отсчёт терялся или дублировался.
 * Здесь выход на склейке кусков тот же, что на одном большом куске.
 */
export class StreamingDecimator {
  private history: Float64Array;
  /** Индекс (в history+вход) самого свежего отсчёта для следующего выхода. */
  private nextPos: number;

  constructor(
    private readonly factor: number,
    private readonly taps: Float64Array
  ) {
    if (!Number.isInteger(factor) || factor < 1) throw new Error("Коэффициент прореживания — целое ≥ 1");
    this.history = new Float64Array(taps.length - 1);
    this.nextPos = taps.length - 1;
  }

  process(input: Int16Array): Int16Array {
    const keep = this.taps.length - 1;
    const work = new Float64Array(keep + input.length);
    work.set(this.history, 0);
    for (let i = 0; i < input.length; i++) work[keep + i] = input[i];
    const outCount = this.nextPos < work.length ? Math.floor((work.length - 1 - this.nextPos) / this.factor) + 1 : 0;
    const out = new Int16Array(outCount);
    let pos = this.nextPos;
    for (let o = 0; o < outCount; o++, pos += this.factor) {
      let acc = 0;
      for (let k = 0; k < this.taps.length; k++) acc += this.taps[k] * work[pos - k];
      out[o] = clampSample(acc);
    }
    this.history = work.slice(work.length - keep);
    this.nextPos = pos - (work.length - keep);
    return out;
  }

  /** Конец реплики: выдать хвост фильтра (задержка (N−1)/2 отсчёта) и сбросить состояние. */
  flush(): Int16Array {
    const tail = this.process(new Int16Array(this.taps.length - 1));
    this.reset();
    return tail;
  }

  reset(): void {
    this.history = new Float64Array(this.taps.length - 1);
    this.nextPos = this.taps.length - 1;
  }
}

/**
 * ПОТОКОВЫЙ ИНТЕРПОЛЯТОР (09.10.2026, docs/robot-upgrade-speed-understanding-2026-10-09.md,
 * С8): повышение частоты в целое число раз полифазным ФНЧ с историей МЕЖДУ кусками —
 * зеркало StreamingDecimator. Голос клиента приходит кадрами по 20 мс на 8 кГц, модель
 * слушает 16 кГц. Раньше каждый кадр поднимался resamplePcm16 отдельно: последний отсчёт
 * кадра повторялся (на стыке — ступенька каждые 20 мс, гул 50 Гц), а копии спектра в
 * полосе 4–8 кГц не давились вовсе (шипение сверху). Здесь выход на склейке кусков тот
 * же, что на одном большом куске, а полоса выше 3,4 кГц давится фильтром.
 *
 * Задержка — (N−1)/2 отсчётов выхода (63 отсчёта на 16 кГц ≈ 2 мс), хвост не выдаётся:
 * поток с линии непрерывный, конца реплики у него нет.
 */
export class StreamingInterpolator {
  /** Последние входные отсчёты, нужные фильтру (самый свежий — в конце). */
  private history: Float64Array;
  /** Коэффициенты по фазам: phases[p][j] = factor · taps[p + j·factor]. */
  private readonly phases: Float64Array[];

  constructor(
    private readonly factor: number,
    taps: Float64Array
  ) {
    if (!Number.isInteger(factor) || factor < 1) throw new Error("Коэффициент интерполяции — целое ≥ 1");
    this.phases = [];
    for (let p = 0; p < factor; p++) {
      const count = Math.ceil((taps.length - p) / factor);
      const phase = new Float64Array(Math.max(0, count));
      for (let j = 0; j < phase.length; j++) phase[j] = factor * taps[p + j * factor];
      this.phases.push(phase);
    }
    this.history = new Float64Array(Math.ceil(taps.length / factor));
  }

  process(input: Int16Array): Int16Array {
    const keep = this.history.length;
    const work = new Float64Array(keep + input.length);
    work.set(this.history, 0);
    for (let i = 0; i < input.length; i++) work[keep + i] = input[i];
    const out = new Int16Array(input.length * this.factor);
    for (let n = 0; n < input.length; n++) {
      const newest = keep + n;
      for (let p = 0; p < this.factor; p++) {
        const phase = this.phases[p];
        let acc = 0;
        for (let j = 0; j < phase.length; j++) acc += phase[j] * work[newest - j];
        out[n * this.factor + p] = clampSample(acc);
      }
    }
    this.history = work.slice(work.length - keep);
    return out;
  }

  reset(): void {
    this.history = new Float64Array(this.history.length);
  }
}

/** Линия 8 кГц → вход модели 16 кГц: ×2, срез 3,4 кГц (та же полоса, что у дециматора). */
export function createLineToModelInterpolator(): StreamingInterpolator {
  return new StreamingInterpolator(2, designLowPassFir(LOW_PASS_TAPS, 3_400, 16_000));
}

/** Байты little-endian → сэмплы. Asterisk (slin16) и Gemini оба отдают LE. */
export function bufferToInt16LE(buf: Buffer): Int16Array {
  const out = new Int16Array(Math.floor(buf.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

export function int16ToBufferLE(samples: Int16Array): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/** Развернуть ulaw-байты в 16-битные сэмплы (стандартная таблица RFC 3551). */
export function ulawDecode(payload: Buffer): Int16Array {
  const out = new Int16Array(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    const u = ~payload[i] & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;
    out[i] = sign ? -sample : sample;
  }
  return out;
}

/** Свернуть 16-битные сэмплы в ulaw (стандартная таблица RFC 3551). */
export function ulawEncode(samples: Int16Array): Buffer {
  const BIAS = 0x84;
  const CLIP = 32635;
  const out = Buffer.allocUnsafe(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    let sample = samples[i];
    const sign = sample < 0 ? 0x80 : 0;
    if (sign) sample = -sample;
    if (sample > CLIP) sample = CLIP;
    sample += BIAS;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}
