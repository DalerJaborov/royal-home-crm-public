import { describe, expect, it } from "vitest";
import {
  buildWhisperParts,
  buildWhisperText,
  isSpeakablePiece,
  resolveWhisperLanguage,
  whisperDigest,
  type WhisperSource,
} from "../src/lib/telephony/whisperText.js";

/**
 * СБОРКА ПОДСКАЗКИ, КОТОРУЮ АГЕНТ СЛЫШИТ ПЕРЕД СОЕДИНЕНИЕМ.
 *
 * Проверяется без базы и без станции: это чистая функция, и цена ошибки в ней —
 * не упавший экран, а фраза, сказанная живому человеку в ухо посреди звонка.
 */

/** Полдень 20 августа 2026 по Душанбе (UTC+5) — точка отсчёта всех «вчера» и «завтра». */
const NOW = new Date("2026-08-20T07:00:00.000Z");

function source(overrides: Partial<WhisperSource> = {}): WhisperSource {
  return {
    fullName: "Фаррух Раҳимов",
    kind: "BUYER",
    propertyType: "APARTMENT",
    districtName: "Сомонӣ",
    budgetMin: null,
    budgetMax: 150_000,
    currency: "USD",
    lastContactAt: null,
    promisedAt: null,
    aiHint: null,
    ...overrides,
  };
}

describe("подсказка агенту: состав фразы", () => {
  it("начинается с имени и берёт только первое слово", () => {
    const text = buildWhisperText(source(), {
      language: "tg",
      direction: "in",
      parts: ["name", "role"],
      now: NOW,
    });
    expect(text).toBe("Фаррух. харидор");
    expect(text).not.toContain("Раҳимов");
  });

  it("на входящем не произносит метку направления, на исходящем произносит", () => {
    const parts = ["label", "name"];
    const incoming = buildWhisperText(source(), { language: "tg", direction: "in", parts, now: NOW });
    const outgoing = buildWhisperText(source(), { language: "tg", direction: "out", parts, now: NOW });
    expect(incoming).toBe("Фаррух");
    expect(outgoing).toBe("Занги баромад. Фаррух");
  });

  it("говорит вид сделки на языке сотрудника", () => {
    const seller = source({ kind: "SELLER" });
    expect(buildWhisperText(seller, { language: "tg", direction: "in", parts: ["role"], now: NOW })).toBe("фурӯшанда");
    expect(buildWhisperText(seller, { language: "ru", direction: "in", parts: ["role"], now: NOW })).toBe("продавец");
  });

  it("у обращения без вида («Другое») роль молчит, а не звучит пустотой", () => {
    const other = source({ kind: "OTHER" });
    expect(buildWhisperText(other, { language: "tg", direction: "in", parts: ["name", "role"], now: NOW })).toBe("Фаррух");
  });

  it("объект и район собираются в одну зацепку", () => {
    expect(buildWhisperText(source(), { language: "tg", direction: "in", parts: ["anchor"], now: NOW })).toBe(
      "манзил дар Сомонӣ"
    );
    expect(
      buildWhisperText(source({ propertyType: null }), { language: "tg", direction: "in", parts: ["anchor"], now: NOW })
    ).toBe("ноҳияи Сомонӣ");
    expect(
      buildWhisperText(source({ districtName: null }), { language: "ru", direction: "in", parts: ["anchor"], now: NOW })
    ).toBe("квартира");
  });

  it("бюджет округляется до тысяч — длинные числа отнимают время у клиента на гудках", () => {
    const exact = source({ budgetMax: 152_300 });
    expect(buildWhisperText(exact, { language: "ru", direction: "in", parts: ["budget"], now: NOW })).toBe(
      "до 152 тысяч долларов"
    );
    const range = source({ budgetMin: 100_000, budgetMax: 150_000 });
    expect(buildWhisperText(range, { language: "tg", direction: "in", parts: ["budget"], now: NOW })).toBe(
      "аз 100 то 150 ҳазор доллар"
    );
  });

  it("давность считается по Душанбе, а не по часам контейнера", () => {
    // 23:30 по Душанбе накануне — это ВЧЕРА, хотя по UTC разница меньше суток.
    const yesterdayEvening = new Date("2026-08-19T18:30:00.000Z");
    expect(
      buildWhisperText(source({ lastContactAt: yesterdayEvening }), {
        language: "ru",
        direction: "in",
        parts: ["recency"],
        now: NOW,
      })
    ).toBe("последний разговор: вчера");
  });

  it("древняя договорённость не звучит — она агенту уже ничего не подсказывает", () => {
    const old = source({ promisedAt: new Date("2026-07-01T07:00:00.000Z") });
    expect(buildWhisperText(old, { language: "tg", direction: "in", parts: ["promise"], now: NOW })).toBe("");

    const tomorrow = source({ promisedAt: new Date("2026-08-21T07:00:00.000Z") });
    expect(buildWhisperText(tomorrow, { language: "tg", direction: "in", parts: ["promise"], now: NOW })).toBe(
      "ваъда: пагоҳ"
    );
  });

  it("неизвестный блок из будущей версии не роняет фразу", () => {
    const text = buildWhisperText(source(), {
      language: "tg",
      direction: "in",
      parts: ["name", "мысли-клиента"],
      now: NOW,
    });
    expect(text).toBe("Фаррух");
  });

  it("заглушку вместо имени не произносит — «Входящий +992…» это не имя", () => {
    // Найдено на живых данных в первый час работы: агенту зачиталось
    // «Входящий. фурӯшанда. манзил дар Исмоили Сомонӣ».
    // Хвост «номашро пурсед» / «спросите имя» — правка 30.08.2026: имени у карточки
    // нет, и спросить его может только человек (голосового бота у нас нет).
    const stub = source({ fullName: "Входящий +992934000023" });
    expect(buildWhisperText(stub, { language: "tg", direction: "in", parts: ["name", "role"], now: NOW })).toBe(
      "мизоҷи нав. харидор. номашро пурсед"
    );
    const digitsOnly = source({ fullName: "+992 93 400 00 23" });
    expect(buildWhisperText(digitsOnly, { language: "ru", direction: "in", parts: ["name"], now: NOW })).toBe(
      "новый клиент. спросите имя"
    );
  });

  it("заглушки бота и мессенджера — тоже не имя («Покупатель №42», «Клиент Instagram»)", () => {
    // Признак заглушки теперь общий на весь проект (lib/placeholderName.ts): до
    // 30.08.2026 подсказка знала только про «Входящий», и агенту зачитывалось
    // «Покупатель. харидор» — роль дважды и ни слова правды об имени.
    for (const name of ["Покупатель №42", "Продавец №7", "Клиент Instagram", "@nozil760", "raxxmanzadee"]) {
      expect(
        buildWhisperText(source({ fullName: name }), { language: "ru", direction: "in", parts: ["name", "role"], now: NOW })
      ).toBe("новый клиент. покупатель. спросите имя");
    }
  });

  it("значки в имени не читает вслух — «🎓» это не имя", () => {
    // Живой случай 21.08.2026: у клиента из Instagram имя состояло из значка, и
    // синтез потратил 3,6 секунды, честно пытаясь описать картинку словами.
    const emojiOnly = source({ fullName: "🎓" });
    expect(buildWhisperText(emojiOnly, { language: "tg", direction: "in", parts: ["name", "role"], now: NOW })).toBe(
      "мизоҷи нав. харидор. номашро пурсед"
    );
    // Значок рядом с настоящим именем просто отбрасывается.
    const decorated = source({ fullName: "Фаррух🏠 Раҳимов" });
    expect(buildWhisperText(decorated, { language: "tg", direction: "in", parts: ["name"], now: NOW })).toBe("Фаррух");
  });

  it("пустая карточка даёт пустую фразу — файл в таком случае не создаётся (и просьбы «спросите имя» одной строкой не бывает)", () => {
    const empty = source({ fullName: "", kind: "OTHER", propertyType: null, districtName: null, budgetMax: null });
    expect(buildWhisperText(empty, { language: "tg", direction: "in", parts: ["name", "role", "anchor"], now: NOW })).toBe("");
  });
});

describe("подсказка агенту: что вообще нельзя озвучить", () => {
  /**
   * Журнал прода за 48 часов (22.08.2026): сотни записей «Синтез речи не вернул звук»
   * на кусках «🎓», «@nozil760», «raxxmanzadee». Модель на них молчит, а каждый заход
   * крона тратил на них запрос из суточной квоты в 100 штук.
   */
  it("ник, логин латиницей и одни значки в синтез не уходят", () => {
    expect(isSpeakablePiece("@nozil760")).toBe(false);
    expect(isSpeakablePiece("raxxmanzadee")).toBe(false);
    expect(isSpeakablePiece("nozil")).toBe(false);
    expect(isSpeakablePiece("🎓")).toBe(false);
    expect(isSpeakablePiece("   ")).toBe(false);
    expect(isSpeakablePiece("+992 93 400 00 23")).toBe(false);
  });

  it("настоящие имена латиницей и марки остаются: решать за модель, что она их не осилит, мы не вправе", () => {
    expect(isSpeakablePiece("Hokimshoh")).toBe(true);
    expect(isSpeakablePiece("Mercedes-Benz")).toBe(true);
    expect(isSpeakablePiece("харидор")).toBe(true);
    expect(isSpeakablePiece("манзил дар Сомонӣ")).toBe(true);
  });

  it("зацепка ИИ теряет значки, а не превращается в описание картинки вслух", () => {
    const hinted = source({ aiHint: "хочет дом с 🏠 садом" });
    const text = buildWhisperText(hinted, { language: "ru", direction: "in", parts: ["aiHint"], now: NOW });
    expect(text).toBe("хочет дом с садом");
  });

  it("неозвучиваемая зацепка выбрасывается целиком, а не роняет фразу", () => {
    const hinted = source({ aiHint: "@nozil760" });
    const text = buildWhisperText(hinted, { language: "tg", direction: "in", parts: ["role", "aiHint"], now: NOW });
    expect(text).toBe("харидор");
  });
});

describe("подсказка агенту: разбор на куски для склейки", () => {
  it("части совпадают с фразой — иначе агент услышал бы не то, что показано в Настройках", () => {
    const opts = { language: "tg", direction: "in", parts: ["name", "role", "anchor"], now: NOW } as const;
    const text = buildWhisperText(source(), opts);
    const pieces = buildWhisperParts(source(), opts);
    expect(pieces).toEqual(["Фаррух", "харидор", "манзил дар Сомонӣ"]);
    expect(pieces.join(". ")).toBe(text);
  });

  it("пустая фраза даёт пустой список, а не список из пустой строки", () => {
    const empty = source({ fullName: "", kind: "OTHER", propertyType: null, districtName: null, budgetMax: null });
    expect(
      buildWhisperParts(empty, { language: "tg", direction: "in", parts: ["name", "role", "anchor"], now: NOW })
    ).toEqual([]);
  });
});

describe("подсказка агенту: отпечаток", () => {
  const opts = { language: "tg", direction: "in", parts: ["name", "role"], voice: "Kore", now: NOW } as const;

  it("не меняется от порядка блоков — состав тот же, переозвучивать нечего", () => {
    const a = whisperDigest(source(), opts);
    const b = whisperDigest(source(), { ...opts, parts: ["role", "name"] });
    expect(a).toBe(b);
  });

  it("не меняется от времени суток: иначе крон переозвучивал бы базу каждый проход", () => {
    const morning = whisperDigest(source({ lastContactAt: new Date("2026-08-19T04:00:00.000Z") }), opts);
    const evening = whisperDigest(source({ lastContactAt: new Date("2026-08-19T15:00:00.000Z") }), opts);
    expect(morning).toBe(evening);
  });

  it("CHANNEL-NEW-24: «сегодня» назавтра становится «вчера» — отпечаток меняется, а пока фраза та же — нет", () => {
    const withTime = { ...opts, parts: ["name", "promise", "recency"] } as const;
    const facts = source({
      lastContactAt: new Date("2026-10-02T09:00:00.000Z"),
      promisedAt: new Date("2026-10-02T09:00:00.000Z"),
    });
    const day2 = new Date("2026-10-02T10:00:00.000Z");
    const day3 = new Date("2026-10-03T10:00:00.000Z");
    expect(whisperDigest(facts, { ...withTime, now: day2 })).not.toBe(whisperDigest(facts, { ...withTime, now: day3 }));
    // В течение суток отпечаток стабилен: крон не переозвучивает базу каждый проход.
    expect(whisperDigest(facts, { ...withTime, now: new Date("2026-10-02T04:00:00.000Z") })).toBe(
      whisperDigest(facts, { ...withTime, now: new Date("2026-10-02T18:00:00.000Z") })
    );
    // «Давно» остаётся «давно»: ещё день без пересборки.
    const old = source({ lastContactAt: new Date("2026-05-01T09:00:00.000Z") });
    expect(whisperDigest(old, { ...withTime, now: day2 })).toBe(whisperDigest(old, { ...withTime, now: day3 }));
    // Блока срока нет в составе фразы — день на отпечаток не влияет.
    expect(whisperDigest(facts, { ...opts, now: day2 })).toBe(whisperDigest(facts, { ...opts, now: day3 }));
  });

  it("меняется, когда клиент из покупателя стал продавцом", () => {
    expect(whisperDigest(source(), opts)).not.toBe(whisperDigest(source({ kind: "SELLER" }), opts));
  });

  it("меняется от настроек — иначе смена голоса или языка подействовала бы только на новых", () => {
    expect(whisperDigest(source(), opts)).not.toBe(whisperDigest(source(), { ...opts, voice: "Charon" }));
    expect(whisperDigest(source(), opts)).not.toBe(whisperDigest(source(), { ...opts, language: "ru" }));
    expect(whisperDigest(source(), opts)).not.toBe(whisperDigest(source(), { ...opts, parts: ["name"] }));
  });
});

describe("подсказка агенту: чей язык", () => {
  it("выбор сотрудника сильнее агентского", () => {
    expect(resolveWhisperLanguage("ru", "tg")).toBe("ru");
    expect(resolveWhisperLanguage(null, "ru")).toBe("ru");
    expect(resolveWhisperLanguage(undefined, "tg")).toBe("tg");
  });

  it("«не играть мне» — это тишина, а не язык по умолчанию", () => {
    expect(resolveWhisperLanguage("off", "tg")).toBeNull();
  });

  it("мусор в поле не превращается в молчание: агент слышит подсказку на языке агентства", () => {
    expect(resolveWhisperLanguage("klingon", "ru")).toBe("tg");
  });
});
