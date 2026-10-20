import { describe, expect, it } from "vitest";
import { humanGap, nowBlock, withTimeGaps } from "../src/ai/conversationTime.js";
import type { ChatMessage } from "../src/ai/shared.js";
import { dushanbeWallClock } from "../src/lib/dushanbeTime.js";

/**
 * У бота не было часов.
 *
 * В модель уходили только роль и текст, поэтому переписка, оборвавшаяся в январе,
 * выглядела для неё в точности как начатая пять минут назад — и она продолжала её
 * с того же места: «можете посмотреть квартиру сегодня?». Директор увидел это
 * 01.08.2026 и спросил, почему бот сразу предлагает квартиру. Дело было не в
 * напоре, а в том, что время он не различал вовсе.
 */

const at = (iso: string): string => new Date(iso).toISOString();
const NOW = new Date("2026-08-01T12:00:00.000Z");

describe("разрывы во времени видны модели", () => {
  it("длинный перерыв помечается перед репликой, которая начинает новый заход", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Салом", at: at("2026-01-22T06:00:00.000Z") },
      { role: "assistant", content: "Кадом тараф?", at: at("2026-01-22T06:05:00.000Z") },
      { role: "user", content: "Боз салом", at: at("2026-08-01T11:00:00.000Z") },
    ];
    const result = withTimeGaps(history, NOW);
    expect(result[1].content).toBe("Кадом тараф?");
    expect(result[2].content).toContain("[перерыв");
    expect(result[2].content).toContain("мес.");
  });

  it("обычная пауза в час пометки не получает — иначе они засорят всю историю", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Салом", at: at("2026-08-01T10:00:00.000Z") },
      { role: "assistant", content: "Кадом тараф?", at: at("2026-08-01T11:00:00.000Z") },
    ];
    expect(withTimeGaps(history, NOW).every((m) => !m.content.includes("[перерыв"))).toBe(true);
  });

  it("отдельно помечается, сколько прошло от последней реплики до сейчас", () => {
    const history: ChatMessage[] = [
      { role: "assistant", content: "Кадом тараф?", at: at("2026-01-22T06:00:00.000Z") },
    ];
    expect(withTimeGaps(history, NOW)[0].content).toContain("[с этого момента прошло");
  });

  it("у старых реплик без даты паузу не выдумываем", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Салом" },
      { role: "assistant", content: "Кадом тараф?" },
    ];
    expect(withTimeGaps(history, NOW)).toEqual(history);
  });

  it("исходную историю не портим — она же уходит в запись", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Салом", at: at("2026-01-22T06:00:00.000Z") },
      { role: "user", content: "Боз салом", at: at("2026-08-01T11:00:00.000Z") },
    ];
    withTimeGaps(history, NOW);
    expect(history[1].content).toBe("Боз салом");
  });
});

describe("человеческая подпись разрыва", () => {
  it("считает в месяцах, днях, сутках и часах", () => {
    expect(humanGap(95 * 24 * 60 * 60 * 1000)).toBe("3 мес.");
    expect(humanGap(5 * 24 * 60 * 60 * 1000)).toBe("5 дн.");
    expect(humanGap(25 * 60 * 60 * 1000)).toBe("сутки");
    expect(humanGap(14 * 60 * 60 * 1000)).toBe("14 ч");
  });
});

/**
 * У БОТА НЕ БЫЛО ЧАСОВ — И ЭТО ВИДЕЛ КЛИЕНТ (переписка 14.08.2026).
 *
 * «Какой сейчас месяц?» → «Сейчас март 2026 года», хотя было 14 августа. Дата
 * стояла ровно в одном месте промта — внутри блока назначения показов, а показы
 * владелец выключил. Вместе с блоком исчезли и часы.
 */
describe("бот знает, какое сегодня число", () => {
  const wall = dushanbeWallClock(new Date("2026-08-14T21:10:00.000Z")); // 15.08, 02:10 в Душанбе

  it("называет настоящие день недели, число, месяц, год и время Душанбе", () => {
    const block = nowBlock(wall);
    expect(block).toContain("15 августа 2026 г.");
    expect(block).toContain("суббота");
    expect(block).toContain("02:10");
  });

  it("прямо запрещает отвечать про дату по своим внутренним представлениям", () => {
    expect(nowBlock(wall)).toMatch(/устаревшие/);
  });
});
