import { describe, expect, it } from "vitest";
import { numberWordsToDigits, spokenNumberValue } from "../src/lib/numberWords.js";
import { comparePrice, fuzzyPlaceWord, isFreshProperty, looksLikeLeadingDigitSlip, placeTypeHits, placeTypeWords } from "../src/lib/propertyClueScoring.js";
import { matchRequestedAgent, type KnownAgent } from "../src/lib/requestedAgent.js";
import { instructionFor } from "../src/ai/transcribe.js";

/**
 * ПРИМЕТЫ ОБЪЕКТА ИЗ ЗВОНКА — ЧИСТЫЕ ПРАВИЛА (26.11.2026, ПК-001086 → объект №230).
 *
 * Без базы и без ИИ: таблица случаев, за которыми стоит один живой звонок —
 * «ду хонага… масҷиди Мехкалон, Қазоқон… 165 ҳазор… Зайниддин Файзуллоев».
 * Карточка: 2 комнаты, «возле мечети в Қазоқон», 965 000 сомони, агент
 * Сайфуллоев Илҳом. Расшифровка потеряла первую цифру цены и исказила фамилию;
 * прежние правила вычеркнули объект по цене и назвали фамилию тёзками.
 */

const RATE = 9.28;

const ASR = { tolerateAsr: true } as const;

describe("цена без допуска — правило 24.09.2026 для всех каналов (comparePrice)", () => {
  it("точная и близкая — плюс; дальше 20 % — вычёркивание", () => {
    expect(comparePrice(965_000, 965_000, RATE).kind).toBe("exact");
    expect(comparePrice(900_000, 965_000, RATE).kind).toBe("close");
    expect(comparePrice(165_000, 965_000, RATE).veto).toBe(true);
    expect(comparePrice(400_000, 300_000, RATE).veto).toBe(true);
    expect(comparePrice(104_000, 965_000, RATE).veto).toBe(true);
  });
});

describe("цена с допуском на ошибку расшифровки — только разбор звонка (tolerateAsr)", () => {
  it("165 000 против 965 000 — потерян старший разряд: маленький плюс, не вето", () => {
    const v = comparePrice(165_000, 965_000, RATE, ASR);
    expect(v.kind).toBe("asr_slip");
    expect(v.veto).toBe(false);
    expect(v.score).toBeGreaterThan(0);
    expect(looksLikeLeadingDigitSlip(165_000, 965_000)).toBe(true);
    expect(looksLikeLeadingDigitSlip(65_000, 965_000)).toBe(true);
  });
  it("соседние круглые сотни и не первая цифра — другая цена (ревью 26.11, В2)", () => {
    for (const [said, card] of [
      [300_000, 400_000],
      [500_000, 600_000],
      [400_000, 900_000],
      [1_200_000, 1_900_000],
      [799_000, 965_000],
      [165_000, 1_965_000],
    ]) {
      expect(looksLikeLeadingDigitSlip(said, card), `${said} ↔ ${card}`).toBe(false);
      expect(comparePrice(said, card, RATE, ASR).kind, `${said} ↔ ${card}`).toBe("far");
    }
  });
  it("валюта перепутана: 104 000 «сомони» — это 104 000 долларов ≈ 965 000", () => {
    expect(comparePrice(104_000, 965_000, RATE, ASR).kind).toBe("other_currency");
    expect(comparePrice(Math.round(965_000 * RATE), 965_000, RATE, ASR).kind).toBe("other_currency");
  });
  it("потерянные тысячи: «965» против 965 000", () => {
    expect(comparePrice(965, 965_000, RATE, ASR).kind).toBe("thousands");
  });
  it("совсем другая цена — минус три, но не вычёркивание", () => {
    const v = comparePrice(300_000, 965_000, RATE, ASR);
    expect(v.kind).toBe("far");
    expect(v.veto).toBe(false);
    expect(v.score).toBe(-3);
  });
});

describe("ориентиры с допуском на написание", () => {
  it("«казакон» = «казокон», «самани» = «сомони», короткие слова не размываются", () => {
    expect(fuzzyPlaceWord("казакон", "казокон")).toBe(true);
    expect(fuzzyPlaceWord("самани", "сомони")).toBe(true);
    expect(fuzzyPlaceWord("мехкалон", "мехколон")).toBe(true);
    expect(fuzzyPlaceWord("сино", "сина")).toBe(false);
    expect(fuzzyPlaceWord("рудаки", "айни")).toBe(false);
    // Одна замена буквы — только у разбора звонка (loose), не во всех каналах.
    expect(fuzzyPlaceWord("рудаки", "рухаки")).toBe(false);
    expect(fuzzyPlaceWord("рудаки", "рухаки", { loose: true })).toBe(true);
  });
  it("вид места по-таджикски и по-русски — одно слово", () => {
    const said = placeTypeWords("тарафи масҷиди Мехкалон, Қазоқон");
    const card = placeTypeWords("сторона белых домов, возле мечети в Қазоқон");
    expect(said.has("мечеть")).toBe(true);
    expect(placeTypeHits(said, card)).toBe(1);
    expect(placeTypeHits(placeTypeWords("назди бозори Корвон"), placeTypeWords("рядом рынок Корвон"))).toBe(1);
    expect(placeTypeHits(placeTypeWords("мактаб"), placeTypeWords("рынок"))).toBe(0);
  });
  it("свежий объект — две недели", () => {
    const now = Date.now();
    expect(isFreshProperty(new Date(now - 86_400_000), now)).toBe(true);
    expect(isFreshProperty(new Date(now - 20 * 86_400_000), now)).toBe(false);
    expect(isFreshProperty(null, now)).toBe(false);
  });
});

describe("числа словами → цифры (ru + tg)", () => {
  it("таджикские числительные с союзом -у", () => {
    expect(spokenNumberValue(["нӯҳсаду", "шасту", "панҷ", "ҳазор"])).toBe(965_000);
    expect(spokenNumberValue(["саду", "шасту", "панҷ", "ҳазор"])).toBe(165_000);
    expect(spokenNumberValue(["дусаду", "сӣ"])).toBe(230);
    expect(spokenNumberValue(["ҳаштсад", "ҳазор"])).toBe(800_000);
    expect(spokenNumberValue(["сад", "ҳазор"])).toBe(100_000);
  });
  it("неоднозначное не переводится (ревью 26.11, Б1)", () => {
    // «миллион двести» в речи — 1 200 000, буквально — 1 000 200: не угадываем.
    expect(spokenNumberValue(["миллион", "двести"])).toBeNull();
    expect(spokenNumberValue(["два", "миллиона", "пятьсот"])).toBeNull();
    expect(spokenNumberValue(["як", "миллион", "дусад", "ҳазор"])).toBeNull();
    // Два числа подряд — «от пятисот до шестисот», а не 1 100 000.
    expect(spokenNumberValue(["пятьсот", "шестьсот", "тысяч"])).toBeNull();
    expect(spokenNumberValue(["панҷсаду", "шашсад", "ҳазор"])).toBeNull();
    // Одинокое «сад» — это сад.
    expect(spokenNumberValue(["сад"])).toBeNull();
  });
  it("текст с неоднозначным числом остаётся словами", () => {
    expect(numberWordsToDigits("бюджет миллион двести")).toBe("бюджет миллион двести");
    expect(numberWordsToDigits("два миллиона пятьсот тысяч")).toBe("два миллиона пятьсот тысяч");
    expect(numberWordsToDigits("пятьсот шестьсот тысяч")).toBe("пятьсот шестьсот тысяч");
    expect(numberWordsToDigits("пятьсот-шестьсот тысяч")).toBe("пятьсот-шестьсот тысяч");
    expect(numberWordsToDigits("панҷсаду шашсад ҳазор")).toBe("панҷсаду шашсад ҳазор");
    expect(numberWordsToDigits("возле детский сад, Ботанический сад")).toBe("возле детский сад, Ботанический сад");
  });
  it("русские числительные", () => {
    expect(spokenNumberValue(["двести", "тридцать"])).toBe(230);
    expect(spokenNumberValue(["девятьсот", "шестьдесят", "пять", "тысяч"])).toBe(965_000);
    expect(spokenNumberValue(["тридцать", "пять", "тысяч", "долларов"])).toBeNull();
  });
  it("в тексте заменяются только большие числа, мелкие остаются словами", () => {
    expect(numberWordsToDigits("хонаи ду хонага нӯҳсаду шасту панҷ ҳазор сомонӣ")).toBe("хонаи ду хонага 965000 сомонӣ");
    expect(numberWordsToDigits("Клиент: объект двести тридцать, на третьем этаже.")).toBe("Клиент: объект 230, на третьем этаже.");
    expect(numberWordsToDigits("як бор занг задем")).toBe("як бор занг задем");
    expect(numberWordsToDigits("объект сорок пять", { minValue: 1 })).toBe("объект 45");
    // Обычный текст не меняется.
    expect(numberWordsToDigits("Алло, салому алейкум.")).toBe("Алло, салому алейкум.");
  });
});

/** Сотрудники как на проде 26.11.2026: похожие фамилии, один уволен. */
function agent(over: Partial<KnownAgent> & { id: string; fullName: string }): KnownAgent {
  return { role: "AGENT", isActive: true, frozenAt: null, leadsPausedUntil: null, sipExtension: null, ...over };
}
const STAFF: KnownAgent[] = [
  agent({ id: "ilhom", fullName: "Сайфуллоев Илҳом", sipExtension: "1015" }),
  agent({ id: "komron", fullName: "Комрон Нарзуллоев", sipExtension: "1013", isActive: false }),
  agent({ id: "mijgona", fullName: "Миҷгона", sipExtension: "1014" }),
  agent({ id: "bah-director", fullName: "Баходур Назаров", role: "DIRECTOR", sipExtension: "1003" }),
  agent({ id: "bah-agent", fullName: "Баходур Рахимов", sipExtension: "1012" }),
];

describe("названное имя с ошибкой расшифровки (matchRequestedAgent)", () => {
  it("«Файзуллоев» подходит двоим — хозяин узнанного объекта решает", () => {
    const m = matchRequestedAgent("Зайниддин Файзуллоев", STAFF, { requireCue: false, preferAgentIds: ["ilhom"], asrAware: true });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.agentId).toBe("ilhom");
      expect(m.resolvedBy).toBe("property");
    }
  });
  it("без объекта: похожие — действующий и уволенный, имя с ошибкой — берём действующего", () => {
    const m = matchRequestedAgent("Зайниддин Файзуллоев", STAFF, { requireCue: false, asrAware: true });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.agentId).toBe("ilhom");
      expect(m.resolvedBy).toBe("active");
    }
  });
  it("слабый кандидат подписывается как «похожий объект», а не «объект из разговора»", () => {
    const m = matchRequestedAgent("Зайниддин Файзуллоев", STAFF, {
      requireCue: false,
      preferAgentIds: ["ilhom"],
      preferIsSure: false,
      asrAware: true,
    });
    expect(m.status === "matched" && m.resolvedBy).toBe("similar_property");
  });
  it("без рубильника (asrAware выкл) — прежнее «тёзок не угадываем»", () => {
    const m = matchRequestedAgent("Зайниддин Файзуллоев", STAFF, { requireCue: false });
    expect(m.status).toBe("ambiguous");
  });
  it("точное имя побеждает похожее", () => {
    const m = matchRequestedAgent("Сайфуллоев", STAFF, { requireCue: false, asrAware: true });
    expect(m.status === "matched" && m.agentId).toBe("ilhom");
    expect(m.status === "matched" && m.resolvedBy).toBeUndefined();
  });
  it("хозяин объекта не перебивает точное имя другого сотрудника", () => {
    const m = matchRequestedAgent("мне нужна Миҷгона", STAFF, { requireCue: false, preferAgentIds: ["ilhom"] });
    expect(m.status === "matched" && m.agentId).toBe("mijgona");
  });
  it("два действующих тёзки с точным именем — по-прежнему не угадываем", () => {
    const m = matchRequestedAgent("мне нужен Баходур", STAFF);
    expect(m.status).toBe("ambiguous");
    // Хозяин объекта среди тёзок — разводит и их: клиент назвал имя с ролика.
    const byProperty = matchRequestedAgent("мне нужен Баходур", STAFF, { preferAgentIds: ["bah-agent"] });
    expect(byProperty.status === "matched" && byProperty.agentId).toBe("bah-agent");
  });
  it("точно названный уволенный сотрудник всё ещё узнаётся как недоступный", () => {
    const m = matchRequestedAgent("Нарзуллоев", STAFF, { requireCue: false });
    expect(m.status).toBe("unavailable");
  });
});

describe("подсказка расшифровке звонка", () => {
  it("фамилии и ориентиры попадают в инструкцию, с запретом вписывать непроизнесённое; числа — целиком", () => {
    const text = instructionFor({ kind: "call", asrHints: true, vocabulary: ["Сайфуллоев Илҳом", "Қазоқон", "Мехкалон"] });
    expect(text).toContain("Сайфуллоев Илҳом");
    expect(text).toContain("Қазоқон");
    expect(text).toContain("НИКОГДА не вписывай слово из этого списка");
    expect(text).toContain("965 000");
    // Голосовое сообщение — инструкция прежняя, без подсказок звонка.
    expect(instructionFor()).not.toContain("965 000");
    // Рубильник выключен — подсказок звонку нет, инструкция прежняя.
    const off = instructionFor({ kind: "call", vocabulary: ["Сайфуллоев Илҳом"] });
    expect(off).not.toContain("Сайфуллоев");
    expect(off).not.toContain("965 000");
  });
});
