import { crc32, deflateRawSync } from "node:zlib";

/**
 * Минимальный .xlsx для тестов: книга, связи, общие строки, стили и один лист (как сохраняет Excel).
 * Ячейка — строка, число или { v, s } (s — индекс стиля из `xfs`), или { f, v } (формула с сохранённым значением).
 */
export type XlsxCell = string | number | { v: number; s?: number; f?: string };

export function xlsxFixture(rows: XlsxCell[][], opts: {
  xfs?: number[]; numFmts?: Record<number, string>; relId?: string; declaredSize?: number;
} = {}): Buffer {
  const strings: string[] = [];
  const sid = (s: string) => { const i = strings.indexOf(s); return i >= 0 ? i : strings.push(s) - 1; };
  const col = (i: number) => String.fromCharCode(65 + i);
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
    const ref = `${col(c)}${r + 1}`;
    if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
    if (typeof v === "object") return `<c r="${ref}"${v.s !== undefined ? ` s="${v.s}"` : ""}>${v.f ? `<f>${esc(v.f)}</f>` : ""}<v>${v.v}</v></c>`;
    return `<c r="${ref}" t="s"><v>${sid(v)}</v></c>`;
  }).join("")}</row>`).join("");
  const relId = opts.relId ?? "rId1";
  const files: [string, string][] = [
    ["xl/workbook.xml", `<workbook xmlns:r="r"><sheets><sheet name="Лист" sheetId="1" r:id="${esc(relId)}"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="${esc(relId)}" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst>${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`],
    ["xl/styles.xml", `<styleSheet><numFmts>${Object.entries(opts.numFmts ?? {}).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join("")}</numFmts>`
      + `<cellXfs>${(opts.xfs ?? [0]).map((id) => `<xf numFmtId="${id}"/>`).join("")}</cellXfs></styleSheet>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const size = name.endsWith("sheet1.xml") && opts.declaredSize ? opts.declaredSize : data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(size, 22); local.writeUInt16LE(nameBuf.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(8, 10);
    head.writeUInt32LE(crc32(data), 16); head.writeUInt32LE(packed.length, 20); head.writeUInt32LE(size, 24);
    head.writeUInt16LE(nameBuf.length, 28); head.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    central.push(head, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}
