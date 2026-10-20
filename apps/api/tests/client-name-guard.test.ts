import { describe, expect, it } from "vitest";
import { clientSelfStatedName, normalizeClientName } from "../src/ai/replyGuards.js";
import { isPlaceholderName } from "../src/lib/placeholderName.js";

/**
 * ИМЯ КЛИЕНТА В КАРТОЧКЕ — то, на что владелец пожаловался 30.08.2026: «некоторые
 * клиенты дают своё имя, а ИИ не вставляет имя в карточку, это важно».
 *
 * Разбор прода за 14 дней дал два списка, и оба перенесены сюда дословно: карточки,
 * где имя прозвучало и потерялось, и карточки, куда в поле «Имя» записан мусор.
 * Проверяется без базы: это чистые функции, а цена ошибки в них — имя живого
 * человека в его карточке.
 */

describe("что именем клиента быть не может", () => {
  it("целая фраза клиента в поле имени — живые примеры с прода", () => {
    // «а как мне это сделать?» и «извините, что поздно отвечаю, я на работе»
    expect(normalizeClientName("Чихели кунум")).toBeNull();
    expect(normalizeClientName("Бахшиш дер чавоб додестам ман кордаям")).toBeNull();
  });

  it("служебное слово, обращение, город и адрес — не имя", () => {
    for (const junk of ["Тел", "Ака", "Хонахар", "Хона хар 😂", "Варзоб", "Адрес курган"]) {
      expect(normalizeClientName(junk)).toBeNull();
    }
  });

  it("заглушка CRM, ник и логин именем не становятся", () => {
    for (const junk of ["Покупатель №42", "raxxmanzadee", "@nozil760", "Jl"]) {
      expect(normalizeClientName(junk)).toBeNull();
    }
  });
});

describe("имя, названное клиентом, доходит до карточки", () => {
  it("приставка представления и прилипший телефон отбрасываются", () => {
    expect(normalizeClientName("Ном Фозилшо")).toBe("Фозилшо");
    expect(normalizeClientName("номам Гулру")).toBe("Гулру");
    expect(normalizeClientName("Наргиз 900001014")).toBe("Наргиз");
    expect(normalizeClientName("Фаррух 🏠")).toBe("Фаррух");
  });

  it("обычные имена проходят как есть", () => {
    expect(normalizeClientName("Далер")).toBe("Далер");
    expect(normalizeClientName("Пиров махмуд")).toBe("Пиров Махмуд");
    expect(normalizeClientName("Hokimshoh")).toBe("Hokimshoh");
    expect(normalizeClientName("Абдулло-Хон")).toBe("Абдулло-Хон");
  });

  it("представление посреди разговора, а не в ответ на вопрос", () => {
    expect(clientSelfStatedName([{ role: "user" as const, content: "Ном Фозилшо" }])).toBe("Фозилшо");
    expect(clientSelfStatedName([{ role: "user" as const, content: "номам Гулру" }])).toBe("Гулру");
    expect(clientSelfStatedName([{ role: "user" as const, content: "Ман Далер, хона мекобам" }])).toBe("Далер");
    // «я на работе» — не представление, хотя начинается с того же слова.
    expect(clientSelfStatedName([{ role: "user" as const, content: "бахшиш дер чавоб додестам ман кордаям" }])).toBeNull();
  });
});

describe("одно определение «имя ещё запасное» на весь проект", () => {
  it("узнаёт заглушки всех каналов сразу", () => {
    for (const stub of [
      "Покупатель №1234",
      "Продавец №7",
      // Текущий формат номера карточки (formatClientCode, с 31.08.2026 покупатель = ПК).
      // Именно «ПК-» выпало из признака заглушки и полгода считалось настоящим именем.
      "Покупатель ПК-000260",
      "Продавец ПР-000141",
      "Прочее обращение ПО-000058",
      "Входящий ***67",
      "Входящий +992900112233",
      "Клиент Instagram",
      "Клиент из мессенджера",
      "@nozil760",
      "raxxmanzadee",
      "🎓",
      "+992 900 11 22 33",
      "Покупатель",
      "",
    ]) {
      expect(isPlaceholderName(stub)).toBe(true);
    }
  });

  it("настоящее имя заглушкой не считает — его не перезапишет ни бот, ни разбор звонка", () => {
    for (const name of ["Фозилшо", "Наргиз Пирова", "Hokimshoh"]) {
      expect(isPlaceholderName(name)).toBe(false);
    }
  });
});
