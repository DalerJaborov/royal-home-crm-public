/**
 * GPS ИЗ EXIF ФОТО, ПРЯМО В БРАУЗЕРЕ (найдено 17.09.2026, живая жалоба
 * владельца: карта в мастере просила геопозицию агента вместо того, чтобы
 * взять её с уже выбранного снимка).
 *
 * Сервер это уже умеет (apps/api/src/lib/propertyPhotoGeo.ts), но только на
 * финальной отправке объекта — во время самого мастера фото лежат в
 * черновике (PropertyDraftMedia) без какой-либо геообработки. Ждать отправки,
 * чтобы показать точку на карте, значит показывать её слишком поздно — агент
 * уже прошёл шаг «Где» вслепую. Здесь — тот же смысл (GPS-тег снимка), но
 * без похода на сервер: JPEG маленький, тег лежит в первых байтах файла,
 * fetch не нужен вовсе.
 *
 * ЗДЕСЬ — ТОЛЬКО JPEG и сам разбор TIFF/EXIF (`parseTiffGps`). HEIC/AVIF, PNG,
 * WebP и ВИДЕО разбирает lib/mediaGps.ts (02.10.2026) — он достаёт блок EXIF из
 * своего контейнера и зовёт отсюда тот же `parseTiffGps`, второй копии разбора
 * GPS-тегов нет.
 *
 * НИКОГДА НЕ БРОСАЕТ ИСКЛЮЧЕНИЕ НАРУЖУ: любой сбой разбора (битый файл, не
 * JPEG, нет GPS-тега) — это `null`, не ошибка. Карта в этом случае просто
 * остаётся там, где была (центр района/города), как и раньше без EXIF.
 */

/** Читаем только начало файла — EXIF лежит в первых килобайтах, весь файл не нужен. */
const HEADER_BYTES = 128 * 1024;

export interface ExifGpsPoint {
  lat: number;
  lng: number;
}

export async function readJpegGpsFromFile(file: Blob): Promise<ExifGpsPoint | null> {
  try {
    const buf = await file.slice(0, HEADER_BYTES).arrayBuffer();
    return parseJpegGps(buf);
  } catch {
    return null;
  }
}

/** Точка в разумных пределах и не (0,0) — иначе null. Общая проверка для всех форматов. */
export function plausiblePoint(lat: number, lng: number): ExifGpsPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // (0,0) — типичный признак пустого/бракованного GPS-тега (эмулятор, стёртые
  // метаданные), а не точка в Гвинейском заливе, где никто из агентов не снимает.
  if (lat === 0 && lng === 0) return null;
  return { lat, lng };
}

export function parseJpegGps(buf: ArrayBuffer): ExifGpsPoint | null {
  const view = new DataView(buf);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null; // не JPEG (SOI)

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break; // не маркер — разбор дальше бессмыслен
    const segLength = view.getUint16(offset + 2);
    if (marker === 0xffe1) {
      const segStart = offset + 4;
      if (segStart + 6 <= view.byteLength && readAscii(view, segStart, 4) === "Exif") {
        return parseTiffGps(view, segStart + 6);
      }
    }
    // 0xFFD8/0xFFD9 и 0xFFD0-D7 без длины — на GPS-поиске не встречаются раньше APP1
    if (marker === 0xffda) break; // начало сжатых данных — EXIF дальше не бывает
    offset += 2 + segLength;
  }
  return null;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Разбор TIFF/EXIF-блока, начинающегося с `tiffStart` (байты «II»/«MM»), → GPS-точка или null. Может бросить RangeError на битом файле — вызывающий ловит. */
export function parseTiffGps(view: DataView, tiffStart: number): ExifGpsPoint | null {
  if (tiffStart + 8 > view.byteLength) return null;
  const byteOrderMark = readAscii(view, tiffStart, 2);
  const little = byteOrderMark === "II";
  if (!little && byteOrderMark !== "MM") return null;

  const magic = view.getUint16(tiffStart + 2, little);
  if (magic !== 42) return null;

  const ifd0Offset = view.getUint32(tiffStart + 4, little);
  const gpsIfdOffset = findTagOffset(view, tiffStart, tiffStart + ifd0Offset, little, 0x8825);
  if (gpsIfdOffset === null) return null;

  // Теги GPS IFD: 0x0001 LatitudeRef, 0x0002 Latitude, 0x0003 LongitudeRef,
  // 0x0004 Longitude (перепутаны местами в первой версии — поймано тестом,
  // scratchpad/test-exif.mjs, широта читалась верно, долгота — нет).
  const gpsStart = tiffStart + gpsIfdOffset;
  const latRef = readAsciiTag(view, gpsStart, little, 0x0001);
  const lat = readRationalTriplet(view, tiffStart, gpsStart, little, 0x0002);
  const lngRef = readAsciiTag(view, gpsStart, little, 0x0003);
  const lng = readRationalTriplet(view, tiffStart, gpsStart, little, 0x0004);
  if (lat === null || lng === null) return null;

  const signedLat = latRef === "S" ? -lat : lat;
  const signedLng = lngRef === "W" ? -lng : lng;
  return plausiblePoint(signedLat, signedLng);
}

/** Ищем тег в указанном IFD; для 0x8825 значение — само есть смещение вложенного IFD. */
function findTagOffset(
  view: DataView,
  tiffStart: number,
  ifdStart: number,
  little: boolean,
  tag: number
): number | null {
  if (ifdStart + 2 > view.byteLength) return null;
  const count = view.getUint16(ifdStart, little);
  for (let i = 0; i < count; i++) {
    const entryStart = ifdStart + 2 + i * 12;
    if (entryStart + 12 > view.byteLength) return null;
    if (view.getUint16(entryStart, little) === tag) {
      return view.getUint32(entryStart + 8, little);
    }
  }
  return null;
}

/**
 * GPSLatitudeRef/GPSLongitudeRef — тип ASCII, 2 байта («N\0»/«S\0»). TIFF
 * кладёт значения ≤4 байт ПРЯМО в 4-байтовое поле записи, а не по смещению —
 * и, в отличие от чисел, байты строки лежат в файловом порядке всегда, порядок
 * байт (little/big-endian) их не переставляет. Поэтому здесь — сырое чтение
 * первого байта поля, а не generic-разбор через findEntry/getUint32.
 */
function readAsciiTag(
  view: DataView,
  ifdStart: number,
  little: boolean,
  tag: number
): string | null {
  const entryStart = findEntryStart(view, ifdStart, little, tag);
  if (entryStart === null) return null;
  return String.fromCharCode(view.getUint8(entryStart + 8));
}

/** GPSLatitude/GPSLongitude — тип RATIONAL×3 (градусы, минуты, секунды), 24 байта по смещению. */
function readRationalTriplet(
  view: DataView,
  tiffStart: number,
  ifdStart: number,
  little: boolean,
  tag: number
): number | null {
  const entry = findEntry(view, ifdStart, little, tag);
  if (!entry || entry.type !== 5 || entry.count < 3) return null;
  const dataStart = tiffStart + entry.valueOffset;
  if (dataStart + 24 > view.byteLength) return null;
  const deg = readRational(view, dataStart, little);
  const min = readRational(view, dataStart + 8, little);
  const sec = readRational(view, dataStart + 16, little);
  if (deg === null || min === null || sec === null) return null;
  return deg + min / 60 + sec / 3600;
}

function readRational(view: DataView, offset: number, little: boolean): number | null {
  const num = view.getUint32(offset, little);
  const den = view.getUint32(offset + 4, little);
  if (den === 0) return null;
  return num / den;
}

interface IfdEntry {
  type: number;
  count: number;
  /** Для ASCII/значений ≤4 байт — сам инлайн-байт; для RATIONAL — смещение от начала TIFF. */
  valueOffset: number;
}

function findEntry(view: DataView, ifdStart: number, little: boolean, tag: number): IfdEntry | null {
  const entryStart = findEntryStart(view, ifdStart, little, tag);
  if (entryStart === null) return null;
  return {
    type: view.getUint16(entryStart + 2, little),
    count: view.getUint32(entryStart + 4, little),
    valueOffset: view.getUint32(entryStart + 8, little),
  };
}

/** Смещение самой записи (12 байт: tag,type,count,value) внутри IFD — без интерпретации поля value. */
function findEntryStart(view: DataView, ifdStart: number, little: boolean, tag: number): number | null {
  if (ifdStart + 2 > view.byteLength) return null;
  const count = view.getUint16(ifdStart, little);
  for (let i = 0; i < count; i++) {
    const entryStart = ifdStart + 2 + i * 12;
    if (entryStart + 12 > view.byteLength) return null;
    if (view.getUint16(entryStart, little) === tag) return entryStart;
  }
  return null;
}
