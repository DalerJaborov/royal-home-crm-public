import { inflateRawSync } from "node:zlib";

/**
 * ЧТЕНИЕ .xlsx БЕЗ ЗАВИСИМОСТЕЙ (10.11.2026): первый лист как таблица строк-ячеек.
 *
 * .xlsx — zip с XML внутри. Читаем центральный каталог zip, распаковываем только
 * `xl/sharedStrings.xml`, `xl/workbook.xml`, его связи и первый лист. Защита от «zip-бомбы»:
 * предел на распакованный размер каждого файла и на число файлов. Формулы не вычисляем —
 * берём закэшированное значение ячейки, как его сохранил Excel. Старый .xls (двоичный BIFF)
 * не читается: вызывающий просит сохранить файл как .xlsx или .csv.
 */

const MAX_ENTRIES = 2_000;
const MAX_UNCOMPRESSED = 30 * 1024 * 1024;
export const MAX_SHEET_ROWS = 5_000;

export class XlsxReadError extends Error {}

interface ZipEntry { name: string; method: number; compressedSize: number; size: number; offset: number }

function entries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxReadError("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new XlsxReadError("too many entries");
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) throw new XlsxReadError("bad central directory");
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    out.push({ name: buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8"), method, compressedSize, size, offset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function read(buf: Buffer, entry: ZipEntry): string {
  if (entry.size > MAX_UNCOMPRESSED) throw new XlsxReadError("entry too large");
  const p = entry.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new XlsxReadError("bad local header");
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  const raw = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED }) : null;
  if (!raw) throw new XlsxReadError("unsupported compression");
  return raw.toString("utf8");
}

const decode = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, "&");

/** Текст всех <t> внутри узла (у «богатого» текста их несколько). */
const texts = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1]!)).join("");

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Серийный номер даты Excel (система 1900) → YYYY-MM-DD. */
export function excelSerialDate(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Формат каждого стиля ячейки: дата или валюта (по коду формата, в т. ч. [$$-409], €, ₽). */
function cellFormats(styles: string): { date?: boolean; currency?: string }[] {
  if (!styles) return [];
  const custom = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(m[1]!)?.[1]);
    const code = /\bformatCode="([^"]*)"/.exec(m[1]!)?.[1];
    if (Number.isFinite(id) && code !== undefined) custom.set(id, decode(code));
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "";
  return [...xfs.matchAll(/<xf\b([^>]*)\/?>/g)].map((m) => {
    const id = Number(/\bnumFmtId="(\d+)"/.exec(m[1]!)?.[1] ?? 0);
    const code = custom.get(id) ?? "";
    const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "");
    const date = BUILTIN_DATE_FORMATS.has(id) || (!!bare && /[dmyдмг]/i.test(bare) && !/[#0?]/.test(bare));
    // «[$€-1]» — знак валюты в скобках после «[$»; без скобок — знак в самом формате.
    const bracket = /\[\$([^\]-]*)/.exec(code)?.[1];
    const sign = bracket !== undefined && bracket !== "" ? bracket : code.replace(/"[^"]*"/g, "");
    const currency = /€|EUR/i.test(sign) ? "€" : /₽|р\.|RUB/i.test(sign) ? "₽" : /TJS|сомон|смн/i.test(sign) ? "TJS"
      : /\$|USD/i.test(sign) || [5, 6, 7, 8].includes(id) ? "$" : undefined;
    return { ...(date ? { date } : {}), ...(currency && !date ? { currency } : {}) };
  });
}

/** Первый лист книги: массив строк, пустые строки опущены. Числа — строкой, как в файле. */
export function readXlsxFirstSheet(buf: Buffer): string[][] {
  const list = entries(buf);
  const byName = new Map(list.map((e) => [e.name.replace(/^\/+/, ""), e]));
  const shared: string[] = [];
  const sst = byName.get("xl/sharedStrings.xml");
  if (sst) for (const m of read(buf, sst).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(texts(m[1]!));
  let sheetPath = "xl/worksheets/sheet1.xml";
  const workbook = byName.get("xl/workbook.xml");
  const rels = byName.get("xl/_rels/workbook.xml.rels");
  if (workbook && rels) {
    const firstId = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(read(buf, workbook))?.[1];
    // id из файла в регулярку не подставляем (ревью 10.11.2026, ReDoS): сравниваем атрибут строкой.
    const target = firstId ? [...read(buf, rels).matchAll(/<Relationship\b([^>]*)>/g)]
      .map((m) => m[1]!)
      .find((attrs) => /\bId="([^"]*)"/.exec(attrs)?.[1] === firstId)
      ?.match(/\bTarget="([^"]+)"/)?.[1] : undefined;
    if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  }
  const stylesEntry = byName.get("xl/styles.xml");
  const formats = cellFormats(stylesEntry ? read(buf, stylesEntry) : "");
  const sheet = byName.get(sheetPath) ?? list.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name));
  if (!sheet) throw new XlsxReadError("no sheet");
  const rows: string[][] = [];
  for (const rowMatch of read(buf, sheet).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of rowMatch[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? "";
      const inner = cell[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      const raw = type === "s" ? shared[Number(v)] ?? "" : type === "inlineStr" ? texts(inner) : v !== undefined ? decode(v) : "";
      // Формат ячейки — часть данных: дата Excel хранится числом (45962), валюта — в формате ($, €).
      // Формулу не вычисляем: <v> — значение, которое Excel сохранил при последнем пересчёте.
      const style = formats[Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1)];
      const numeric = !type || type === "n";
      const value = numeric && style?.date && /^\d+(?:\.\d+)?$/.test(raw) ? excelSerialDate(Number(raw))
        : numeric && style?.currency && raw ? `${raw} ${style.currency}` : raw;
      const col = ref ? columnIndex(ref) : cells.length;
      if (col > 200) continue;
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    if (cells.some((c) => c.trim())) rows.push(cells);
    if (rows.length > MAX_SHEET_ROWS) throw new XlsxReadError("too many rows");
  }
  return rows;
}
