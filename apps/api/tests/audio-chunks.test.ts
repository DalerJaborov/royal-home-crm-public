import { describe, expect, it } from "vitest";
import { splitAudioForTranscription } from "../src/ai/audioChunks.js";

/**
 * ДЛИННЫЙ РАЗГОВОР РЕЖЕТСЯ НА ЧАСТИ (12.08.2026).
 *
 * До этого запись крупнее предела поставщика не расшифровывалась ВООБЩЕ: час
 * разговора в WAV с АТС — около 55 МБ, то есть всё длиннее пятнадцати минут
 * пропадало молча. Короткое «алло, перезвоню» разбиралось прекрасно, а живая
 * беседа с клиентом — нет.
 *
 * Резка — чистая функция, поэтому проверяется без сети и без Gemini. Стережём
 * ровно то, что ломается незаметно и портит звук: границу блока сэмплов и
 * правильность размеров в заголовке каждого куска.
 */

/**
 * Минимальный настоящий WAV: RIFF + fmt + data.
 *
 * `sampleRate` — параметр, а не всегда 8000 (24.09.2026, для тестов резки по
 * времени ниже): реальная станция пишет 8 кГц, но тест на «целимся в 180 секунд
 * речи» с настоящим байт/сек (16000 Б/с) потребовал бы мегабайтных буферов ради
 * наглядной цифры. Заниженный sampleRate даёт тот же byteRate-в-заголовке
 * механизм на буфере в килобайты — резка читает поле честно, ей всё равно, что
 * означает цифра физически.
 */
function makeWav(dataBytes: number, blockAlign = 2, sampleRate = 8000): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // размер fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // моно
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  const data = Buffer.alloc(dataBytes, 7);
  return Buffer.concat([header, data]);
}

describe("Резка длинной записи разговора", () => {
  it("короткая запись не режется вовсе", () => {
    const wav = makeWav(1000);
    const parts = splitAudioForTranscription(wav, "audio/wav", 15_000);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(wav);
  });

  it("длинный WAV режется, и каждый кусок — валидный WAV со своими размерами", () => {
    const dataBytes = 10_000;
    const wav = makeWav(dataBytes);
    const maxBytes = 2_044; // заголовок 44 + 2000 данных
    const parts = splitAudioForTranscription(wav, "audio/wav", maxBytes);

    expect(parts.length).toBe(5);
    let restored = 0;
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(maxBytes);
      // Каждый кусок — самостоятельный файл, а не обрывок: заголовок на месте.
      expect(part.toString("ascii", 0, 4)).toBe("RIFF");
      expect(part.toString("ascii", 8, 12)).toBe("WAVE");
      // Размеры в заголовке описывают именно этот кусок, иначе декодер прочитает
      // мусор за концом данных или оборвёт звук раньше времени.
      const dataSize = part.readUInt32LE(40);
      expect(dataSize).toBe(part.length - 44);
      expect(part.readUInt32LE(4)).toBe(part.length - 8);
      restored += dataSize;
    }
    // Ни один сэмпл не потерян и не задвоен.
    expect(restored).toBe(dataBytes);
  });

  it("режет ТОЛЬКО по границе блока — иначе кусок начинается с середины сэмпла", () => {
    // blockAlign 4 (стерео 16 бит): длина данных каждого куска обязана делиться на 4.
    const wav = makeWav(4_000, 4);
    const parts = splitAudioForTranscription(wav, "audio/wav", 1_000);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) {
      expect((part.length - 44) % 4).toBe(0);
    }
  });

  it("MP3 режется по байтам: кадры самостоятельны, теряется в худшем случае один", () => {
    const mp3 = Buffer.alloc(5_000, 3);
    const parts = splitAudioForTranscription(mp3, "audio/mpeg", 2_000);
    expect(parts).toHaveLength(3);
    expect(Buffer.concat(parts)).toEqual(mp3);
  });

  it("OGG не режется — страницы со своими заголовками, обрывок сломал бы файл", () => {
    const ogg = Buffer.alloc(5_000, 9);
    expect(splitAudioForTranscription(ogg, "audio/ogg", 2_000)).toHaveLength(0);
  });

  it("битый WAV без куска data не режется, а не отдаёт мусор", () => {
    const broken = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(5_000)]);
    expect(splitAudioForTranscription(broken, "audio/wav", 1_000)).toHaveLength(0);
  });

  it("врущий размер в заголовке не заставляет читать за концом файла", () => {
    // Запись оборвалась: в заголовке заявлено больше данных, чем есть на диске.
    const wav = makeWav(4_000);
    wav.writeUInt32LE(999_999, 40);
    const parts = splitAudioForTranscription(wav, "audio/wav", 1_044);
    const total = parts.reduce((sum, p) => sum + (p.length - 44), 0);
    expect(total).toBe(4_000);
  });
});

/**
 * КУСОК ЦЕЛИТСЯ В TARGET_CHUNK_SECONDS РЕЧИ, А НЕ ТОЛЬКО В ПРЕДЕЛ ПОСТАВЩИКА
 * ПО БАЙТАМ (24.09.2026).
 *
 * Живой замер 24.09: дорогая модель разбирает mp3 393 КБ (~3 мин речи) за 49 с,
 * а mp3 1486 КБ (692 с речи) не успевает вовсе — прокси Cloudflare обрывает
 * ответ через 125 с кодом 524. Кусок «сколько влезет в 15 МБ» на реальном
 * разговоре — это 10-15 минут речи, заведомо длиннее, чем модель успевает через
 * прокси. Резчик теперь целится в TARGET_CHUNK_SECONDS (180 с) и растит кусок,
 * а не теряет хвост, только если по 180-секундной цели вышло бы больше MAX_PARTS
 * (6) кусков.
 *
 * Тесты используют заниженный sampleRate (см. makeWav), чтобы получить
 * наглядный byteRate на буферах в килобайты, а не в мегабайты.
 */
describe("Резка целится в секунды речи, а не только в байты", () => {
  it("WAV: длинная запись режется на куски по цели в 180 с, а не по одному большому байтовому куску", () => {
    // byteRate = 100 Гц × 2 байта = 200 Б/с. Цель — 180 с речи → 36 000 Б/кусок.
    const byteRate = 200;
    const totalSeconds = 900; // 15 минут — старой резкой (только по байтам) это
    // было бы 2 куска почти по 8 минут; целью в 180 с должно выйти 5 кусков.
    const dataBytes = byteRate * totalSeconds;
    const wav = makeWav(dataBytes, 2, 100);
    const maxBytes = 44 + 100_000; // с большим запасом от цели по времени —
    // резку определяет не он, а TARGET_CHUNK_SECONDS.

    const parts = splitAudioForTranscription(wav, "audio/wav", maxBytes);

    expect(parts.truncated).toBeUndefined();
    expect(parts.length).toBe(5);
    let totalDataBytes = 0;
    for (const part of parts.slice(0, -1)) {
      const dataLen = part.length - 44;
      // Каждый кусок (кроме последнего, короче) — ровно на цели в 180 с.
      expect(dataLen / byteRate).toBe(180);
      totalDataBytes += dataLen;
    }
    totalDataBytes += parts[parts.length - 1].length - 44;
    // Ни секунды речи не потеряно — покрыты все 900 секунд.
    expect(totalDataBytes).toBe(dataBytes);
  });

  it("WAV: если по 180-секундной цели вышло бы больше MAX_PARTS кусков — кусок растёт, хвост не теряется", () => {
    const byteRate = 200;
    const totalSeconds = 2000; // при цели в 180 с это 12 кусков — больше предела в 6.
    const dataBytes = byteRate * totalSeconds;
    const wav = makeWav(dataBytes, 2, 100);
    // Предел по байтам заведомо не мешает (заметно больше расчётного «растущего»
    // куска ~66,7 КБ), но меньше всего буфера — иначе резка не понадобится вовсе.
    const maxBytes = 44 + 300_000;

    const parts = splitAudioForTranscription(wav, "audio/wav", maxBytes);

    expect(parts.length).toBeLessThanOrEqual(6);
    expect(parts.truncated).toBeUndefined();
    const totalDataBytes = parts.reduce((sum, p) => sum + (p.length - 44), 0);
    // Кусок вырос, а не хвост пропал: секунды речи по-прежнему покрыты все.
    expect(totalDataBytes).toBe(dataBytes);
  });

  it("WAV: запись, которая не влезает даже в MAX_PARTS кусков под потолком байт, — прежняя обрезка хвоста (с меткой)", () => {
    const byteRate = 200;
    const totalSeconds = 20_000; // заведомо больше, чем 6 кусков по потолку байт покроют.
    const dataBytes = byteRate * totalSeconds;
    const wav = makeWav(dataBytes, 2, 100);
    const maxBytes = 44 + 10_000; // тесный потолок — кусок расти дальше него не может.

    const parts = splitAudioForTranscription(wav, "audio/wav", maxBytes);

    expect(parts.length).toBe(6);
    expect(parts.truncated).toBe(true);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(maxBytes);
  });

  it("MP3: durationSec всей записи даёт точную цель по времени, а не оценку по битрейту", () => {
    const bytesPerSecond = 400; // произвольный, но известный «истинный» битрейт.
    const durationSec = 900; // 15 минут — при цели 180 с ожидаем 5 кусков.
    const mp3 = Buffer.alloc(bytesPerSecond * durationSec, 3); // 360 000 Б
    const maxBytes = 200_000; // меньше буфера (резка нужна), больше цели в 72 000 Б.

    const parts = splitAudioForTranscription(mp3, "audio/mpeg", maxBytes, durationSec);

    expect(parts.length).toBe(5);
    expect(Buffer.concat(parts)).toEqual(mp3);
    for (const part of parts.slice(0, -1)) expect(part.length / bytesPerSecond).toBe(180);
  });

  it("MP3: без durationSec резчик оценивает длительность по типичному битрейту станции (~17 кбит/с)", { timeout: 60_000 }, () => {
    // ~17 кбит/с = 2125 Б/с (см. ESTIMATED_BYTES_PER_SEC). Цель 180 с → 382 500 Б/кусок.
    const estimatedBytesPerSecond = 17_000 / 8;
    const mp3 = Buffer.alloc(Math.round(estimatedBytesPerSecond * 900), 3); // ~15 минут по оценке, ~1,91 МБ
    const maxBytes = 1_000_000; // меньше буфера (резка нужна), больше цели в ~382 500 Б.

    const parts = splitAudioForTranscription(mp3, "audio/mpeg", maxBytes);

    // При точном битрейте это было бы 5 кусков — оценка не обязана совпасть день
    // в день, но обязана резать МЕЛЬЧЕ прежнего байтового предела (не один кусок).
    expect(parts.length).toBeGreaterThan(1);
    expect(Buffer.concat(parts)).toEqual(mp3);
  });

  it("короткий звонок по-прежнему укладывается в предел целиком — резать вообще не нужно", () => {
    // 3 минуты — именно та длина, на которой живой замер 24.09 показал 49 с ответа
    // дорогой модели: должна уйти ОДНИМ куском, без дробления по 180 с.
    const byteRate = 200;
    const wav = makeWav(byteRate * 180, 2, 100);
    const parts = splitAudioForTranscription(wav, "audio/wav", 44 + 1_000_000);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe(wav);
  });
});
