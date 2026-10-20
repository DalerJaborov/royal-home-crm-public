import { describe, expect, it, vi } from "vitest";

/**
 * Аудит 23.09.2026, круг 3, №75: декодер HEIC сразу заводит массив
 * ширина × высота × 4 байта. Файл в пару килобайт с размером 20000 × 20000 в
 * заголовке просил 1,6 ГБ разом — процесс API (768 МБ) падал. Размер
 * проверяется по заголовку до расшифровки.
 */
const state = vi.hoisted(() => ({ width: 0, height: 0, decoded: 0, disposed: 0 }));
vi.mock("heic-decode", () => {
  const one = vi.fn(async () => {
    state.decoded += 1;
    return { width: state.width, height: state.height, data: new Uint8ClampedArray(state.width * state.height * 4) };
  });
  const all = vi.fn(async () =>
    Object.assign(
      [
        {
          width: state.width,
          height: state.height,
          decode: async () => {
            state.decoded += 1;
            return { width: state.width, height: state.height, data: new Uint8ClampedArray(state.width * state.height * 4) };
          },
        },
      ],
      { dispose: () => (state.disposed += 1) }
    )
  );
  return { default: Object.assign(one, { all }) };
});

const { sharpFromUpload, MAX_HEIC_PIXELS } = await import("../src/lib/heicInput.js");

/** Минимальный заголовок ftyp с брендом heic — isHeic его узнаёт. */
function heicHeader(): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(24, 0);
  buf.write("ftypheic", 4, "latin1");
  return buf;
}

describe("HEIC-бомба не роняет сервер", () => {
  it("размер больше потолка — отказ до расшифровки пикселей", async () => {
    Object.assign(state, { width: 20_000, height: 20_000, decoded: 0, disposed: 0 });
    expect(20_000 * 20_000).toBeGreaterThan(MAX_HEIC_PIXELS);
    await expect(sharpFromUpload(heicHeader())).rejects.toThrow(/слишком большой/);
    expect(state.decoded).toBe(0);
    expect(state.disposed).toBe(1);
  });

  it("обычный снимок расшифровывается как раньше", async () => {
    Object.assign(state, { width: 4, height: 3, decoded: 0, disposed: 0 });
    const img = await sharpFromUpload(heicHeader());
    const meta = await img.metadata();
    expect([meta.width, meta.height]).toEqual([4, 3]);
    expect(state.decoded).toBe(1);
    expect(state.disposed).toBe(1);
  });
});
