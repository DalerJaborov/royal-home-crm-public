import { describe, expect, it } from "vitest";
import { readGpsFromFile, parseIso6709 } from "../mediaGps";

// Синтетические файлы: собираем байты руками, без внешних библиотек.

const enc = (s: string) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
const u32 = (n: number) => Uint8Array.of((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u16 = (n: number) => Uint8Array.of((n >>> 8) & 255, n & 255);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const box = (type: string, ...body: Uint8Array[]) => {
  const b = cat(...body);
  return cat(u32(8 + b.length), enc(type), b);
};
const file = (...parts: Uint8Array[]) => new Blob([cat(...parts)]);

/** TIFF big-endian с GPS IFD: lat/lng в градусах-минутах-секундах. */
function tiffWithGps(lat: number, lng: number, latRef = "N", lngRef = "E"): Uint8Array {
  const dms = (v: number) => {
    const d = Math.floor(v);
    const m = Math.floor((v - d) * 60);
    const s = Math.round(((v - d) * 60 - m) * 60 * 10000);
    return cat(u32(d), u32(1), u32(m), u32(1), u32(s), u32(10000));
  };
  const entry = (tag: number, type: number, count: number, value: Uint8Array) => cat(u16(tag), u16(type), u32(count), value);
  // TIFF: заголовок(8) + IFD0(2+12+4=18) → GPS IFD с 4 записями: 2+48+4=54, затем данные
  const gpsOffset = 8 + 18;
  const dataOffset = gpsOffset + 54;
  const header = cat(enc("MM"), u16(42), u32(8));
  const ifd0 = cat(u16(1), entry(0x8825, 4, 1, u32(gpsOffset)), u32(0));
  const gps = cat(
    u16(4),
    entry(1, 2, 2, cat(enc(latRef), Uint8Array.of(0, 0, 0))),
    entry(2, 5, 3, u32(dataOffset)),
    entry(3, 2, 2, cat(enc(lngRef), Uint8Array.of(0, 0, 0))),
    entry(4, 5, 3, u32(dataOffset + 24)),
    u32(0)
  );
  return cat(header, ifd0, gps, dms(lat), dms(lng));
}

/** HEIC: ftyp + meta(hdlr, iinf[infe Exif], iloc) + mdat с Exif-элементом. */
function heic(lat: number, lng: number, withExif = true): Blob {
  const tiff = tiffWithGps(lat, lng);
  const exifItem = cat(u32(6), enc("Exif"), Uint8Array.of(0, 0), tiff); // exif_tiff_header_offset = 6
  const ftyp = box("ftyp", enc("heic"), u32(0), enc("mif1"));
  const hdlr = box("hdlr", u32(0), u32(0), enc("pict"), new Uint8Array(12));
  const infe = (id: number, type: string) => box("infe", Uint8Array.of(2, 0, 0, 0), u16(id), u16(0), enc(type), Uint8Array.of(0));
  const iinf = box("iinf", u32(0), u16(2), infe(1, "hvc1"), withExif ? infe(2, "Exif") : infe(2, "mime"));
  // iloc v0: offset_size=4,length_size=4 / base_offset_size=0 ; 2 элемента
  const ilocBody = (exifOffset: number) =>
    cat(
      u32(0),
      Uint8Array.of(0x44, 0x00),
      u16(2),
      u16(1), u16(0), u16(1), u32(0), u32(4), // item 1
      u16(2), u16(0), u16(1), u32(exifOffset), u32(exifItem.length) // item 2
    );
  const metaLen = (off: number) => box("meta", u32(0), hdlr, iinf, box("iloc", ilocBody(off))).length;
  const mdatStart = ftyp.length + metaLen(0) + 8;
  const meta = box("meta", u32(0), hdlr, iinf, box("iloc", ilocBody(mdatStart)));
  return file(ftyp, meta, box("mdat", exifItem));
}

describe("точка из HEIC", () => {
  it("находит Exif-элемент через iinf/iloc", async () => {
    const p = await readGpsFromFile(heic(38.5598, 68.787));
    expect(p!.lat).toBeCloseTo(38.5598, 3);
    expect(p!.lng).toBeCloseTo(68.787, 3);
  });
  it("нет Exif-элемента — null", async () => {
    expect(await readGpsFromFile(heic(38.5598, 68.787, false))).toBeNull();
  });
});

describe("точка из видео", () => {
  const mdat = box("mdat", new Uint8Array(5000));
  const ftyp = box("ftyp", enc("isom"), u32(0), enc("mp42"));

  it("MP4: moov/udta/©xyz в КОНЦЕ файла, после mdat", async () => {
    const xyz = box("©xyz", u16(18), u16(0x15c7), enc("+38.5598+068.7870/"));
    const moov = box("moov", box("mvhd", new Uint8Array(100)), box("udta", xyz));
    const p = await readGpsFromFile(file(ftyp, mdat, moov));
    expect(p).toEqual({ lat: 38.5598, lng: 68.787 });
  });

  it("MP4: бокс mdat с размером 0 (до конца) не ломает разбор moov перед ним", async () => {
    const xyz = box("©xyz", u16(18), u16(0), enc("+38.5598+068.7870/"));
    const moov = box("moov", box("udta", xyz));
    const mdat0 = cat(u32(0), enc("mdat"), new Uint8Array(100));
    expect(await readGpsFromFile(file(ftyp, moov, mdat0))).toEqual({ lat: 38.5598, lng: 68.787 });
  });

  it("MP4: 64-битный размер у mdat перепрыгивается", async () => {
    const xyz = box("©xyz", u16(18), u16(0), enc("+38.5598+068.7870/"));
    const body = new Uint8Array(300);
    const big = cat(u32(1), enc("mdat"), u32(0), u32(16 + body.length), body);
    expect(await readGpsFromFile(file(ftyp, big, box("moov", box("udta", xyz))))).toEqual({ lat: 38.5598, lng: 68.787 });
  });

  it("MOV: moov/meta keys + ilst, com.apple.quicktime.location.ISO6709", async () => {
    const name = "com.apple.quicktime.location.ISO6709";
    const other = "com.apple.quicktime.make";
    const keys = box(
      "keys",
      u32(0),
      u32(2),
      box("mdta", enc(other)),
      box("mdta", enc(name))
    );
    const item = (idx: number, value: string) => box(String.fromCharCode(0, 0, 0, idx), box("data", u32(1), u32(0), enc(value)));
    const ilst = box("ilst", item(1, "Apple"), item(2, "+38.5598+068.7870+012.300/"));
    // QuickTime: meta без версии/флагов — сразу hdlr
    const meta = box("meta", box("hdlr", u32(0), u32(0), enc("mdta"), new Uint8Array(12)), keys, ilst);
    const p = await readGpsFromFile(file(box("ftyp", enc("qt  "), u32(0), enc("qt  ")), mdat, box("moov", meta)));
    expect(p).toEqual({ lat: 38.5598, lng: 68.787 });
  });

  it("ролик без GPS — null", async () => {
    expect(await readGpsFromFile(file(ftyp, mdat, box("moov", box("mvhd", new Uint8Array(100)))))).toBeNull();
  });

  it("точка (0,0) и вне пределов — null", async () => {
    const mk = (s: string) => file(ftyp, box("moov", box("udta", box("©xyz", u16(0), u16(0), enc(s)))));
    expect(await readGpsFromFile(mk("+00.0000+000.0000/"))).toBeNull();
    expect(await readGpsFromFile(mk("+98.0000+068.0000/"))).toBeNull();
  });
});

describe("PNG и WebP", () => {
  it("PNG с eXIf", async () => {
    const chunk = (type: string, data: Uint8Array) => cat(u32(data.length), enc(type), data, u32(0));
    const png = file(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", new Uint8Array(13)), chunk("eXIf", tiffWithGps(38.5, 68.7)), chunk("IEND", new Uint8Array(0)));
    const p = await readGpsFromFile(png);
    expect(p!.lat).toBeCloseTo(38.5, 3);
  });
  it("WebP с EXIF-чанком (с префиксом Exif)", async () => {
    const t = cat(enc("Exif"), Uint8Array.of(0, 0), tiffWithGps(38.5, 68.7));
    const le = (n: number) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
    const body = cat(enc("WEBP"), enc("VP8 "), le(2), new Uint8Array(2), enc("EXIF"), le(t.length), t, new Uint8Array(t.length % 2));
    const p = await readGpsFromFile(file(enc("RIFF"), le(body.length), body));
    expect(p!.lng).toBeCloseTo(68.7, 3);
  });
  it("PNG без eXIf — null", async () => {
    const chunk = (type: string, data: Uint8Array) => cat(u32(data.length), enc(type), data, u32(0));
    const png = file(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), chunk("IHDR", new Uint8Array(13)), chunk("IEND", new Uint8Array(0)));
    expect(await readGpsFromFile(png)).toBeNull();
  });
});

describe("мусор не бросает наружу", () => {
  it("пустой, случайный, обрезанный файл — null", async () => {
    expect(await readGpsFromFile(new Blob([]))).toBeNull();
    expect(await readGpsFromFile(file(enc("hello world, not a media file")))).toBeNull();
    const cut = heic(38.5, 68.7);
    expect(await readGpsFromFile(cut.slice(0, 60))).toBeNull();
    expect(await readGpsFromFile(file(box("ftyp", enc("isom")), u32(40), enc("moov"), enc("zz")))).toBeNull();
  });
  it("parseIso6709", () => {
    expect(parseIso6709("-12.5+100.25/")).toEqual({ lat: -12.5, lng: 100.25 });
    expect(parseIso6709("abc")).toBeNull();
  });
});
