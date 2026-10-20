import { describe, expect, it } from "vitest";
import {
  PcmFramer,
  StreamingDecimator,
  createGeminiToLineDecimator,
  designLowPassFir,
  pacerStep,
} from "../src/lib/telephony/liveVoiceBridge.js";

/**
 * Звук робота (02.10.2026, аудит моста К-4/К-5/В-2): понижение 24→8 кГц с
 * нормальным ФНЧ, кадрирование без нулей посреди речи, пейсер по часам.
 */

function tone(freqHz: number, rate: number, n: number, amp = 10000): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * freqHz * i) / rate));
  return out;
}

function rms(x: Int16Array, from = 0): number {
  let sum = 0;
  for (let i = from; i < x.length; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / Math.max(1, x.length - from));
}

const db = (a: number, b: number) => 20 * Math.log10(a / b);

describe("ФНЧ и дециматор 24 → 8 кГц", () => {
  it("6 кГц давится не меньше чем на 30 дБ, 1 кГц проходит в пределах 1 дБ", () => {
    const n = 24000; // 1 с
    const skip = 100; // переходный процесс фильтра на старте
    const low = tone(1000, 24000, n);
    const high = tone(6000, 24000, n);
    const lowOut = createGeminiToLineDecimator().process(low);
    const highOut = createGeminiToLineDecimator().process(high);
    expect(lowOut.length).toBe(8000);
    expect(Math.abs(db(rms(lowOut, skip), rms(low)))).toBeLessThan(1);
    expect(db(rms(highOut, skip), rms(high))).toBeLessThan(-30);
  });

  it("коэффициенты нормированы: постоянный сигнал проходит без изменения", () => {
    const taps = designLowPassFir(63, 3400, 24000);
    expect(taps.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const out = new StreamingDecimator(3, taps).process(new Int16Array(600).fill(5000));
    expect(out[out.length - 1]).toBe(5000);
  });

  it("куски произвольной длины дают тот же выход, что один большой кусок", () => {
    const signal = tone(700, 24000, 4801, 12000);
    const whole = createGeminiToLineDecimator().process(signal);
    const d = createGeminiToLineDecimator();
    const parts: number[] = [];
    const sizes = [7, 479, 1000, 1, 2, 1313, 999];
    let off = 0;
    for (const size of sizes) {
      parts.push(...d.process(signal.subarray(off, off + size)));
      off += size;
    }
    parts.push(...d.process(signal.subarray(off)));
    expect(parts).toEqual(Array.from(whole));
  });

  it("flush отдаёт хвост фильтра и сбрасывает состояние", () => {
    const d = createGeminiToLineDecimator();
    d.process(tone(500, 24000, 300));
    expect(d.flush().length).toBeGreaterThan(0);
    // После сброса тишина на входе — тишина на выходе.
    expect(Array.from(d.process(new Int16Array(30))).every((v) => v === 0)).toBe(true);
  });
});

describe("PcmFramer — нули только в конце реплики", () => {
  it("остаток куска ждёт следующий кусок, а не добивается нулями", () => {
    const f = new PcmFramer(160);
    expect(f.push(new Int16Array(250).fill(7))).toHaveLength(1);
    expect(f.pendingSamples).toBe(90);
    const second = f.push(new Int16Array(70).fill(7));
    expect(second).toHaveLength(1);
    expect(Array.from(second[0]).every((v) => v === 7)).toBe(true);
    expect(f.pendingSamples).toBe(0);
    expect(f.flush()).toBeNull();
  });

  it("flush добивает остаток нулями до кадра", () => {
    const f = new PcmFramer(160);
    f.push(new Int16Array(10).fill(3));
    const last = f.flush()!;
    expect(last).toHaveLength(160);
    expect(last[9]).toBe(3);
    expect(last[10]).toBe(0);
    expect(f.pendingSamples).toBe(0);
  });
});

describe("pacerStep — темп по часам", () => {
  it("за 1000 мс при неровных тиках 10–12 мс уходит ровно 50 кадров, без дрейфа", () => {
    let slot = 0;
    let sent = 0;
    const step = (t: number) => {
      const { send, skip } = pacerStep(t, slot);
      slot += send + skip;
      sent += send;
    };
    for (let t = 0; t < 1000; t += 10 + (t % 3)) step(t);
    step(1000);
    expect(sent).toBe(50);
  });

  it("догон не больше 3 кадров за тик, долг больше 10 кадров прощается", () => {
    expect(pacerStep(100, 0)).toEqual({ send: 3, skip: 0 });
    expect(pacerStep(100, 3)).toEqual({ send: 2, skip: 0 });
    expect(pacerStep(1000, 0)).toEqual({ send: 3, skip: 40 });
    expect(pacerStep(15, 0)).toEqual({ send: 0, skip: 0 });
  });
});
