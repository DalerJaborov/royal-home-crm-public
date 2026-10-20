/**
 * Длинная запись разговора — по кускам, которые поставщик принимает телом запроса.
 *
 * ЗАЧЕМ. Gemini получает аудио в теле запроса (base64), и файл крупнее ~15 МБ он
 * отвергает целиком. Час разговора в WAV с АТС — около 55 МБ, то есть всё, что
 * длиннее пятнадцати минут, не расшифровывалось ВООБЩЕ: ни текста, ни разбора, ни
 * подсказки в окне итога. А это самые ценные разговоры — короткие «алло, перезвоню»
 * разбирались прекрасно, а живая часовая беседа с клиентом пропадала молча.
 *
 * ПОЧЕМУ РЕЗКОЙ, А НЕ ЗАГРУЗКОЙ ФАЙЛА. У Gemini есть отдельный путь для больших
 * файлов (Files API): загрузить, дождаться обработки, сослаться. Это второй сетевой
 * протокол, своё время жизни файла на стороне поставщика и ещё один способ всё
 * сломать — ради задачи, которая решается нарезкой без единого нового запроса.
 *
 * ЧТО ЗДЕСЬ ВАЖНО. Заголовок WAV копируется БАЙТ В БАЙТ, а правятся только два поля
 * размера. Записи с АТС бывают не только 16-битным PCM (a-law, mu-law, GSM внутри
 * WAV), и пересобранный «правильный» заголовок сломал бы их формат. Резать можно
 * только по границе блока (blockAlign) — иначе куски начинаются с середины сэмпла,
 * и вместо речи получается треск.
 *
 * КУСОК МЕРЯЕТСЯ ВРЕМЕНЕМ РЕЧИ, А НЕ ТОЛЬКО БАЙТАМИ (24.09.2026).
 *
 * ЧТО БЫЛО НЕ ТАК. Куски резались строго под предел Gemini по байтам (15 МБ) — то
 * есть под предел САМОГО ПОСТАВЩИКА. Запросы к нему идут через прокси Cloudflare
 * Worker (см. ai/geminiTransport.ts), а у прокси свой, более короткий потолок
 * ожидания ответа апстрима: живой замер 24.09.2026 — mp3 393 КБ (~3 мин речи)
 * дорогая модель (gemini-3.1-pro-preview) разбирает за 49 с, а mp3 1486 КБ (692 с
 * речи) не успевает вовсе — прокси обрывает ответ через 125 с кодом 524. Кусок
 * размером «сколько влезет в 15 МБ» на реальном разговоре — это 10-15 минут речи,
 * то есть заведомо длиннее, чем дорогая модель успевает разобрать через прокси.
 *
 * ЧТО ДЕЛАЕМ. Цель — TARGET_CHUNK_SECONDS речи на кусок (с запасом от замеренных
 * 49 с), а не байтовый потолок поставщика: он остаётся ВЕРХНЕЙ границей (кусок
 * никогда не больше maxBytes), а не единственным ориентиром. Для WAV длительность
 * куска считается из byteRate заголовка (точно — WAV несжат, байт в секунду известен
 * без гадания). Для MP3/GSM точного заголовка длительности нет: берём
 * recordingDurationSec всей записи, если он известен (его пишет finishCall при
 * завершении звонка), иначе оцениваем по типичному битрейту станции.
 *
 * ЕСЛИ КУСКОВ ПО ВРЕМЕНИ ВЫШЛО БОЛЬШЕ MAX_PARTS — РАСТИТ КУСОК, А НЕ ТЕРЯЕТ ХВОСТ.
 * У часового разговора при цели в 180 с и потолке в 6 кусков время покрыло бы лишь
 * 18 минут — это регресс относительно прежних ~90 минут (6 кусков по ~15 минут).
 * Поэтому, если TARGET_CHUNK_SECONDS дал бы больше MAX_PARTS кусков, длина куска
 * увеличивается ровно настолько, чтобы вся запись уложилась в MAX_PARTS штук — и
 * только если даже это упирается в верхний предел по байтам, включается прежняя
 * обрезка хвоста (см. markIfTruncated): она остаётся последним рубежом для записей,
 * которые не покрыть вообще никаким разумным числом кусков.
 */

import { logSystemError } from "../lib/systemError.js";

const TARGET_CHUNK_SECONDS = 180;

/**
 * ОЦЕНКА БАЙТ/СЕК, КОГДА ТОЧНАЯ ДЛИТЕЛЬНОСТЬ MP3/GSM НЕИЗВЕСТНА.
 *
 * По битрейту, которым станция реально пишет сжатые записи (тот же расчёт, что и в
 * задании на эту правку): mp3 ~17 кбит/с → ~2,125 КБ/с, gsm ~13 кбит/с → ~1,625 КБ/с.
 * Используется, только когда durationSec не передан вызывающим (см.
 * lib/telephony/callRecordings.ts) — там, где он есть, он точнее любой оценки.
 */
const ESTIMATED_BYTES_PER_SEC: Partial<Record<string, number>> = {
  "audio/mpeg": 17_000 / 8,
  "audio/gsm": 13_000 / 8,
};

/**
 * ПОТОЛОК НА ЧИСЛО КУСКОВ (21.08.2026).
 *
 * Сама резка бесплатна, а вот каждый кусок — это ОТДЕЛЬНЫЙ платный запрос к дорогой
 * модели со своим сроком ожидания. Предела не было вовсе: запись на 150 МБ (АТС
 * такие отдаёт — забытая трубка, зависший MixMonitor) давала десяток кусков, то есть
 * до двух с половиной часов звука и десяток дорогих запросов за ОДИН звонок, пока в
 * общей очереди ждут разбора остальные разговоры.
 *
 * Шесть кусков — прежде это было примерно полтора часа разговора (кусок ≈ 15 МБ ≈
 * 15 минут телефонного wav). С 24.09.2026 кусок целится в TARGET_CHUNK_SECONDS (три
 * минуты) — короче ради прокси, а не ради этого предела, — но если по времени
 * кусков вышло бы больше шести, кусок просто растёт (см. докстринг выше), и то же
 * самое полтора часа по-прежнему помещаются без потери хвоста. Живых бесед длиннее
 * не бывает: всё, что длиннее, — это сбой станции или забытая трубка, и платить за
 * них как за разговор незачем.
 */
const MAX_PARTS = 6;

/**
 * Куски записи — со ЧЕСТНЫМ признаком «это не вся запись».
 *
 * Массив, а не пара `{ parts, truncated }`, намеренно: вызывающие места работают
 * именно со списком кусков (lib/telephony/callRecordings.ts), а признак обрезки
 * нужен им сверх того — чтобы отличить полную расшифровку от хвостатой и дописать
 * пометку в текст, а не выдавать половину разговора за целый. Пара сломала бы всех
 * вызывающих ради одного необязательного поля.
 */
export interface AudioParts extends Array<Buffer> {
  /** Часть записи не расшифровывается: кусков вышло больше MAX_PARTS. */
  truncated?: boolean;
}

/**
 * Помечает результат неполным и объясняет отказ в журнале.
 *
 * В журнал, а не только в консоль: обрезанная расшифровка выглядит как обычная, и
 * без строки в «Здоровье системы» никто никогда не узнает, что у часового разговора
 * разобрана только первая половина.
 */
function markIfTruncated(chunks: AudioParts, total: number, bytes: number, mediaType: string): AudioParts {
  if (total <= chunks.length) return chunks;
  chunks.truncated = true;
  void logSystemError(
    "ai",
    `Запись разговора (${Math.round(bytes / 1024 / 1024)} МБ, ${mediaType}) режется на ${total} частей — ` +
      `расшифрованы будут только первые ${MAX_PARTS}, хвост (${total - MAX_PARTS} ч.) пропущен: каждая часть ` +
      `уходит на дорогую модель отдельным платным запросом. Расшифровка этого разговора неполная.`
  );
  return chunks;
}

/** Куда смотреть, чтобы понять, что это WAV. */
function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

interface WavLayout {
  /** Всё до полезных данных: RIFF + fmt + прочие служебные куски. */
  headerEnd: number;
  dataStart: number;
  dataEnd: number;
  /** Размер одного блока сэмплов. Резать можно только по его границе. */
  blockAlign: number;
  /** Байт в секунду НЕСЖАТОГО звука — из заголовка fmt, точно (не оценка, как у
   *  MP3/GSM ниже): по нему кусок мерится временем, а не только байтами. */
  byteRate: number;
}

/** Разбор структуры WAV. null — файл не разобрался (обрезан, экзотический). */
function readWavLayout(buffer: Buffer): WavLayout | null {
  let offset = 12; // после "RIFF"+размер+"WAVE"
  let blockAlign = 0;
  let byteRate = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      // byteRate лежит на 8-м байте куска fmt (после audioFormat, channels,
      // sampleRate), blockAlign — на 12-м (после byteRate). У файлов без него
      // режем по два байта — минимальный безопасный шаг для 16-битного звука.
      if (body + 14 <= buffer.length) {
        byteRate = buffer.readUInt32LE(body + 8) || 0;
        blockAlign = buffer.readUInt16LE(body + 12) || 0;
      }
    }
    if (id === "data") {
      // Размер в заголовке бывает враньём (запись оборвалась, файл дописывался) —
      // верим фактической длине файла, если она меньше.
      const dataEnd = Math.min(buffer.length, body + size);
      return { headerEnd: body, dataStart: body, dataEnd, blockAlign: blockAlign || 2, byteRate };
    }
    // Куски выравниваются по чётной границе.
    offset = body + size + (size % 2);
  }
  return null;
}

/**
 * Сколько байт данных отдать ОДНОМУ куску — цель TARGET_CHUNK_SECONDS речи, но не
 * больше maxChunkBytes (верхний предел поставщика) и так, чтобы вся запись
 * уложилась не больше чем в MAX_PARTS кусков (см. докстринг у TARGET_CHUNK_SECONDS:
 * растим кусок вместо потери хвоста).
 *
 * bytesPerSecond <= 0 — длительность посчитать нечем (сломанный заголовок, неверный
 * mediaType без оценки битрейта): отдаём maxChunkBytes, то есть прежнее чисто
 * байтовое поведение, а не куски произвольного (нулевого) размера.
 */
function chunkSizeFor(totalDataBytes: number, bytesPerSecond: number, maxChunkBytes: number): number {
  if (bytesPerSecond <= 0 || maxChunkBytes <= 0) return maxChunkBytes;
  const byTimeTarget = Math.max(1, Math.round(bytesPerSecond * TARGET_CHUNK_SECONDS));
  const partsByTimeTarget = Math.ceil(totalDataBytes / byTimeTarget);
  if (partsByTimeTarget <= MAX_PARTS) return Math.min(byTimeTarget, maxChunkBytes);
  // По времени кусков вышло бы больше предела — растим кусок настолько, чтобы вся
  // запись поместилась ровно в MAX_PARTS штук, а не теряла хвост сверх предела.
  const grownForMaxParts = Math.ceil(totalDataBytes / MAX_PARTS);
  return Math.min(grownForMaxParts, maxChunkBytes);
}

/** Заголовок исходного файла с исправленными размерами под кусок данных. */
function wavHeaderFor(buffer: Buffer, layout: WavLayout, chunkLength: number): Buffer {
  const header = Buffer.from(buffer.subarray(0, layout.headerEnd));
  // RIFF: размер всего файла минус первые 8 байт.
  header.writeUInt32LE(header.length - 8 + chunkLength, 4);
  // data: размер полезной части. Поле лежит ровно перед данными.
  header.writeUInt32LE(chunkLength, layout.dataStart - 4);
  return header;
}

/**
 * Режет запись на куски не больше `maxBytes`, целясь в TARGET_CHUNK_SECONDS речи на
 * кусок (см. докстринг наверху файла) — а не только в байтовый предел поставщика.
 *
 * `durationSec` — длительность ВСЕЙ записи в секундах, если она известна вызывающему
 * (recordingDurationSec звонка, см. lib/telephony/callRecordings.ts). Для WAV не
 * нужен — длительность куска считается точно из byteRate заголовка; для MP3/GSM это
 * единственный точный источник, без него длительность оценивается по типичному
 * битрейту станции (ESTIMATED_BYTES_PER_SEC).
 *
 * Возвращает пустой массив, когда резать нельзя (неизвестный формат): вызывающий
 * должен честно сказать, что расшифровки не будет, а не подсунуть модели обрывок.
 * Один кусок — файл и так помещается целиком.
 *
 * Кусков не больше MAX_PARTS: хвост сверх предела отбрасывается, и об этом говорит
 * `truncated` у результата (см. AudioParts) и строка в журнале.
 */
export function splitAudioForTranscription(
  buffer: Buffer,
  mediaType: string,
  maxBytes: number,
  durationSec?: number
): AudioParts {
  if (buffer.length <= maxBytes) return [buffer];

  if (isWav(buffer)) {
    const layout = readWavLayout(buffer);
    if (!layout) return [];
    const headerSize = layout.headerEnd;
    const maxChunkDataBytes = maxBytes - headerSize;
    if (maxChunkDataBytes <= 0) return [];
    // Цель по времени (TARGET_CHUNK_SECONDS), выровненная по блоку сэмплов; если
    // byteRate не разобрался (заголовок без него), chunkSizeFor вернёт maxChunkDataBytes
    // — прежнее чисто байтовое поведение.
    const desiredChunkBytes = chunkSizeFor(layout.dataEnd - layout.dataStart, layout.byteRate, maxChunkDataBytes);
    /**
     * ВЫРАВНИВАНИЕ ВВЕРХ, А НЕ ВНИЗ (24.09.2026) — иначе «растим кусок, чтобы
     * уложиться в MAX_PARTS» (chunkSizeFor) может тихо не сработать: округление
     * desiredChunkBytes ВНИЗ до границы блока способно вернуть кусок чуть МЕНЬШЕ
     * расчётного, и на записи, где Math.ceil(total/MAX_PARTS) не делится на
     * blockAlign без остатка, это давало на один кусок больше, чем MAX_PARTS
     * (проверено тестом: 400 000 Б / 6 → 66 667, вниз до чётного — 66 666, а
     * 400 000 / 66 666 требует уже 7 кусков вместо 6, и хвост неожиданно терялся).
     * Округляем ВВЕРХ и только потом подрезаем под истинный байтовый потолок
     * (alignedMaxChunkBytes, выровненный ВНИЗ, — за него выйти нельзя): тогда
     * кусок либо не меньше расчётного (гарантия из chunkSizeFor держится), либо
     * упирается в потолок и включается прежняя обрезка хвоста, как и раньше.
     */
    const alignedMaxChunkBytes = Math.floor(maxChunkDataBytes / layout.blockAlign) * layout.blockAlign;
    const perChunk = Math.min(
      alignedMaxChunkBytes,
      Math.ceil(desiredChunkBytes / layout.blockAlign) * layout.blockAlign
    );
    if (perChunk <= 0) return [];

    const chunks: AudioParts = [];
    // Сколько кусков вышло бы без предела — считаем заранее, чтобы лишние даже не
    // собирать: каждый кусок WAV — это копия данных в памяти (Buffer.concat).
    const total = Math.ceil((layout.dataEnd - layout.dataStart) / perChunk);
    for (let at = layout.dataStart; at < layout.dataEnd && chunks.length < MAX_PARTS; at += perChunk) {
      const slice = buffer.subarray(at, Math.min(at + perChunk, layout.dataEnd));
      if (slice.length === 0) break;
      chunks.push(Buffer.concat([wavHeaderFor(buffer, layout, slice.length), slice]));
    }
    return markIfTruncated(chunks, total, buffer.length, mediaType);
  }

  /**
   * MP3 и GSM — потоки самостоятельных кадров: декодер подхватывает поток с любого
   * места, теряя в худшем случае один кадр (десятые доли секунды). Поэтому режем
   * просто по байтам — ГРАНИЦЫ реза остаются байтовыми и после 24.09.2026, меняется
   * только САМ размер куска (см. chunkSizeFor): цель по времени, а не структура резки.
   *
   * OGG так резать нельзя (страницы со своими заголовками и контрольными суммами),
   * и его здесь нет намеренно: записи разговоров с АТС приходят в wav/mp3/gsm, а
   * ogg — это голосовые из мессенджеров, которые в такие размеры не попадают.
   */
  if (mediaType === "audio/mpeg" || mediaType === "audio/gsm") {
    const bytesPerSecond =
      typeof durationSec === "number" && durationSec > 0
        ? buffer.length / durationSec
        : (ESTIMATED_BYTES_PER_SEC[mediaType] ?? 0);
    const chunkBytes = Math.min(chunkSizeFor(buffer.length, bytesPerSecond, maxBytes), maxBytes);
    const chunks: AudioParts = [];
    const total = Math.ceil(buffer.length / chunkBytes);
    for (let at = 0; at < buffer.length && chunks.length < MAX_PARTS; at += chunkBytes) {
      chunks.push(buffer.subarray(at, Math.min(at + chunkBytes, buffer.length)));
    }
    return markIfTruncated(chunks, total, buffer.length, mediaType);
  }

  return [];
}
