import { describe, expect, it } from "vitest";
import { buildStereoWavFile } from "../src/lib/telephony/liveVoiceBridge.js";

/**
 * Запись звонка (13.09.2026, владелец: «главное всё это должно записываться»)
 * — buildStereoWavFile чистая функция, без сети/файлов; заливка в R2 и подбор
 * ключа (saveLiveVoiceRecording) не экспортированы и не тестируются здесь —
 * они требуют настоящего R2 (см. соответствующие интеграционные проверки
 * остального R2-кода в проекте).
 */
describe("buildStereoWavFile", () => {
  it("заголовок RIFF/WAVE и формат PCM 16-бит, 2 канала", () => {
    const wav = buildStereoWavFile(new Int16Array([1, 2]), new Int16Array([3, 4]), 8000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(2); // каналов
    expect(wav.readUInt32LE(24)).toBe(8000); // частота
    expect(wav.readUInt16LE(34)).toBe(16); // бит на сэмпл
    expect(wav.toString("ascii", 36, 40)).toBe("data");
  });

  it("длина RIFF/data чанков соответствует реальному числу байт", () => {
    const left = new Int16Array([1, 2, 3]);
    const right = new Int16Array([4, 5, 6]);
    const wav = buildStereoWavFile(left, right, 8000);
    const dataBytes = 3 * 2 * 2; // 3 кадра × 2 канала × 2 байта
    expect(wav.readUInt32LE(40)).toBe(dataBytes);
    expect(wav.readUInt32LE(4)).toBe(36 + dataBytes);
    expect(wav.length).toBe(44 + dataBytes);
  });

  it("сэмплы уложены чередованием: левый, правый, левый, правый…", () => {
    const wav = buildStereoWavFile(new Int16Array([100, 200]), new Int16Array([-100, -200]), 8000);
    expect(wav.readInt16LE(44)).toBe(100);
    expect(wav.readInt16LE(46)).toBe(-100);
    expect(wav.readInt16LE(48)).toBe(200);
    expect(wav.readInt16LE(50)).toBe(-200);
  });

  it("дорожки разной длины — короче дополняется тишиной, длиннее не обрезается", () => {
    const left = new Int16Array([1, 2, 3, 4]);
    const right = new Int16Array([9]);
    const wav = buildStereoWavFile(left, right, 8000);
    expect(wav.readInt16LE(44)).toBe(1);
    expect(wav.readInt16LE(46)).toBe(9); // правый: единственный сэмпл
    expect(wav.readInt16LE(48)).toBe(2);
    expect(wav.readInt16LE(50)).toBe(0); // правый кончился — тишина
    expect(wav.length).toBe(44 + 4 * 2 * 2); // по длине левой (длиннее) дорожки
  });

  it("обе дорожки пустые — заголовок есть, данных нет", () => {
    const wav = buildStereoWavFile(new Int16Array([]), new Int16Array([]), 8000);
    expect(wav.length).toBe(44);
    expect(wav.readUInt32LE(40)).toBe(0);
  });
});
