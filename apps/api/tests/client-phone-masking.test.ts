import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../src/db.js";

/**
 * МАСКИРОВКА ЗАПАСНОГО НОМЕРА В ТЕКСТОВОЙ ПЕРЕПИСКЕ (04.09.2026, требование
 * владельца — расширение вчерашнего решения по звонкам на чат, см.
 * lib/clientPhoneMasking.ts).
 *
 * Ядро (regex-разбор, сама маскировка, шифрование) — то же самое, что уже
 * проверено для звонков в tests/call-phone-masking.test.ts; здесь проверяется
 * ОБЁРТКА с реальным clientId и настоящей БД: то, чего у звонка не было.
 */

const runId = Date.now();
const ORIGINAL_KEY = process.env.PHONE_ENCRYPTION_KEY;
const TEST_KEY = "9957ce235df1811577efc5fed5fb4fc502743aa7fdfb28b7deb206d76519a8ef"; // gitleaks:allow -- reviewed synthetic test value or non-secret identifier

beforeAll(() => {
  process.env.PHONE_ENCRYPTION_KEY = TEST_KEY;
});

afterAll(async () => {
  if (ORIGINAL_KEY === undefined) delete process.env.PHONE_ENCRYPTION_KEY;
  else process.env.PHONE_ENCRYPTION_KEY = ORIGINAL_KEY;
  await prisma.client.deleteMany({ where: { fullName: { startsWith: `Клиент маскировки чата ${runId}` } } });
});

const KNOWN_PHONE = `+992918${String(runId).slice(-6)}`;

async function makeClient(suffix: string, extraPhones: string[] = []) {
  return prisma.client.create({
    data: {
      fullName: `Клиент маскировки чата ${runId}-${suffix}`,
      phone: `+992919${String(runId).slice(-5)}${suffix}`,
      source: "WHATSAPP",
      acceptedAt: new Date(),
      extraPhones,
    },
  });
}

describe("scrubMentionedClientPhonesInText", () => {
  it("clientId = null (лид ещё не принят) — текст НЕ маскируется, даже если в нём есть цифры", async () => {
    const { scrubMentionedClientPhonesInText } = await import("../src/lib/clientPhoneMasking.js");
    // Именно так клиент диктует СВОЙ номер боту в первый раз — до создания карточки.
    const text = "Меня зовут Фарход, мой номер 910 00 10 44";
    const result = await scrubMentionedClientPhonesInText(text, null);
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("clientId указывает на НЕСУЩЕСТВУЮЩУЮ карточку — текст тоже НЕ маскируется (иначе, чем у звонков)", async () => {
    const { scrubMentionedClientPhonesInText } = await import("../src/lib/clientPhoneMasking.js");
    const text = "Запасной номер 910 00 10 44";
    const result = await scrubMentionedClientPhonesInText(text, "00000000-0000-0000-0000-000000000000");
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("известный номер карточки в тексте — не маскируется", async () => {
    const { scrubMentionedClientPhonesInText } = await import("../src/lib/clientPhoneMasking.js");
    const client = await makeClient("1");
    const text = `Мой номер ${client.phone}, всё верно`;
    const result = await scrubMentionedClientPhonesInText(text, client.id);
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("новый номер, отличный от известных, — маскируется и шифруется", async () => {
    const { scrubMentionedClientPhonesInText } = await import("../src/lib/clientPhoneMasking.js");
    const { decryptPhone } = await import("../src/lib/phoneCrypto.js");
    const client = await makeClient("2");
    const text = "У меня есть вторая симка, запишите 910 00 10 44, тоже мой";
    const result = await scrubMentionedClientPhonesInText(text, client.id);
    expect(result.text).not.toContain("910 00 10 44");
    expect(result.mentionedPhonesEncrypted).toHaveLength(1);
    expect(decryptPhone(result.mentionedPhonesEncrypted[0])).toBe("+992910001044");
  });

  it("номер, уже записанный в extraPhones карточки, — не считается новым", async () => {
    const { scrubMentionedClientPhonesInText } = await import("../src/lib/clientPhoneMasking.js");
    const client = await makeClient("3", ["+992910001044"]);
    const text = "Можете набрать 910 00 10 44, тоже мой";
    const result = await scrubMentionedClientPhonesInText(text, client.id);
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("текст без номеров и без clientId — возвращается без изменений и без обращения к БД", async () => {
    const { scrubMentionedClientPhonesInText } = await import("../src/lib/clientPhoneMasking.js");
    const text = "Здравствуйте, ищу квартиру в центре";
    const result = await scrubMentionedClientPhonesInText(text, null);
    expect(result.text).toBe(text);
  });

  it("пустой текст — возвращается как есть, даже с валидным clientId", async () => {
    const { scrubMentionedClientPhonesInText } = await import("../src/lib/clientPhoneMasking.js");
    const client = await makeClient("4");
    const result = await scrubMentionedClientPhonesInText("", client.id);
    expect(result.text).toBe("");
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });
});
