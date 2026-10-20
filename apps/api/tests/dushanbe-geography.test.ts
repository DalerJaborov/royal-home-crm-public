import { describe, expect, it } from "vitest";
import { MANDATORY_BOT_RULES } from "../src/ai/dushanbeGeography.js";
import { folkGeographyBlock } from "../src/ai/folkPlaces.js";

/**
 * География и обязательные правила бота.
 *
 * Эти правила приклеиваются ПОВЕРХ промта из Настроек именно потому, что промт там
 * можно переписать целиком. Тесты стерегут то, что дороже всего терять: запрет
 * обращений по полу и запрет спрашивать у клиента район жилого комплекса.
 */

describe("правила, которые нельзя потерять правкой промта в Настройках", () => {
  it("обращения по полу запрещены прямо", () => {
    expect(MANDATORY_BOT_RULES).toContain("ЗАПРЕЩЕНЫ ПОЛНОСТЬЮ");
    expect(MANDATORY_BOT_RULES).toContain("акаҷон");
    expect(MANDATORY_BOT_RULES).toContain("апаҷон");
  });

  it("запрещено спрашивать, в каком районе жилой комплекс", () => {
    // Ровно этот вопрос владелец увидел в живой переписке 31.07.
    expect(MANDATORY_BOT_RULES).toContain("ЗАПРЕЩЕНО спрашивать");
    expect(MANDATORY_BOT_RULES).toContain("Бустон Сити тарафи кадом район аст");
  });
});

describe("карта народных названий переехала в ai/folkPlaces.ts", () => {
  /**
   * 20.09.2026 список стал данными и печатается не целиком: название, которое
   * знает карта города, из промта уходит (см. ai/folkPlaces.ts и тест
   * bot-folk-places). Здесь стережём только то, что он УШЁЛ ИЗ ЭТОГО ФАЙЛА
   * целиком, а не наполовину: две копии одного списка разъедутся молча.
   */
  it("в обязательных правилах её больше нет ни строкой", () => {
    expect(MANDATORY_BOT_RULES).not.toContain("АЛГОРИТМ РАБОТЫ С РАЙОНАМИ");
    expect(MANDATORY_BOT_RULES).not.toContain("Профсоюз");
    expect(MANDATORY_BOT_RULES).not.toContain("Марказ калон аст");
  });

  it("сами названия и правило Марказа никуда не делись", async () => {
    const block = await folkGeographyBlock();
    expect(block).toContain("АЛГОРИТМ РАБОТЫ С РАЙОНАМИ");
    expect(block).toContain("Марказ калон аст");
    for (const district of ["Исмоили Сомони", "Сино", "Фирдавси", "Шохмансур"]) {
      expect(block).toContain(district);
    }
  });
});

describe("список комплексов", () => {
  it("Бустон Сити есть вместе с ориентиром — по нему выводится район", () => {
    // Район не проставлен намеренно: ориентир «ТЦ Садбарг» бот сводит к Шохмансуру
    // сам, по карте народных названий в основном промте.
    expect(MANDATORY_BOT_RULES).toContain("Бустон Сити");
    expect(MANDATORY_BOT_RULES).toContain("Садбарг");
  });

  it("названия и на латинице, и на кириллице — клиенты пишут по-разному", () => {
    expect(MANDATORY_BOT_RULES).toContain("Sebiston");
    expect(MANDATORY_BOT_RULES).toContain("Себистон");
    expect(MANDATORY_BOT_RULES).toContain("82 Towers");
  });

  it("сказано, что делать с комплексом, которого в списке нет", () => {
    // В Душанбе строят постоянно, список всегда будет неполным.
    expect(MANDATORY_BOT_RULES).toContain("НЕ спрашивай район");
    expect(MANDATORY_BOT_RULES).toContain("notes дословно");
  });
});
