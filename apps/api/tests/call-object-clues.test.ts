import { describe, expect, it } from "vitest";
import { numberWordsToDigits, spokenNumberValue } from "../src/lib/numberWords.js";
import { comparePrice, fuzzyPlaceWord, isFreshProperty, looksLikeDigitSlip, placeTypeHits, placeTypeWords } from "../src/lib/propertyClueScoring.js";
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

describe("цена с допуском на ошибку распознавания (comparePrice)", () => {
  it("точная и близкая — как раньше", () => {
    expect(comparePrice(965_000, 965_000, RATE).kind).toBe("exact");
    expect(comparePrice(900_000, 965_000, RATE).kind).toBe("close");
  });
  it("165 000 против 965 000 — одна цифра иначе, похоже на ошибку расшифровки: маленький плюс, не вето", () => {
    const v = comparePrice(165_000, 965_000, RATE);
    expect(v.kind).toBe("asr_slip");
    expect(v.score).toBeGreaterThan(0);
    expect(looksLikeDigitSlip(165_000, 965_000)).toBe(true);
    expect(looksLikeDigitSlip(799_000, 965_000)).toBe(false);
    expect(looksLikeDigitSlip(165_000, 1_965_000)).toBe(false);
  });
  it("валюта перепутана: 104 000 «сомони» — это 104 000 долларов ≈ 965 000", () => {
    expect(comparePrice(104_000, 965_000, RATE).kind).toBe("other_currency");
    // И наоборот: модель перевела сомони как доллары.
    expect(comparePrice(Math.round(965_000 * RATE), 965_000, RATE).kind).toBe("other_currency");
  });
  it("потерянные тысячи: «965» против 965 000", () => {
    expect(comparePrice(965, 965_000, RATE).kind).toBe("thousands");
  });
  it("совсем другая цена — минус, но не вычёркивание", () => {
    const v = comparePrice(300_000, 965_000, RATE);
    expect(v.kind).toBe("far");
    expect(v.score).toBeLessThan(0);
  });
});

describe("ориентиры с допуском на написание", () => {
  it("«казакон» = «казокон», «самани» = «сомони», короткие слова не размываются", () => {
    expect(fuzzyPlaceWord("казакон", "казокон")).toBe(true);
    expect(fuzzyPlaceWord("самани", "сомони")).toBe(true);
    expect(fuzzyPlaceWord("мехкалон", "мехколон")).toBe(true);
    expect(fuzzyPlaceWord("сино", "сина")).toBe(false);
    expect(fuzzyPlaceWord("рудаки", "рухаки")).toBe(true);
    expect(fuzzyPlaceWord("рудаки", "айни")).toBe(false);
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
    expect(spokenNumberValue(["як", "миллион", "дусад", "ҳазор"])).toBe(1_200_000);
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
    const m = matchRequestedAgent("Зайниддин Файзуллоев", STAFF, { requireCue: false, preferAgentIds: ["ilhom"] });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.agentId).toBe("ilhom");
      expect(m.resolvedBy).toBe("property");
    }
  });
  it("без объекта: похожие — действующий и уволенный, имя с ошибкой — берём действующего", () => {
    const m = matchRequestedAgent("Зайниддин Файзуллоев", STAFF, { requireCue: false });
    expect(m.status).toBe("matched");
    if (m.status === "matched") {
      expect(m.agentId).toBe("ilhom");
      expect(m.resolvedBy).toBe("active");
    }
  });
  it("точное имя побеждает похожее", () => {
    const m = matchRequestedAgent("Сайфуллоев", STAFF, { requireCue: false });
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
    const text = instructionFor({ kind: "call", vocabulary: ["Сайфуллоев Илҳом", "Қазоқон", "Мехкалон"] });
    expect(text).toContain("Сайфуллоев Илҳом");
    expect(text).toContain("Қазоқон");
    expect(text).toContain("НИКОГДА не вписывай слово из этого списка");
    expect(text).toContain("965 000");
    // Голосовое сообщение — инструкция прежняя, без подсказок звонка.
    expect(instructionFor()).not.toContain("965 000");
  });
});
