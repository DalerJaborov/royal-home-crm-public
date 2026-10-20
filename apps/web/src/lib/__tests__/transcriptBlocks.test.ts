import { describe, expect, it } from "vitest";
import { mergeTranscriptFragments } from "@royal-home/shared";
import { findBlockMatches, findEntities, parseBlocks } from "../transcriptBlocks";

describe("transcriptBlocks", () => {
  it("склеивает осколки одного говорящего в один пузырь", () => {
    const blocks = parseBlocks("Бот: Здрав\nБот: ствуйте\nБот:  чем помочь?\nКлиент: Нужна квартира");
    expect(blocks.map((b) => [b.speakerLabel, b.text])).toEqual([
      ["Робот", "Здравствуйте чем помочь?"],
      ["Клиент", "Нужна квартира"],
    ]);
  });

  it("консультант и робот не приклеиваются к клиенту и не зовутся именем агента", () => {
    const blocks = parseBlocks("Клиент: Алло\nКонсультант: Слушаю\nРобот: Минутку", "Алишер");
    expect(blocks.map((b) => b.speakerLabel)).toEqual(["Клиент", "Консультант", "Робот"]);
    expect(blocks[1].speakerSide).toBe("agent");
  });

  it("агент подписывается именем, если оно известно", () => {
    const blocks = parseBlocks("Агент: Добрый день\nКлиент: Здравствуйте", "Алишер");
    expect(blocks[0].speakerLabel).toBe("Алишер");
  });

  it("служебные строки в скобках — отдельный приглушённый блок", () => {
    const blocks = parseBlocks("Бот: Соединяю\n[эскалация к оператору] просьба клиента\nКлиент: Спасибо");
    expect(blocks.map((b) => !!b.system)).toEqual([false, true, false]);
    expect(blocks[1].text).toBe("[эскалация к оператору] просьба клиента");
  });

  it("подсветка узнаёт кириллические слова-даты и цены", () => {
    const text = "Приедем завтра в 15:30, цена 50 000 сомони";
    const found = findEntities(text).map((e) => [text.slice(e.start, e.end), e.type]);
    expect(found).toContainEqual(["завтра", "time"]);
    expect(found).toContainEqual(["15:30", "time"]);
    expect(found.some(([t, ty]) => ty === "price" && String(t).includes("сомони"))).toBe(true);
  });

  it("слово-дата внутри другого слова не подсвечивается", () => {
    expect(findEntities("позавчера и завтрашний")).toEqual([]);
  });

  it("поиск считает только показанный текст, без подписей говорящих", () => {
    const blocks = parseBlocks("Клиент: бот ли это\nБот: да");
    const perBlock = findBlockMatches(blocks, "бот");
    expect(perBlock.flat()).toHaveLength(1);
    expect(perBlock.flat()[0].globalIndex).toBe(0);
  });

  it("mergeTranscriptFragments: служебная строка рвёт склейку, слова через пробел", () => {
    expect(mergeTranscriptFragments("Бот: Привет\nБот: Анна\n[звонящий молчит]\nБот: Алло")).toBe(
      "Бот: Привет Анна\n[звонящий молчит]\nБот: Алло"
    );
  });
});
