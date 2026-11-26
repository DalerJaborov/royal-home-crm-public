import { describe, expect, it } from "vitest";
import { addressesAssistantByName, assistantNameAtStart, mentionsAssistantName } from "../src/telegram/assistantName.js";
import {
  ASSISTANT_COLLEAGUE_GREETING, NEWCOMER_HINT_BUTTON, asksToBeLinked, bothLanguages, newcomerLinkHint,
} from "../src/telegram/assistantGroupPhrases.js";
import { assistantGroupFixture as fixture } from "./helpers/assistantGroupFixture.js";

/**
 * ЖАЛОБА ВЛАДЕЛЬЦА 26.11.2026 (группы «Royal Home» и «CRM FIX»): Шабнам «срамит» людей и повторяется.
 *  - непривязанному коллеге на каждое сообщение — огромный двуязычный блок «Пока я вас не узнаю…»;
 *  - приветствие нового участника — два сообщения подряд, повторно приглашённого — снова;
 *  - «Шабнамчун хонахои заминира манда равонкнен» не считалось обращением.
 * Здесь без базы: имя, тексты и маршрут через обработчик группы. Сама дверь подсказки (лимит, язык,
 * тишина на фото) — на базе в shabnam-group-newcomer-24-11.test.ts.
 */
describe("имя Шабнам во всех написаниях", () => {
  it.each([
    "Шабнам, найди", "шабнам найди", "Шабнамм, привет", "Shabnam, найди", "Шабнамчун хонахои заминира манда равонкнен",
    "Шабнам чун, ёрӣ деҳ", "Шабнам-чон, ёрӣ деҳ", "Шабнамҷон салом", "шабнамджон помоги", "Шабнамжон", "Шебнам, привет",
  ])("в начале сообщения: %s", (text) => {
    expect(assistantNameAtStart(text)).not.toBeNull();
    expect(mentionsAssistantName(text)).toBe(true);
  });

  it("ласковая форма — обращение, голое имя — по прежнему правилу", () => {
    expect(assistantNameAtStart("Шабнамчун хонахои")?.vocative).toBe(true);
    expect(assistantNameAtStart("Шабнам-чон, ёрӣ")?.vocative).toBe(true);
    expect(assistantNameAtStart("Шабнам, найди")?.vocative).toBe(false);
  });

  it.each(["я спросила у Шабнам вчера", "скажите Шабнаму", "Шабнамро пайваст кунед", "ба Шабнамҷон гуфтам"])("внутри фразы: %s", (text) => {
    expect(mentionsAssistantName(text)).toBe(true);
  });

  it.each(["Шабнамовна", "шабнамка-доска", "привет всем", "Шаб нам"])("не имя: %s", (text) => {
    expect(mentionsAssistantName(text)).toBe(false);
  });

  // Ревью 26.11.2026: «чун» по-таджикски и «когда», «мушовир» и «консультант» — это разговор о людях, не к ней.
  it.each(["Шабнам чун касал буд, наомад", "Мушовир чун омад"])("«чун» через пробел — не ласковая форма: %s", (text) => {
    expect(assistantNameAtStart(text)?.vocative ?? false).toBe(false);
  });

  it.each(["Шабнам, найди", "шабнам найди", "Шабнамчун хонахои", "Шабнам-чон хона ёб", "Салом, Шабнамҷон", "Мушовир, ёрӣ деҳ", "Shabnam help"])(
    "непривязанному: обращение по имени — %s", (text) => {
      expect(addressesAssistantByName(text)).toBe(true);
    });

  it.each(["вчера Шабнам сказала", "я спросила у Шабнам вчера", "ба Шабнамҷон гуфтам", "ба мушовир занг занед", "Мушовир чун омад"])(
    "непривязанному: имя в середине фразы — разговор о ней, тишина — %s", (text) => {
      expect(addressesAssistantByName(text)).toBe(false);
    });

  it("обработчик группы: «Шабнамчун …» — обращение, текст просьбы без имени", () => {
    const f = fixture();
    expect(f.adapter.addressedToBot(f.message("Шабнамчун хонахои заминира манда равонкнен"), "fixture_bot")).toEqual({
      addressed: true, text: "хонахои заминира манда равонкнен",
    });
    expect(f.adapter.addressedToBot(f.message("Шабнам-чон хона ёб"), "fixture_bot").addressed).toBe(true);
    expect(f.adapter.addressedToBot(f.message("Салом, Шабнамҷон"), "fixture_bot").addressed).toBe(true);
    // Голое имя без знака и просьбы — по-прежнему разговор о ней, не к ней.
    expect(f.adapter.addressedToBot(f.message("Шабнам завтра придёт"), "fixture_bot").addressed).toBe(false);
  });

  it("привязанный: «Шабнамчун …» уходит модели", async () => {
    const f = fixture();
    expect(await f.send("Шабнамчун хонахои заминира манда равонкнен")).toBe(true);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.offer).not.toHaveBeenCalled();
  });
});

describe("непривязанный в группе: подсказка только на обращение", () => {
  it("позвал ласковым именем — дверь подсказки, модели нет, длинного блока нет", async () => {
    const f = fixture();
    f.setLinked(false);
    expect(await f.send("Шабнамчун хонахои заминира манда равонкнен")).toBe(true);
    expect(f.offer).toHaveBeenCalledExactlyOnceWith(expect.anything(), "addressed");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
  });

  // Ревью 26.11.2026: имя в середине фразы — разговор о ней, непривязанному тишина; в начале — обращение.
  it("имя внутри фразы — тишина, имя в начале — подсказка", async () => {
    const f = fixture();
    f.setLinked(false);
    await f.send("коллеги, а у Шабнам можно спросить про это?");
    expect(f.offer).not.toHaveBeenCalled();
    await f.send("Шабнам, можно спросить про это?");
    expect(f.offer).toHaveBeenCalledExactlyOnceWith(expect.anything(), "addressed");
  });

  it("фото, стикер, голосовое без подписи и болтовня без имени — тишина", async () => {
    const f = fixture();
    f.setLinked(false);
    await f.send("", { photo: [{ file_id: "p", width: 1, height: 1 }] } as never);
    await f.send("", { sticker: { file_id: "s" } } as never);
    await f.send("", { voice: { file_id: "v", duration: 5 } } as never);
    await f.send("Салом алейкум, ҳамкорон!");
    await f.send("Иҷро шуд");
    expect(f.offer).not.toHaveBeenCalled();
    expect(f.plain).not.toHaveBeenCalled();
    expect(f.voice).not.toHaveBeenCalled();
  });

  it("/assistant_memory от непривязанного — та же дверь, без «я вас не знаю»", async () => {
    const f = fixture();
    f.setLinked(false);
    await f.send("/assistant_memory on");
    expect(f.offer).toHaveBeenCalledExactlyOnceWith(expect.anything(), "addressed");
    expect(f.plain).not.toHaveBeenCalled();
  });
});

describe("тексты подсказки", () => {
  const all = (language: "ru" | "tg") => [false, true].flatMap((byPhone) => [false, true].flatMap((asksToLink) =>
    [1, 2, 3].map((attempt) => newcomerLinkHint({ language, name: "Бехруз", byPhone, asksToLink, attempt }))));

  it("коротко, одним языком, без «—», без «не узнаю» и без срока ссылки цифрой", () => {
    for (const text of [...all("ru"), ...all("tg")]) {
      expect(text.startsWith("Бехруз, ")).toBe(true);
      expect(text).not.toMatch(/—/u);
      expect(text).not.toMatch(/\d/u);
      expect(text).not.toMatch(/не узна|намешинос|\n/iu);
      expect(text.length).toBeLessThan(200);
    }
    // Таджикский ответ — без русских слов из русской версии (кроме названий кнопок CRM в кавычках и разделов).
    for (const text of all("tg")) expect(text.replace(/«[^»]*»|Настройки|Сотрудники/gu, "")).not.toMatch(/привяж|напишите|отвечу|профиле/iu);
    for (const text of all("ru")) expect(text).not.toMatch(/[ҳҷқғӯӣ]/iu);
  });

  it("повтор — другой фразой", () => {
    for (const language of ["ru", "tg"] as const) {
      for (const byPhone of [false, true]) {
        const first = newcomerLinkHint({ language, name: "", byPhone, asksToLink: false, attempt: 1 });
        const second = newcomerLinkHint({ language, name: "", byPhone, asksToLink: false, attempt: 2 });
        expect(second).not.toBe(first);
        expect(first.charAt(0)).toBe(first.charAt(0).toUpperCase());
      }
    }
  });

  it("«Манро пайваст кун» / «привяжи меня» — сам путь: профиль или ссылка от руководителя", () => {
    expect(asksToBeLinked("Манро пайваст кун")).toBe(true);
    expect(asksToBeLinked("Шабнам, привяжи меня")).toBe(true);
    expect(asksToBeLinked("подключите меня к CRM")).toBe(true);
    expect(asksToBeLinked("Иҷро шуд")).toBe(false);
    const ru = newcomerLinkHint({ language: "ru", name: "", byPhone: false, asksToLink: true, attempt: 1 });
    expect(ru).toContain("Профиль → Telegram");
    expect(ru).toContain("«Подключить к Шабнам»");
    const tg = newcomerLinkHint({ language: "tg", name: "", byPhone: false, asksToLink: true, attempt: 1 });
    expect(tg).toContain("Профил → Telegram");
  });

  it("кнопка одним языком", () => {
    for (const kind of ["dm", "profile"] as const) {
      expect(NEWCOMER_HINT_BUTTON[kind].ru).not.toContain("/");
      expect(NEWCOMER_HINT_BUTTON[kind].tg).not.toContain("/");
      expect(NEWCOMER_HINT_BUTTON[kind].ru).not.toBe(NEWCOMER_HINT_BUTTON[kind].tg);
    }
  });
});

describe("приветствие нового участника", () => {
  it("одно сообщение на двух языках, таджикский по смыслу русского", () => {
    const text = bothLanguages(ASSISTANT_COLLEAGUE_GREETING);
    expect(text).toContain("Добро пожаловать");
    expect(text).toContain("Хуш омадед");
    // Прежний таджикский звал «искать и смотреть дом», как клиентский бот.
    expect(ASSISTANT_COLLEAGUE_GREETING.tg).not.toMatch(/Хона ёфтан/u);
    expect(ASSISTANT_COLLEAGUE_GREETING.tg).toMatch(/объект/u);
    expect(ASSISTANT_COLLEAGUE_GREETING.tg).toMatch(/намоиш/u);
    expect(ASSISTANT_COLLEAGUE_GREETING.tg).toMatch(/чати шахсӣ/u);
    expect(text).not.toMatch(/—/u);
  });
});
