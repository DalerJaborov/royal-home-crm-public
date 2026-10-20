import { describe, expect, it } from "vitest";
import { cleanOutgoingReply, isReactionOnly, stripFillerWords, stripMachineTypography } from "../src/ai/replyGuards.js";
import { followUpLimit, isFollowUpDue } from "../src/lib/botFollowUps.js";

/**
 * Пакет правил поведения бота от 02.08.2026 (директор: «слишком много вопросов,
 * повторяет за клиентом, слова-паразиты, напоминания навязчивые»).
 *
 * Всё здесь — фильтры в коде, а не строчки в промте. Причина записана кровью: за
 * один день 01.08 пять правил, работавших неделями, молча перестали срабатывать на
 * живом клиенте. Промт — просьба, фильтр — гарантия.
 */

describe("Одна реакция — не разговор", () => {
  it("сообщение из одних смайликов ответа не требует", () => {
    expect(isReactionOnly("🔥")).toBe(true);
    expect(isReactionOnly("❤️❤️❤️")).toBe(true);
    expect(isReactionOnly("👍 👏")).toBe(true);
    expect(isReactionOnly("  ")).toBe(true);
    // Регулярное выражение эмодзи объявлено с флагом g: без сброса lastIndex
    // повторный вызов на такой же строке вернул бы неверный ответ через раз.
    expect(isReactionOnly("🔥")).toBe(true);
  });

  /** Знаки препинания — это речь. «+» в наших чатах значит «да», «???» — «ну что там». */
  it("«+» и «???» — это ответ клиента, а не пустая реакция", () => {
    expect(isReactionOnly("+")).toBe(false);
    expect(isReactionOnly("???")).toBe(false);
    expect(isReactionOnly("!!!")).toBe(false);
  });

  it("слова и цифры — это обращение, на него отвечаем", () => {
    expect(isReactionOnly("салом")).toBe(false);
    expect(isReactionOnly("5?")).toBe(false);
    expect(isReactionOnly("ок")).toBe(false);
    // Смайлик рядом со словами не делает сообщение пустым.
    expect(isReactionOnly("🔥 чанд сомонӣ?")).toBe(false);
  });
});

describe("Слова-паразиты не доезжают до клиента", () => {
  // Заглавная буква возвращается не здесь, а в общей очистке (cleanOutgoingReply):
  // фильтров несколько, и восстанавливать регистр в каждом значило бы делать это
  // трижды за сообщение.
  it("вводные обороты вырезаются вместе с прилипшей запятой", () => {
    expect(stripFillerWords("В принципе, у нас есть такой вариант")).toBe("у нас есть такой вариант");
    expect(stripFillerWords("Цена, собственно, договорная")).toBe("Цена, договорная");
    expect(stripFillerWords("Хочу отметить, что дом новый")).toBe("что дом новый");
  });

  it("обычные слова не трогаются", () => {
    const normal = "В Сино есть двухкомнатная, 320 000 сомони";
    expect(stripFillerWords(normal)).toBe(normal);
  });

  it("фильтр включён в общую очистку исходящего", () => {
    expect(cleanOutgoingReply("В общем, дом сдан")).toBe("Дом сдан");
  });
});

describe("Напоминания: сколько раз писать молчащему", () => {
  it("по умолчанию одно — второго в ту же тишину не будет", () => {
    expect(followUpLimit(undefined)).toBe(1);
    const lastMessage = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const window = { start: "00:00", end: "23:59" };
    // Первое напоминание — пора.
    expect(isFollowUpDue("conv-1", lastMessage, 0, window, new Date(), 1)).toBe(true);
    // Второе при лимите «одно» — уже нет, сколько бы времени ни прошло.
    expect(isFollowUpDue("conv-1", lastMessage, 1, window, new Date(), 1)).toBe(false);
  });

  it("владелец может вернуть два или три, но не больше трёх", () => {
    expect(followUpLimit(2)).toBe(2);
    expect(followUpLimit(3)).toBe(3);
    expect(followUpLimit(10)).toBe(3);
  });

  it("ноль — не напоминать вовсе", () => {
    expect(followUpLimit(0)).toBe(0);
    const window = { start: "00:00", end: "23:59" };
    expect(isFollowUpDue("conv-1", new Date(Date.now() - 6 * 60 * 60 * 1000), 0, window, new Date(), 0)).toBe(false);
  });

  it("мусор в настройке не отключает напоминания молча", () => {
    expect(followUpLimit(-5)).toBe(1);
    expect(followUpLimit(Number.NaN)).toBe(1);
  });
});

/**
 * Проверка QA нашла эти четыре случая в уже выкаченных фильтрах. Все они портили
 * текст живым клиентам, поэтому тесты записаны ровно теми строками, на которых
 * ломалось.
 */
describe("Фильтры не портят нормальную речь", () => {
  it("«как бы» не режет «как быстро», «собственно» не режет «собственность»", () => {
    // Без границы справа клиенту уходило «Стро вы хотите заехать?».
    expect(stripFillerWords("Как быстро вы хотите заехать?")).toBe("Как быстро вы хотите заехать?");
    expect(stripFillerWords("Как быть с рассрочкой?")).toBe("Как быть с рассрочкой?");
    expect(stripFillerWords("Документ на собственность готов")).toBe("Документ на собственность готов");
  });

  it("женский род ловится целиком, а не оставляет висящую букву", () => {
    // `\w*` не знает кириллицы: вырезалось «Как я уже говорил», оставалось «а,».
    expect(stripFillerWords("Как я уже говорила, у нас есть вариант")).toBe("у нас есть вариант");
    // «что» уходит вместе с вводной (02.10.2026): придаточное без главного — обрубок.
    expect(stripFillerWords("Рада сообщить, что квартира свободна")).toBe("квартира свободна");
  });

  it("список остаётся списком, а вилка цены — вилкой", () => {
    expect(stripMachineTypography("Есть варианты:\n— 2-хонагӣ, 320 000\n— 3-хонагӣ, 450 000")).toBe(
      "Есть варианты:\n2-хонагӣ, 320 000\n3-хонагӣ, 450 000"
    );
    // «320 000, 350 000» читалось как две цены, и клиент спрашивал, какая настоящая.
    expect(stripMachineTypography("Нарх 320 000 — 350 000 сомонӣ")).toBe("Нарх 320 000-350 000 сомонӣ");
    expect(stripMachineTypography("Метраж 95 – 110 м2")).toBe("Метраж 95-110 м2");
  });

  it("знаки-эмодзи, которые значат речь, молчанием не считаются", () => {
    for (const t of ["❓", "❗", "➕", "✅"]) expect(isReactionOnly(t)).toBe(false);
    expect(isReactionOnly("🔥")).toBe(true);
  });
});
