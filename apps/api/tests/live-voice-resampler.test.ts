import { describe, expect, it } from "vitest";
import {
  bufferToInt16LE,
  framePcm16,
  generateBreathSound,
  int16ToBufferLE,
  mixPcm16,
  resamplePcm16,
  samplesPerFrame,
} from "../src/lib/telephony/liveVoiceBridge.js";

/**
 * ЖИВОЙ ГОЛОС (пункт 5 очереди ИИ, 23.08.2026) — единственный кусок аудио-пути,
 * который вообще можно проверить без сети и без звонка: чистые функции над
 * массивами сэмплов. Всё остальное (ARI, RTP по сети, WebSocket к Gemini) не
 * проверено живым звонком — см. докстринг liveVoiceBridge.ts.
 */
describe("resamplePcm16", () => {
  it("частоты совпадают — вход отдаётся как есть", () => {
    const input = new Int16Array([1, 2, 3, 4]);
    expect(resamplePcm16(input, 16000, 16000)).toBe(input);
  });

  it("24kHz → 16kHz: длина уменьшается пропорционально (2/3)", () => {
    const input = new Int16Array(2400); // 100мс на 24kHz
    const output = resamplePcm16(input, 24000, 16000);
    // 2400 * 16000/24000 = 1600 — ровно 100мс на 16kHz.
    expect(output.length).toBe(1600);
  });

  it("16kHz → 24kHz: длина увеличивается пропорционально (3/2)", () => {
    const input = new Int16Array(1600);
    const output = resamplePcm16(input, 16000, 24000);
    expect(output.length).toBe(2400);
  });

  it("сохраняет форму сигнала — синус узнаваем после ресемплинга", () => {
    // Синус 200Гц на 24kHz, 50мс.
    const durationSec = 0.05;
    const fromRate = 24000;
    const toRate = 16000;
    const freqHz = 200;
    const n = Math.round(fromRate * durationSec);
    const input = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      input[i] = Math.round(30000 * Math.sin((2 * Math.PI * freqHz * i) / fromRate));
    }
    const output = resamplePcm16(input, fromRate, toRate);
    // Пик амплитуды не должен "потеряться" при пересчёте частоты — простая
    // линейная интерполяция ЧАСТОТУ не портит, а лишь немного сглаживает пики.
    const maxIn = Math.max(...Array.from(input, Math.abs));
    const maxOut = Math.max(...Array.from(output, Math.abs));
    expect(maxOut).toBeGreaterThan(maxIn * 0.9);
    expect(maxOut).toBeLessThanOrEqual(32768);
  });

  it("не выходит за пределы int16 на резких перепадах", () => {
    const input = new Int16Array([32767, -32768, 32767, -32768]);
    const output = resamplePcm16(input, 8000, 16000);
    for (const sample of output) {
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
  });

  it("пустой вход — пустой выход, без деления на ноль", () => {
    expect(resamplePcm16(new Int16Array(0), 24000, 16000)).toHaveLength(0);
  });

  it("нулевая или отрицательная частота — явная ошибка, а не тихий мусор", () => {
    expect(() => resamplePcm16(new Int16Array([1]), 0, 16000)).toThrow();
    expect(() => resamplePcm16(new Int16Array([1]), 16000, -1)).toThrow();
  });
});

describe("bufferToInt16LE / int16ToBufferLE", () => {
  it("туда и обратно — те же сэмплы", () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 12345]);
    const buf = int16ToBufferLE(samples);
    expect(buf.length).toBe(samples.length * 2);
    const back = bufferToInt16LE(buf);
    expect(Array.from(back)).toEqual(Array.from(samples));
  });

  it("little-endian: младший байт первым", () => {
    // 0x0102 в LE — байты [0x02, 0x01].
    const buf = int16ToBufferLE(new Int16Array([0x0102]));
    expect(buf[0]).toBe(0x02);
    expect(buf[1]).toBe(0x01);
  });
});

describe("samplesPerFrame / framePcm16", () => {
  it("20мс на 16kHz — 320 сэмплов", () => {
    expect(samplesPerFrame(16000, 20)).toBe(320);
  });

  it("делит ровно кратную длину без дополнения", () => {
    const samples = new Int16Array(640); // 2 кадра по 320
    const frames = framePcm16(samples, 320);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(320);
    expect(frames[1]).toHaveLength(320);
  });

  it("дополняет последний неполный кадр тишиной, не обрезает данные", () => {
    const samples = new Int16Array(500).fill(7); // 1.5 кадра по 320
    const frames = framePcm16(samples, 320);
    expect(frames).toHaveLength(2);
    expect(frames[0].every((s) => s === 7)).toBe(true);
    // Первые 180 сэмплов второго кадра — настоящие данные, остальные 140 — тишина.
    expect(Array.from(frames[1].subarray(0, 180))).toEqual(Array(180).fill(7));
    expect(Array.from(frames[1].subarray(180))).toEqual(Array(140).fill(0));
  });

  it("нулевой размер кадра — явная ошибка", () => {
    expect(() => framePcm16(new Int16Array([1]), 0)).toThrow();
  });
});

describe("mixPcm16", () => {
  it("складывает сэмплы попарно", () => {
    const a = new Int16Array([100, -100, 0]);
    const b = new Int16Array([50, 50, -20]);
    expect(Array.from(mixPcm16(a, b))).toEqual([150, -50, -20]);
  });

  it("ограничивает результат диапазоном int16, не переполняется", () => {
    const a = new Int16Array([32000, -32000]);
    const b = new Int16Array([1000, -1000]);
    expect(Array.from(mixPcm16(a, b))).toEqual([32767, -32768]);
  });

  it("разной длины — результат по короче длине, без исключения", () => {
    const a = new Int16Array([1, 2, 3]);
    const b = new Int16Array([10, 20]);
    expect(Array.from(mixPcm16(a, b))).toEqual([11, 22]);
  });
});

describe("generateBreathSound", () => {
  it("длина равна запрошенной", () => {
    expect(generateBreathSound(3200, 700)).toHaveLength(3200);
  });

  it("огибающая: начало и конец тише середины (нарастает и затухает)", () => {
    const sound = generateBreathSound(1000, 32767);
    const edgeAvg = (Math.abs(sound[0]) + Math.abs(sound[1]) + Math.abs(sound[998]) + Math.abs(sound[999])) / 4;
    const midAvg = (Math.abs(sound[499]) + Math.abs(sound[500])) / 2;
    // Огибающая — половина синуса: у краёв почти 0, у середины почти пик.
    expect(edgeAvg).toBeLessThan(midAvg);
  });

  it("нулевая амплитуда — полная тишина", () => {
    const sound = generateBreathSound(200, 0);
    expect(Array.from(sound)).toEqual(Array(200).fill(0));
  });

  it("не выходит за пределы диапазона int16", () => {
    const sound = generateBreathSound(3200, 32767);
    for (const sample of sound) {
      expect(sample).toBeGreaterThanOrEqual(-32768);
      expect(sample).toBeLessThanOrEqual(32767);
    }
  });
});
