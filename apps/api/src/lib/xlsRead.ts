import { excelSerialDate } from "./xlsxRead.js";

/**
 * ЧТЕНИЕ СТАРОГО .xls (Excel 97–2003, BIFF8) БЕЗ ЗАВИСИМОСТЕЙ (10.11.2026).
 *
 * Почему не библиотека: SheetJS в npm (`xlsx`) застыл на 0.18.5 с открытыми уязвимостями
 * (прототип и ReDoS при чтении чужого файла — исправлены только в сборках с сайта SheetJS, не в npm),
 * а чтение — ровно то, что мы делаем с файлом из чата. Формат простой: контейнер Compound File
 * (сектора, FAT, каталог) и поток `Workbook` из записей BIFF. Читаем первый лист: строки (SST,
 * LABELSST, LABEL), числа (NUMBER, RK, MULRK), формулы по сохранённому значению (FORMULA+STRING),
 * дату — по формату ячейки (XF → FORMAT). Пределы против бомб: размер файла, число секторов,
 * длина цепочек, число строк и записей; цикл в цепочке сектора — отказ.
 */

export class XlsReadError extends Error {}

const MAX_FILE_BYTES = 10_000_000;
const MAX_ROWS = 5_000;
const MAX_COLS = 200;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

function fail(why: string): never {
  throw new XlsReadError(why);
}

/** Поток `Workbook` (или `Book`) из контейнера Compound File. */
function workbookStream(buf: Buffer): Buffer {
  if (buf.length > MAX_FILE_BYTES || buf.length < 512) fail("size");
  if (buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1) fail("not cfb");
  const sectorSize = 1 << buf.readUInt16LE(0x1e);
  const miniSize = 1 << buf.readUInt16LE(0x20);
  if (sectorSize !== 512 && sectorSize !== 4096) fail("sector size");
  const fatSectors = buf.readUInt32LE(0x2c);
  const firstDir = buf.readUInt32LE(0x30);
  const miniCutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  const firstDifat = buf.readUInt32LE(0x44);
  const totalSectors = Math.floor((buf.length - 512) / sectorSize);
  const sector = (n: number) => {
    if (n >= totalSectors) fail("sector out of range");
    return buf.subarray(512 + n * sectorSize, 512 + (n + 1) * sectorSize);
  };
  // DIFAT: первые 109 записей в заголовке, остальное — цепочкой секторов.
  const difat: number[] = [];
  for (let i = 0; i < 109; i++) difat.push(buf.readUInt32LE(0x4c + i * 4));
  let next = firstDifat;
  for (let guard = 0; next !== ENDOFCHAIN && next !== FREESECT; guard++) {
    if (guard > totalSectors) fail("difat loop");
    const s = sector(next);
    for (let i = 0; i < sectorSize / 4 - 1; i++) difat.push(s.readUInt32LE(i * 4));
    next = s.readUInt32LE(sectorSize - 4);
  }
  const fat: number[] = [];
  for (const id of difat.slice(0, fatSectors)) {
    if (id === FREESECT) continue;
    const s = sector(id);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(s.readUInt32LE(i * 4));
  }
  const chain = (start: number, table: number[], limit: number) => {
    const out: number[] = [];
    const seen = new Set<number>();
    for (let n = start; n !== ENDOFCHAIN && n !== FREESECT; n = table[n] ?? ENDOFCHAIN) {
      if (seen.has(n) || out.length > limit) fail("chain loop");
      seen.add(n);
      out.push(n);
    }
    return out;
  };
  const readChain = (start: number, size?: number) => {
    const data = Buffer.concat(chain(start, fat, totalSectors).map(sector));
    return size === undefined ? data : data.subarray(0, size);
  };
  const dir = readChain(firstDir);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = dir.readUInt16LE(off + 0x40);
    if (nameLen < 2 || nameLen > 64) { entries.push({ name: "", type: 0, start: 0, size: 0 }); continue; }
    entries.push({
      name: dir.subarray(off, off + nameLen - 2).toString("utf16le"),
      type: dir[off + 0x42]!, start: dir.readUInt32LE(off + 0x74), size: dir.readUInt32LE(off + 0x78),
    });
  }
  const root = entries[0];
  const book = entries.find((e) => e.type === 2 && (e.name === "Workbook" || e.name === "Book"));
  if (!root || !book) fail("no workbook");
  if (book.size > MAX_FILE_BYTES * 4) fail("stream too large");
  if (book.size >= miniCutoff) return readChain(book.start, book.size);
  // Маленький поток — в мини-потоке корня (сектора по 64 байта).
  const miniStream = readChain(root.start, root.size);
  const miniFat: number[] = [];
  const miniFatData = firstMiniFat === ENDOFCHAIN ? Buffer.alloc(0) : readChain(firstMiniFat);
  for (let i = 0; i + 4 <= miniFatData.length; i += 4) miniFat.push(miniFatData.readUInt32LE(i));
  const parts = chain(book.start, miniFat, miniStream.length / miniSize + 1).map((n) => miniStream.subarray(n * miniSize, (n + 1) * miniSize));
  return Buffer.concat(parts).subarray(0, book.size);
}

/** Строка BIFF8 (XLUnicodeRichExtendedString) с продолжением в записях CONTINUE. */
class Reader {
  constructor(private readonly chunks: Buffer[], private part = 0, private pos = 0) {}
  private get cur() { return this.chunks[this.part]!; }
  private ensure(n: number) {
    if (this.pos + n > this.cur.length && this.part + 1 < this.chunks.length && this.pos >= this.cur.length) { this.part++; this.pos = 0; }
    if (this.pos + n > this.cur.length) fail("truncated record");
  }
  u8() { this.ensure(1); return this.cur[this.pos++]!; }
  u16() { this.ensure(2); const v = this.cur.readUInt16LE(this.pos); this.pos += 2; return v; }
  u32() { this.ensure(4); const v = this.cur.readUInt32LE(this.pos); this.pos += 4; return v; }
  skip(n: number) { while (n > 0) { if (this.pos >= this.cur.length) { if (this.part + 1 >= this.chunks.length) fail("truncated"); this.part++; this.pos = 0; } const k = Math.min(n, this.cur.length - this.pos); this.pos += k; n -= k; } }
  string(charCount: number, wide: boolean): string {
    let out = "";
    let left = charCount;
    let isWide = wide;
    while (left > 0) {
      if (this.pos >= this.cur.length) {
        // На границе CONTINUE строка продолжается с нового байта флагов.
        if (this.part + 1 >= this.chunks.length) fail("truncated string");
        this.part++; this.pos = 0;
        isWide = (this.u8() & 1) === 1;
      }
      const width = isWide ? 2 : 1;
      const can = Math.min(left, Math.floor((this.cur.length - this.pos) / width));
      if (can <= 0) fail("bad string");
      const slice = this.cur.subarray(this.pos, this.pos + can * width);
      out += isWide ? slice.toString("utf16le") : slice.toString("latin1");
      this.pos += can * width;
      left -= can;
    }
    return out;
  }
  unicode(lenBytes: 1 | 2 = 2): string {
    const count = lenBytes === 2 ? this.u16() : this.u8();
    const flags = this.u8();
    const rich = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    const text = this.string(count, (flags & 1) === 1);
    this.skip(rich * 4 + ext);
    return text;
  }
}

function rkValue(rk: number): number {
  const v = rk & 0x02 ? (rk >> 2) : (() => { const b = Buffer.alloc(8); b.writeUInt32LE(rk & 0xfffffffc, 4); return b.readDoubleLE(0); })();
  return rk & 0x01 ? v / 100 : v;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const isDateFormat = (id: number, code?: string) => {
  if (BUILTIN_DATE_FORMATS.has(id)) return true;
  const bare = (code ?? "").replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
  return !!bare && /[dmyдмг]/i.test(bare) && !/[#0?]/.test(bare);
};
const currencyOf = (code?: string) => {
  if (!code) return undefined;
  const bracket = /\[\$([^\]-]*)/.exec(code)?.[1];
  const sign = bracket ? bracket : code.replace(/"[^"]*"/g, "");
  return /€|EUR/i.test(sign) ? "€" : /₽|р\.|RUB/i.test(sign) ? "₽" : /TJS|сомон|смн/i.test(sign) ? "TJS" : /\$|USD/i.test(sign) ? "$" : undefined;
};
const formatNumber = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));

/** Первый лист .xls: строки ячеек-строк, пустые строки опущены. */
export function readXlsFirstSheet(buf: Buffer): string[][] {
  const stream = workbookStream(buf);
  const records: { type: number; data: Buffer; continues: Buffer[] }[] = [];
  for (let off = 0; off + 4 <= stream.length;) {
    const type = stream.readUInt16LE(off);
    const len = stream.readUInt16LE(off + 2);
    const data = stream.subarray(off + 4, off + 4 + len);
    off += 4 + len;
    if (type === 0x3c && records.length) records.at(-1)!.continues.push(data);
    else records.push({ type, data, continues: [] });
    if (records.length > 2_000_000) fail("too many records");
  }
  const sst: string[] = [];
  const formats = new Map<number, string>();
  const xfFormat: number[] = [];
  let globals = true;
  let sheetsSeen = 0;
  const rows = new Map<number, string[]>();
  let pendingFormula: { row: number; col: number } | null = null;
  const put = (row: number, col: number, value: string) => {
    if (col >= MAX_COLS) return;
    if (!rows.has(row)) { if (rows.size >= MAX_ROWS) fail("too many rows"); rows.set(row, []); }
    const cells = rows.get(row)!;
    while (cells.length < col) cells.push("");
    cells[col] = value;
  };
  const numberCell = (row: number, col: number, xf: number, value: number) => {
    const fmt = xfFormat[xf] ?? 0;
    const code = formats.get(fmt);
    if (isDateFormat(fmt, code) && value > 0 && value < 2_958_466) put(row, col, excelSerialDate(value));
    else { const cur = currencyOf(code); put(row, col, cur ? `${formatNumber(value)} ${cur}` : formatNumber(value)); }
  };
  for (const record of records) {
    const { type, data } = record;
    if (type === 0x809) { // BOF
      const kind = data.length >= 4 ? data.readUInt16LE(2) : 0;
      if (kind === 0x10) { sheetsSeen++; globals = false; }
      continue;
    }
    if (type === 0x0a) { if (!globals && sheetsSeen >= 1) break; continue; } // EOF первого листа — конец
    if (globals) {
      if (type === 0x41e) { const r = new Reader([data, ...record.continues]); const id = r.u16(); formats.set(id, r.unicode(2)); }
      else if (type === 0xe0) xfFormat.push(data.readUInt16LE(2));
      else if (type === 0xfc) {
        const r = new Reader([data, ...record.continues]);
        r.u32();
        const unique = r.u32();
        if (unique > 1_000_000) fail("sst too large");
        for (let i = 0; i < unique; i++) sst.push(r.unicode(2));
      }
      continue;
    }
    if (data.length < 4) continue;
    const row = data.readUInt16LE(0);
    const col = data.readUInt16LE(2);
    if (type === 0xfd && data.length >= 10) put(row, col, sst[data.readUInt32LE(6)] ?? "");
    else if (type === 0x204) put(row, col, new Reader([data.subarray(6), ...record.continues]).unicode(2));
    else if (type === 0x203 && data.length >= 14) numberCell(row, col, data.readUInt16LE(4), data.readDoubleLE(6));
    else if (type === 0x27e && data.length >= 10) numberCell(row, col, data.readUInt16LE(4), rkValue(data.readUInt32LE(6)));
    else if (type === 0xbd) {
      const last = data.readUInt16LE(data.length - 2);
      for (let c = col, off = 4; c <= last && off + 6 <= data.length - 2; c++, off += 6) numberCell(row, c, data.readUInt16LE(off), rkValue(data.readUInt32LE(off + 2)));
    } else if (type === 0x06 && data.length >= 14) {
      // FORMULA: сохранённый результат. 0xFFFF в старших байтах — не число (строка придёт в STRING).
      if (data.readUInt16LE(12) === 0xffff) { if (data[6] === 0) pendingFormula = { row, col }; }
      else numberCell(row, col, data.readUInt16LE(4), data.readDoubleLE(6));
    } else if (type === 0x207 && pendingFormula) {
      put(pendingFormula.row, pendingFormula.col, new Reader([data, ...record.continues]).unicode(2));
      pendingFormula = null;
    }
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) => cells).filter((cells) => cells.some((c) => c.trim()));
}
