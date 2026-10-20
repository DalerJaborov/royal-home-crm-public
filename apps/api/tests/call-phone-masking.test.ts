import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * МАСКИРОВКА ЗАПАСНОГО НОМЕРА В РАСШИФРОВКЕ ЗВОНКА (03.09.2026, требование
 * владельца) — см. lib/telephony/callPhoneMasking.ts.
 *
 * Проверяем чистую функцию scrubMentionedPhones без БД: ей достаточно текста
 * расшифровки и уже известных номеров карточки — оба приходят параметрами.
 * Интеграция (вызов из callRecordings.ts перед сохранением Interaction.transcript)
 * проверена отдельно, глазами по коду хука (transcribeAndEnrich).
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

const KNOWN_PHONE = "+992910001003";

describe("scrubMentionedPhones", () => {
  it("основной номер клиента НЕ маскируется — он и так открыт через карточку", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Ваш номер +992 91 000 10 03, я правильно записал?";
    const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("запасной номер, которого нет на карточке, маскируется в тексте и шифруется", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const { decryptPhone } = await import("../src/lib/phoneCrypto.js");
    const text = "Кстати, у меня вторая симка, запишите 910 00 10 44, я на связи по ней тоже.";
    const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });

    expect(result.text).not.toContain("910 00 10 44");
    expect(result.text).toContain("44"); // последние две цифры видны
    expect(result.mentionedPhonesEncrypted).toHaveLength(1);
    expect(decryptPhone(result.mentionedPhonesEncrypted[0])).toBe("+992910001044");
  });

  it("номер, повторённый дважды подряд, маскируется ОБА раза", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Записывайте: 910 00 10 44. Повторю ещё раз: 910 00 10 44, дошло?";
    const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });

    expect(result.text).not.toContain("910 00 10 44");
    // Одно и то же число не должно осесть дважды в списке на шифрование.
    expect(result.mentionedPhonesEncrypted).toHaveLength(1);
  });

  it("номер, уже записанный в extraPhones, не считается новым", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Можете набрать 910 00 10 44, тоже мой";
    const result = scrubMentionedPhones(text, {
      phone: KNOWN_PHONE,
      whatsappPhone: null,
      extraPhones: ["+992910001044"],
    });
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("номер, известный только как whatsappPhone, тоже не считается новым", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Пишите на 910 00 10 44 в вотсап";
    const result = scrubMentionedPhones(text, {
      phone: KNOWN_PHONE,
      whatsappPhone: "+992910001044",
      extraPhones: [],
    });
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("текст без номеров возвращается без изменений", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Завтра покажу вам квартиру в центре в шесть вечера.";
    const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("карточка без известных номеров (клиент не найден) — найденный номер трактуется как новый", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Номер 910 00 10 44";
    const result = scrubMentionedPhones(text, { phone: "", whatsappPhone: null, extraPhones: [] });
    expect(result.text).not.toContain("910 00 10 44");
    expect(result.mentionedPhonesEncrypted).toHaveLength(1);
  });

  it("номер с «?» (модель честно не расслышала цифру) тоже маскируется, но не шифруется", async () => {
    // 24.09.2026: раньше «?» рвал разбор номера на куски короче девяти цифр, и
    // extractPhoneOccurrences его вообще не видел — сырые цифры «372 65» и «21»
    // оставались в расшифровке открытым текстом. Теперь includeUnclear ловит такой
    // кандидат отдельно (ai/leadQualifier.ts::unclearPhoneCandidates) и маскирует,
    // но НЕ отдаёт на шифрование — цифра потеряна, полноценного номера нет.
    //
    // Цифры кандидата НАРОЧНО не похожи на KNOWN_PHONE («910001003») — иначе
    // сработал бы шаблонный разбор из следующего теста (unclearRawMatchesKnownTail)
    // и номер перестал бы маскироваться уже по другой, законной причине.
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Кстати, запишите мой другой номер 372 65 ?? 21, я не расслышал сам, что назвал.";
    const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });
    expect(result.text).not.toContain("372 65 ?? 21");
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("неразборчивый кандидат, подходящий ПОД ШАБЛОН известного номера, не маскируется (правка ревью 24.09.2026)", async () => {
    // До правки фильтр был `o.unclear || !knownTails.has(...)` — ЛЮБОЙ unclear-
    // кандидат проходил мимо проверки известных номеров безусловно. Если модель не
    // расслышала одну цифру в ОСНОВНОМ номере клиента («910001003», уже открытом
    // агенту в карточке), кандидат «910 00 1? 03» маскировался как чужой — хотя
    // это тот же самый номер с потерянной цифрой. Сравниваем по шаблону: «?»
    // совпадает с любой цифрой известного номера на той же позиции.
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Мой номер вроде 910 00 1? 03, точно уже не помню";
    const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("дата с «?» в расшифровке звонка не маскируется как номер (правка ревью 24.09.2026)", async () => {
    // Тот же повод, что у phone-unreadable-retry.test.ts: «24.09.2026?» — восемь
    // цифр даты плюс «?» дают девять цифровых мест, ровно порог местного номера.
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const text = "Записал на 24.09.2026? в 11:00?, перезвоните для подтверждения";
    const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });
    expect(result.text).toBe(text);
    expect(result.mentionedPhonesEncrypted).toEqual([]);
  });

  it("сбой шифрования (ключ не настроен) не роняет функцию — текст всё равно маскируется", async () => {
    const { scrubMentionedPhones } = await import("../src/lib/telephony/callPhoneMasking.js");
    const saved = process.env.PHONE_ENCRYPTION_KEY;
    delete process.env.PHONE_ENCRYPTION_KEY;
    try {
      const text = "Запасной номер 910 00 10 44";
      const result = scrubMentionedPhones(text, { phone: KNOWN_PHONE, whatsappPhone: null, extraPhones: [] });
      expect(result.text).not.toContain("910 00 10 44");
      expect(result.mentionedPhonesEncrypted).toEqual([]);
    } finally {
      process.env.PHONE_ENCRYPTION_KEY = saved;
    }
  });
});
