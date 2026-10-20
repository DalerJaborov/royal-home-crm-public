/**
 * ТОЧКА ИЗ ЛЮБОГО СНИМКА И РОЛИКА, ПРЯМО В БРАУЗЕРЕ (02.10.2026, Dan: «по фото
 * и видео точка должна находиться всегда, в любом формате — и с iPhone, и с
 * Android»).
 *
 * Раньше читали только JPEG (lib/exifGps.ts). iPhone по умолчанию снимает HEIC,
 * а ролик носит координаты не в EXIF, а в своём контейнере. Здесь — одна точка
 * входа `readGpsFromFile(file)`, формат определяется по СОДЕРЖИМУ (имя и
 * MIME-тип у телефонов врут или пусты):
 *
 * - JPEG — как раньше (exifGps.ts);
 * - HEIC/HEIF/AVIF (ISO BMFF): `meta` → `iinf` (элемент типа «Exif») → `iloc`
 *   (где лежит) → TIFF-блок → тот же `parseTiffGps`, что и у JPEG;
 * - PNG (чанк eXIf) и WebP (чанк EXIF) — тот же TIFF-блок;
 * - видео MP4/MOV/3GP (ISO BMFF): `moov/udta/©xyz` (Android и старые iPhone) и
 *   `moov/meta` с ключом `com.apple.quicktime.location.ISO6709` (современный
 *   iPhone), значение — строка ISO 6709 «+38.5598+068.7870/».
 *
 * `moov` у Android лежит в КОНЦЕ файла, после сотен мегабайт `mdat`, поэтому
 * файл целиком не читаем никогда: идём по заголовкам боксов через `Blob.slice`
 * (по 16 байт на бокс), перепрыгивая тела.
 *
 * НИКОГДА НЕ БРОСАЕТ НАРУЖУ: любой сбой — `null`. Точка (0,0) и точка вне
 * допустимых пределов — тоже `null`.
 *
 * ЧЕГО КОД ОБОЙТИ НЕ МОЖЕТ: если точки нет в самом файле, искать нечего. Выбор
 * из «Фотографий» на Android (Photo Picker) и iOS без разрешения «Параметры →
 * Геопозиция» браузер получает файл УЖЕ с вырезанной геометкой.
 */
import { parseTiffGps, plausiblePoint, readJpegGpsFromFile, type ExifGpsPoint } from "./exifGps";

type Src = Pick<Blob, "size" | "slice">;

/** Потолки на случай битого или враждебного файла. */
const MAX_BOXES = 4000;
const MAX_META_BYTES = 8 * 1024 * 1024;
const MAX_EXIF_BYTES = 1024 * 1024;

export async function readGpsFromFile(file: Blob): Promise<ExifGpsPoint | null> {
  try {
    const head = await readBytes(file, 0, 16);
    if (!head || head.byteLength < 12) return null;
    if (head.getUint16(0) === 0xffd8) return await readJpegGpsFromFile(file);
    if (head.getUint32(0) === 0x89504e47 && head.getUint32(4) === 0x0d0a1a0a) return await readPngGps(file);
    if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return await readWebpGps(file);
    if (ascii(head, 4, 4) === "ftyp") return await readIsoBmffGps(file);
    return null;
  } catch {
    return null;
  }
}

// ───────────────────────────── общие помощники ─────────────────────────────

async function readBytes(src: Src, start: number, length: number): Promise<DataView | null> {
  if (start < 0 || length <= 0 || start >= src.size) return null;
  const buf = await src.slice(start, Math.min(start + length, src.size)).arrayBuffer();
  return new DataView(buf);
}

function ascii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** uint размером 0/1/2/4/8 байт (8 — без потери точности до 2^53, дальше файлы не бывают). */
function readUint(view: DataView, pos: number, size: number): number {
  switch (size) {
    case 0:
      return 0;
    case 1:
      return view.getUint8(pos);
    case 2:
      return view.getUint16(pos);
    case 4:
      return view.getUint32(pos);
    case 8:
      return view.getUint32(pos) * 2 ** 32 + view.getUint32(pos + 4);
    default:
      throw new RangeError("bad int size");
  }
}

/** TIFF-блок (с необязательным префиксом «Exif\0\0») из файла → точка. */
async function gpsFromTiffBlock(src: Src, start: number, length: number): Promise<ExifGpsPoint | null> {
  const view = await readBytes(src, start, Math.min(length, MAX_EXIF_BYTES));
  if (!view || view.byteLength < 8) return null;
  const tiffStart = ascii(view, 0, 4) === "Exif" ? 6 : 0;
  return parseTiffGps(view, tiffStart);
}

// ───────────────────────────── ISO BMFF: боксы ─────────────────────────────

interface Box {
  type: string;
  /** Начало бокса (заголовка). */
  start: number;
  /** Где начинается тело. */
  bodyStart: number;
  /** Конец бокса (за последним байтом). */
  end: number;
}

async function readBox(src: Src, offset: number, limit: number): Promise<Box | null> {
  if (offset + 8 > limit) return null;
  const v = await readBytes(src, offset, 16);
  if (!v || v.byteLength < 8) return null;
  let size = v.getUint32(0);
  const type = ascii(v, 4, 4);
  let header = 8;
  if (size === 1) {
    if (v.byteLength < 16) return null;
    size = v.getUint32(8) * 2 ** 32 + v.getUint32(12); // largesize
    header = 16;
  } else if (size === 0) {
    size = limit - offset; // до конца файла/родителя
  }
  if (size < header || offset + size > limit) {
    // Обрезанный хвост файла: тело считаем до конца, но заголовок должен быть целым.
    if (size < header) return null;
    size = limit - offset;
  }
  return { type, start: offset, bodyStart: offset + header, end: offset + size };
}

/** Дети бокса в диапазоне [from, to): по одному заголовку, тела не читаем. */
async function* boxesIn(src: Src, from: number, to: number): AsyncGenerator<Box> {
  let pos = from;
  for (let i = 0; i < MAX_BOXES; i++) {
    const box = await readBox(src, pos, to);
    if (!box) return;
    yield box;
    if (box.end <= pos) return;
    pos = box.end;
  }
}

async function findChild(src: Src, parent: { bodyStart: number; end: number }, type: string): Promise<Box | null> {
  for await (const box of boxesIn(src, parent.bodyStart, parent.end)) {
    if (box.type === type) return box;
  }
  return null;
}

// ───────────────────────────── ISO BMFF: общий проход ─────────────────────────────

async function readIsoBmffGps(file: Src): Promise<ExifGpsPoint | null> {
  // Один проход по верхнему уровню: `meta` (фото) и `moov` (видео); `mdat` и
  // прочие тяжёлые тела перепрыгиваем.
  for await (const box of boxesIn(file, 0, file.size)) {
    if (box.type === "meta") {
      const p = await heifExifGps(file, box);
      if (p) return p;
    } else if (box.type === "moov") {
      const p = await movieGps(file, box);
      if (p) return p;
    }
  }
  return null;
}

// ───────────────────────────── HEIC / HEIF / AVIF ─────────────────────────────

async function heifExifGps(file: Src, meta: Box): Promise<ExifGpsPoint | null> {
  // meta — FullBox: 4 байта версии/флагов перед детьми.
  const inner = { bodyStart: meta.bodyStart + 4, end: meta.end };
  if (inner.end - inner.bodyStart > MAX_META_BYTES * 8) return null;

  const iinf = await findChild(file, inner, "iinf");
  const iloc = await findChild(file, inner, "iloc");
  if (!iinf || !iloc) return null;

  const exifId = await findExifItemId(file, iinf);
  if (exifId === null) return null;

  const loc = await findItemExtent(file, iloc, exifId);
  if (!loc) return null;

  const view = await readBytes(file, loc.offset, Math.min(loc.length, MAX_EXIF_BYTES));
  if (!view || view.byteLength < 12) return null;
  // Первые 4 байта — exif_tiff_header_offset: сколько пропустить до «II»/«MM»
  // (обычно 6 — это префикс «Exif\0\0»).
  const skip = view.getUint32(0);
  const tiffStart = 4 + skip;
  if (tiffStart + 8 > view.byteLength) return null;
  return parseTiffGps(view, tiffStart);
}

async function findExifItemId(file: Src, iinf: Box): Promise<number | null> {
  const head = await readBytes(file, iinf.bodyStart, 8);
  if (!head || head.byteLength < 6) return null;
  const version = head.getUint8(0);
  const childrenStart = iinf.bodyStart + 4 + (version === 0 ? 2 : 4);
  for await (const infe of boxesIn(file, childrenStart, iinf.end)) {
    if (infe.type !== "infe") continue;
    const id = await parseInfe(file, infe);
    if (id !== null) return id;
  }
  return null;
}

/** Идентификатор элемента типа «Exif» в одном `infe`, либо null. */
async function parseInfe(file: Src, infe: Box): Promise<number | null> {
  const v = await readBytes(file, infe.bodyStart, 16);
  if (!v || v.byteLength < 12) return null;
  const version = v.getUint8(0);
  if (version === 2) {
    // ver/flags(4) item_ID(2) protection(2) item_type(4)
    return ascii(v, 8, 4) === "Exif" ? v.getUint16(4) : null;
  }
  if (version === 3 && v.byteLength >= 14) {
    // ver/flags(4) item_ID(4) protection(2) item_type(4)
    return ascii(v, 10, 4) === "Exif" ? v.getUint32(4) : null;
  }
  return null;
}

async function findItemExtent(file: Src, iloc: Box, itemId: number): Promise<{ offset: number; length: number } | null> {
  const total = Math.min(iloc.end - iloc.bodyStart, MAX_META_BYTES);
  const v = await readBytes(file, iloc.bodyStart, total);
  if (!v || v.byteLength < 8) return null;
  const version = v.getUint8(0);
  const offsetSize = v.getUint8(4) >> 4;
  const lengthSize = v.getUint8(4) & 0x0f;
  const baseOffsetSize = v.getUint8(5) >> 4;
  const indexSize = version === 1 || version === 2 ? v.getUint8(5) & 0x0f : 0;
  let pos = 6;
  let itemCount: number;
  if (version < 2) {
    itemCount = v.getUint16(pos);
    pos += 2;
  } else {
    itemCount = v.getUint32(pos);
    pos += 4;
  }
  for (let i = 0; i < itemCount; i++) {
    let id: number;
    if (version < 2) {
      id = v.getUint16(pos);
      pos += 2;
    } else {
      id = v.getUint32(pos);
      pos += 4;
    }
    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = v.getUint16(pos) & 0x0f;
      pos += 2;
    }
    pos += 2; // data_reference_index
    const baseOffset = readUint(v, pos, baseOffsetSize);
    pos += baseOffsetSize;
    const extentCount = v.getUint16(pos);
    pos += 2;
    let first: { offset: number; length: number } | null = null;
    for (let e = 0; e < extentCount; e++) {
      pos += indexSize;
      const extentOffset = readUint(v, pos, offsetSize);
      pos += offsetSize;
      const extentLength = readUint(v, pos, lengthSize);
      pos += lengthSize;
      if (!first) first = { offset: baseOffset + extentOffset, length: extentLength };
    }
    if (id === itemId) {
      // construction_method 0 — смещение от начала файла; остальные (idat, item) для Exif не встречаются.
      return constructionMethod === 0 ? first : null;
    }
  }
  return null;
}

// ───────────────────────────── видео MP4 / MOV / 3GP ─────────────────────────────

async function movieGps(file: Src, moov: Box): Promise<ExifGpsPoint | null> {
  const udta = await findChild(file, moov, "udta");
  if (udta) {
    const xyz = await findChild(file, udta, "©xyz");
    if (xyz) {
      const p = await readIso6709Box(file, xyz);
      if (p) return p;
    }
  }
  const meta = await findChild(file, moov, "meta");
  if (meta) {
    const p = await quickTimeMetaGps(file, meta);
    if (p) return p;
  }
  return null;
}

/** «©xyz»: uint16 длина, uint16 язык, затем строка ISO 6709. Без заголовка — просто строка. */
async function readIso6709Box(file: Src, box: Box): Promise<ExifGpsPoint | null> {
  const view = await readBytes(file, box.bodyStart, Math.min(box.end - box.bodyStart, 256));
  if (!view) return null;
  const text = ascii(view, 0, view.byteLength);
  return parseIso6709(text.slice(4)) ?? parseIso6709(text);
}

async function quickTimeMetaGps(file: Src, meta: Box): Promise<ExifGpsPoint | null> {
  // QuickTime кладёт `meta` без 4 байт версии/флагов (сразу `hdlr`), ISO — с ними.
  const peek = await readBytes(file, meta.bodyStart, 8);
  if (!peek || peek.byteLength < 8) return null;
  const childrenStart = ascii(peek, 4, 4) === "hdlr" ? meta.bodyStart : meta.bodyStart + 4;
  const inner = { bodyStart: childrenStart, end: meta.end };

  const keys = await findChild(file, inner, "keys");
  const ilst = await findChild(file, inner, "ilst");
  if (!keys || !ilst) return null;

  const keyIndex = await findKeyIndex(file, keys, "com.apple.quicktime.location.ISO6709");
  if (keyIndex === null) return null;

  for await (const item of boxesIn(file, ilst.bodyStart, ilst.end)) {
    // Тип элемента ilst — это uint32-номер ключа (с единицы), а не буквы.
    const idx = await readBytes(file, item.start + 4, 4);
    if (!idx || idx.getUint32(0) !== keyIndex) continue;
    const data = await findChild(file, item, "data");
    if (!data) continue;
    // data: тип(4) локаль(4) значение
    const view = await readBytes(file, data.bodyStart + 8, Math.min(data.end - data.bodyStart - 8, 256));
    if (!view) continue;
    const p = parseIso6709(ascii(view, 0, view.byteLength));
    if (p) return p;
  }
  return null;
}

/** Номер (с 1) ключа в `keys`: версия/флаги(4) число(4), затем [размер(4) пространство(4) имя]. */
async function findKeyIndex(file: Src, keys: Box, name: string): Promise<number | null> {
  const view = await readBytes(file, keys.bodyStart, Math.min(keys.end - keys.bodyStart, 64 * 1024));
  if (!view || view.byteLength < 8) return null;
  const count = view.getUint32(4);
  let pos = 8;
  for (let i = 1; i <= count && pos + 8 <= view.byteLength; i++) {
    const size = view.getUint32(pos);
    if (size < 8) return null;
    if (pos + size > view.byteLength) return null;
    if (ascii(view, pos + 8, size - 8) === name) return i;
    pos += size;
  }
  return null;
}

/** ISO 6709 в десятичных градусах: «+38.5598+068.7870/», «+38.5598+068.7870+012.3/». */
export function parseIso6709(text: string): ExifGpsPoint | null {
  const m = /^\s*([+-]\d{1,3}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  return plausiblePoint(Number(m[1]), Number(m[2]));
}

// ───────────────────────────── PNG и WebP ─────────────────────────────

async function readPngGps(file: Src): Promise<ExifGpsPoint | null> {
  let pos = 8;
  for (let i = 0; i < MAX_BOXES && pos + 8 <= file.size; i++) {
    const v = await readBytes(file, pos, 8);
    if (!v || v.byteLength < 8) return null;
    const len = v.getUint32(0);
    const type = ascii(v, 4, 4);
    if (type === "eXIf") return await gpsFromTiffBlock(file, pos + 8, len);
    if (type === "IEND") return null;
    pos += 12 + len; // длина + тип + данные + CRC
  }
  return null;
}

async function readWebpGps(file: Src): Promise<ExifGpsPoint | null> {
  let pos = 12;
  for (let i = 0; i < MAX_BOXES && pos + 8 <= file.size; i++) {
    const v = await readBytes(file, pos, 8);
    if (!v || v.byteLength < 8) return null;
    const type = ascii(v, 0, 4);
    const len = v.getUint32(4, true);
    if (type === "EXIF") return await gpsFromTiffBlock(file, pos + 8, len);
    pos += 8 + len + (len % 2); // чанки выровнены по чётному
  }
  return null;
}
