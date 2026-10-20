import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Шифрование запасных номеров, названных в звонке (03.09.2026, требование
 * владельца — см. lib/phoneCrypto.ts). Ключ отдельный от SETTINGS_ENCRYPTION_KEY:
 * тест ставит СВОЙ PHONE_ENCRYPTION_KEY и возвращает прежнее значение — файлы
 * делят один процесс (см. tests/setup.ts), и чужой ключ не должен доехать
 * до соседнего теста.
 */

const ORIGINAL_KEY = process.env.PHONE_ENCRYPTION_KEY;
const TEST_KEY = "9957ce235df1811577efc5fed5fb4fc502743aa7fdfb28b7deb206d76519a8ef"; // gitleaks:allow -- reviewed synthetic test value or non-secret identifier

beforeAll(() => {
  process.env.PHONE_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.PHONE_ENCRYPTION_KEY;
  else process.env.PHONE_ENCRYPTION_KEY = ORIGINAL_KEY;
});

describe("phoneCrypto — encryptPhone/decryptPhone", () => {
  it("шифрует и расшифровывает номер обратно тем же значением", async () => {
    const { encryptPhone, decryptPhone } = await import("../src/lib/phoneCrypto.js");
    const cipher = encryptPhone("+992910001003");
    expect(cipher).not.toContain("910001003");
    expect(decryptPhone(cipher)).toBe("+992910001003");
  });

  it("два шифрования одного номера дают РАЗНЫЙ шифротекст (случайный iv)", async () => {
    const { encryptPhone } = await import("../src/lib/phoneCrypto.js");
    const a = encryptPhone("+992910001003");
    const b = encryptPhone("+992910001003");
    expect(a).not.toBe(b);
  });

  it("бросает исключение на повреждённом payload, а не возвращает мусор", async () => {
    const { decryptPhone } = await import("../src/lib/phoneCrypto.js");
    expect(() => decryptPhone("не-похоже-на-шифротекст")).toThrow();
  });

  it("без PHONE_ENCRYPTION_KEY encryptPhone бросает понятную ошибку", async () => {
    const { encryptPhone } = await import("../src/lib/phoneCrypto.js");
    const saved = process.env.PHONE_ENCRYPTION_KEY;
    delete process.env.PHONE_ENCRYPTION_KEY;
    try {
      expect(() => encryptPhone("+992910001003")).toThrow(/PHONE_ENCRYPTION_KEY/);
    } finally {
      process.env.PHONE_ENCRYPTION_KEY = saved;
    }
  });
});

describe("phoneCrypto — maskPhoneRaw", () => {
  it("прячет все цифры, кроме последних двух", async () => {
    const { maskPhoneRaw } = await import("../src/lib/phoneCrypto.js");
    expect(maskPhoneRaw("910 00 10 03")).toBe("*** ** ** 03");
  });

  it("сохраняет разделители и знак «+» как есть", async () => {
    const { maskPhoneRaw } = await import("../src/lib/phoneCrypto.js");
    expect(maskPhoneRaw("+992-91-000-10-03")).toBe("+***-**-***-**-03");
  });

  it("короткий номер — маскирует все цифры кроме последних двух", async () => {
    const { maskPhoneRaw } = await import("../src/lib/phoneCrypto.js");
    expect(maskPhoneRaw("1234")).toBe("**34");
  });
});
