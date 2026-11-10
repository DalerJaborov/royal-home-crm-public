/**
 * Минимальный .xls (BIFF8 в Compound File) для тестов чтения старого Excel. Ячейка — строка
 * (через SST), число (NUMBER), { rk } (RK), { v, xf } (NUMBER со стилем) или { formula } (FORMULA
 * со строковым результатом + STRING). `xfFormats` — номер формата у каждого XF; `formats` — свои
 * форматы (FORMAT). `splitSst` — разрезать SST записью CONTINUE посреди строки.
 */
export type XlsCell = string | number | { rk: number } | { v: number; xf: number } | { formula: string };

const rec = (type: number, data: Buffer) => { const h = Buffer.alloc(4); h.writeUInt16LE(type, 0); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]); };
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const f64 = (v: number) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); return b; };
const uniString = (s: string) => Buffer.concat([u16(s.length), Buffer.from([1]), Buffer.from(s, "utf16le")]);

export function xlsFixture(rows: XlsCell[][], opts: {
  xfFormats?: number[]; formats?: Record<number, string>; splitSst?: boolean; declaredStreamSize?: number;
  filepass?: boolean; streamName?: string; date1904?: boolean; shortXf?: boolean;
} = {}): Buffer {
  const strings: string[] = [];
  const sid = (s: string) => { const i = strings.indexOf(s); return i >= 0 ? i : strings.push(s) - 1; };
  const cells: Buffer[] = [];
  rows.forEach((row, r) => row.forEach((cell, c) => {
    const head = Buffer.concat([u16(r), u16(c)]);
    if (typeof cell === "string") cells.push(rec(0xfd, Buffer.concat([head, u16(0), u32(sid(cell))])));
    else if (typeof cell === "number") cells.push(rec(0x203, Buffer.concat([head, u16(0), f64(cell)])));
    else if ("rk" in cell) cells.push(rec(0x27e, Buffer.concat([head, u16(0), u32((cell.rk << 2) | 0x02)])));
    else if ("v" in cell) cells.push(rec(0x203, Buffer.concat([head, u16(cell.xf), f64(cell.v)])));
    else {
      const result = Buffer.from([0, 0, 0, 0, 0, 0, 0xff, 0xff]);
      cells.push(rec(0x06, Buffer.concat([head, u16(0), result, u16(0), u32(0), u16(0)])));
      cells.push(rec(0x207, uniString(cell.formula)));
    }
  }));
  const sstBody = Buffer.concat(strings.map(uniString));
  const sstHead = Buffer.concat([u32(strings.length), u32(strings.length)]);
  let sstRecords: Buffer;
  if (opts.splitSst && strings.length) {
    // Разрез посреди символов первой строки, как делает Excel: начало — UTF-16, продолжение в CONTINUE
    // с байтом флагов 0 — однобайтовыми символами (строка должна быть латиницей).
    const first = strings[0]!;
    const head = Buffer.concat([u16(first.length), Buffer.from([1]), Buffer.from(first.slice(0, 2), "utf16le")]);
    const tail = Buffer.concat([Buffer.from([0]), Buffer.from(first.slice(2), "latin1"), ...strings.slice(1).map(uniString)]);
    sstRecords = Buffer.concat([rec(0xfc, Buffer.concat([sstHead, head])), rec(0x3c, tail)]);
  } else sstRecords = rec(0xfc, Buffer.concat([sstHead, sstBody]));
  const formats = Object.entries(opts.formats ?? {}).map(([id, code]) => rec(0x41e, Buffer.concat([u16(Number(id)), uniString(code)])));
  const xfs = opts.shortXf ? [rec(0xe0, Buffer.alloc(2))] : (opts.xfFormats ?? [0]).map((fmt) => rec(0xe0, Buffer.concat([u16(0), u16(fmt), Buffer.alloc(16)])));
  let workbook = Buffer.concat([
    rec(0x809, Buffer.concat([u16(0x600), u16(0x05), Buffer.alloc(12)])),
    ...(opts.filepass ? [rec(0x2f, Buffer.alloc(54))] : []), ...(opts.date1904 ? [rec(0x22, u16(1))] : []), ...formats, ...xfs,
    rec(0x85, Buffer.concat([u32(0), u16(0), uniString("Лист1").subarray(0, 2), Buffer.from([1]), Buffer.from("Лист1", "utf16le")])),
    sstRecords, rec(0x0a, Buffer.alloc(0)),
    rec(0x809, Buffer.concat([u16(0x600), u16(0x10), Buffer.alloc(12)])), ...cells, rec(0x0a, Buffer.alloc(0)),
  ]);
  if (workbook.length < 4096) workbook = Buffer.concat([workbook, Buffer.alloc(4096 - workbook.length)]);
  const wbSectors = Math.ceil(workbook.length / 512);
  const fat = Buffer.alloc(512, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0);
  fat.writeUInt32LE(0xfffffffe, 4);
  for (let i = 0; i < wbSectors; i++) fat.writeUInt32LE(i === wbSectors - 1 ? 0xfffffffe : 3 + i, (2 + i) * 4);
  const dir = Buffer.alloc(512);
  const entry = (off: number, name: string, type: number, start: number, size: number) => {
    Buffer.from(`${name}\0`, "utf16le").copy(dir, off);
    dir.writeUInt16LE((name.length + 1) * 2, off + 0x40);
    dir[off + 0x42] = type;
    dir.writeUInt32LE(0xffffffff, off + 0x44); dir.writeUInt32LE(0xffffffff, off + 0x48); dir.writeUInt32LE(type === 5 ? 1 : 0xffffffff, off + 0x4c);
    dir.writeUInt32LE(start, off + 0x74); dir.writeUInt32LE(size, off + 0x78);
  };
  entry(0, "Root Entry", 5, 0xfffffffe, 0);
  entry(128, opts.streamName ?? "Workbook", 2, 2, opts.declaredStreamSize ?? workbook.length);
  const header = Buffer.alloc(512, 0);
  header.writeUInt32LE(0xe011cfd0, 0); header.writeUInt32LE(0xe11ab1a1, 4);
  header.writeUInt16LE(0x3e, 0x18); header.writeUInt16LE(3, 0x1a); header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e); header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c); header.writeUInt32LE(1, 0x30); header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(0xfffffffe, 0x3c); header.writeUInt32LE(0, 0x40); header.writeUInt32LE(0xfffffffe, 0x44); header.writeUInt32LE(0, 0x48);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 0x4c + i * 4);
  const padded = Buffer.concat([workbook, Buffer.alloc(wbSectors * 512 - workbook.length)]);
  return Buffer.concat([header, fat, dir, padded]);
}
