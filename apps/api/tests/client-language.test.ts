import { describe, expect, it } from "vitest";
import { detectClientLanguage, languageInstruction } from "../src/ai/clientLanguage.js";
import { wrapUntrusted } from "../src/ai/untrustedContent.js";

/**
 * Язык клиента определяется кодом, а не просьбой к модели.
 *
 * Правило «отвечай строго на языке клиента» стоит в промте трижды и 01.08.2026 всё
 * равно не сработало: человек написал из рекламы по-русски «Сколько стоят ваши
 * услуги?», бот ответил на таджикском. Дважды, у двух разных клиентов.
 */
describe("язык последнего сообщения клиента", () => {
  it("русский — по служебным словам", () => {
    expect(detectClientLanguage("Сколько стоят ваши услуги?")).toBe("ru");
    expect(detectClientLanguage("Какие услуги вы предлагаете?")).toBe("ru");
    expect(detectClientLanguage("Здравствуйте, хочу купить квартиру")).toBe("ru");
  });

  it("таджикский — по буквам, которых в русском нет", () => {
    expect(detectClientLanguage("Ман хона харидан мехоҳам")).toBe("tg");
    expect(detectClientLanguage("Дар кадом ноҳия аст?")).toBe("tg");
  });

  it("таджикский кириллицей без особых букв — по частым словам", () => {
    expect(detectClientLanguage("салом, хона даркор")).toBe("tg");
    expect(detectClientLanguage("Хонакофтестем салом")).toBe("tg");
  });

  it("таджикская латиница — это таджикский, а не английский", () => {
    expect(detectClientLanguage("salom, hona darkor")).toBe("tg");
  });

  it("смесь — самый частый стиль Душанбе, и отвечать надо так же", () => {
    expect(detectClientLanguage("Салом, хона мехохам, сколько стоит?")).toBe("mixed");
  });

  /**
   * 03.10.2026, живой сбой в Instagram: «Салом можно окончательную цену и когда
   * можно посмотреть?» считалось смесью из-за одного «салом», и бот отвечал
   * по-таджикски. Приветствие языка не задаёт, решает то, чего больше. Прежний
   * пример смеси «Салом, хочу квартиру дар Сино» по тому же правилу — русский:
   * «хочу квартиру» против одного «дар».
   */
  it("таджикское приветствие в русской фразе — русский", () => {
    expect(detectClientLanguage("Салом можно окончательную цену и когда можно посмотреть?")).toBe("ru");
    expect(detectClientLanguage("Ассалому алейкум, сколько стоит?")).toBe("ru");
    expect(detectClientLanguage("Салом, хочу квартиру дар Сино")).toBe("ru");
    expect(detectClientLanguage("Рахмат, понятно, когда можно посмотреть?")).toBe("ru");
  });

  it("одно приветствие без других слов — по-прежнему таджикский", () => {
    expect(detectClientLanguage("Салом!")).toBe("tg");
    expect(detectClientLanguage("Ассалому алейкум")).toBe("tg");
  });

  it("таджикская фраза с русским словом — таджикский", () => {
    expect(detectClientLanguage("Салом, хона дар Сино чанд пул аст? цена")).toBe("tg");
  });

  /**
   * 16.08.2026. Слова «не» и «он» стояли в списке ТАДЖИКСКИХ служебных слов, а в
   * русском списке их не было. Любая русская фраза с ними определялась как
   * таджикская, и код приказывал модели: «Ответь на таджикском, не переходи на
   * русский». То есть модуль, написанный против ответа не на том языке, сам его и
   * вызывал — на самых обычных репликах покупателя.
   */
  it("русские фразы с «не» и «он» — это русский, а не таджикский", () => {
    expect(detectClientLanguage("Не подходит")).toBe("ru");
    expect(detectClientLanguage("Пока не решил")).toBe("ru");
    expect(detectClientLanguage("Он дорогой, посмотрю другой")).toBe("ru");
    expect(detectClientLanguage("а он в каком состоянии")).toBe("ru");
    expect(detectClientLanguage("Не дорого ли?")).toBe("ru");
  });

  it("таджикский с «нест» по-прежнему таджикский", () => {
    // Убирали только «не» и «он»; настоящие таджикские маркеры не задеты.
    expect(detectClientLanguage("Ин хона нест")).toBe("tg");
    expect(detectClientLanguage("чанд пул аст")).toBe("tg");
  });

  /**
   * Английский. До 16.08.2026 любая латиница считалась таджикской, и «Hello, do you
   * have apartments?» получал приказ отвечать по-таджикски кириллицей. Правильный
   * ответ здесь — не «английский», а «не навязываем»: указание, придуманное кодом,
   * хуже отсутствующего, а модель по переписке разберётся сама.
   */
  it("английский не выдаём за таджикскую латиницу", () => {
    expect(detectClientLanguage("Hello, do you have apartments in the center?")).toBe("unknown");
    expect(detectClientLanguage("How much is the price?")).toBe("unknown");
    expect(languageInstruction(detectClientLanguage("Hello, can I buy a house?"))).toBe("");
  });

  it("таджикская латиница английской не становится", () => {
    expect(detectClientLanguage("Assalom, hona darkor")).toBe("tg");
    expect(detectClientLanguage("narkhash chand pul")).toBe("tg");
  });

  it("слишком коротко — язык не навязываем", () => {
    expect(detectClientLanguage("ок")).toBe("unknown");
    expect(detectClientLanguage("[📷]")).toBe("unknown");
    expect(languageInstruction("unknown")).toBe("");
  });
});

/**
 * Присланное клиентом содержимое размечено границами (ai/untrustedContent.ts), и
 * для определителя языка два вида разметки значат противоположное: описание файла
 * пишем МЫ по-русски, а расшифровка голосового — речь самого клиента.
 */
describe("границы присланного содержимого и язык", () => {
  it("наше русское описание видео не делает таджикоязычного продавца русскоязычным", () => {
    const text = wrapUntrusted("video", "На видео трёхкомнатная квартира с ремонтом, вид во двор.");
    expect(detectClientLanguage(`Ин хонаи ман аст\n${text}`)).toBe("tg");
    // Видео без подписи: языка не по чему определять, и навязывать его нельзя.
    expect(detectClientLanguage(text)).toBe("unknown");
  });

  it("расшифровка голосового язык задаёт — часто это единственный текст в сообщении", () => {
    expect(detectClientLanguage(wrapUntrusted("voice", "Салом, ман хона харидан мехоҳам"))).toBe("tg");
    expect(detectClientLanguage(wrapUntrusted("voice", "Здравствуйте, хочу купить квартиру"))).toBe("ru");
  });
});

describe("указание для промта", () => {
  it("русскому клиенту прямо запрещает таджикский", () => {
    expect(languageInstruction("ru")).toContain("Ответь ПО-РУССКИ");
    expect(languageInstruction("ru")).toContain("Не переходи на таджикский");
  });

  it("таджикскому клиенту велит кириллицу", () => {
    expect(languageInstruction("tg")).toContain("КИРИЛЛИЦЕЙ");
  });
});
