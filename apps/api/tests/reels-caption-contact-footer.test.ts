import { describe, expect, it } from "vitest";
import { applyContactFooter, formatTjPhone, withPostFooter } from "../src/lib/reelsCaptionTemplate.js";

/**
 * Концовка подписи с агентом по объекту (владелец 25.09.2026): номер из
 * профиля, «Агент <имя>» без фамилии, затем номер агентства. Легко сломать
 * незаметно две вещи: повторный прогон (концовка должна заменяться, а не
 * копиться) и старые формы строки с номером, которые уже лежат в базе.
 */
const NOZA = { fullName: "Ноза", phone: "+992777070100" };
const FOOTER_NOZA = "📲 Звоните или пишите в директ:\n+992 77 707-01-00 Агент Ноза\n+992 44 650-14-14 Royal Home";

describe("applyContactFooter", () => {
  it("формат номера как у агентства; чужую длину печатает как есть", () => {
    expect(formatTjPhone("+992930001020")).toBe("+992 93 000-10-20");
    expect(formatTjPhone("12345")).toBe("12345");
  });

  it("имя без фамилии", () => {
    const out = applyContactFooter("Текст\n📲 +992 44 650-14-14", { fullName: "Сурайё Каримова", phone: "+992930001020" });
    expect(out).toContain("+992 93 000-10-20 Агент Сурайё\n");
    expect(out).not.toContain("Каримова");
  });

  it("заменяет старую строку призыва целиком и сохраняет текст до неё", () => {
    const caption = "✅Цена: 1 с.\n\nВсе сделки в национальной валюте. Пишите в директ или звоните:📞 +992 44 650-14-14";
    expect(applyContactFooter(caption, NOZA)).toBe(`✅Цена: 1 с.\n\nВсе сделки в национальной валюте.\n${FOOTER_NOZA}`);
  });

  it("личный номер старой формы тоже заменяется, строки после — остаются", () => {
    const caption = "Цена: 1 с.\n📲 Пишите в директ или звоните: +992777070100\nRoyal Home — только проверенные объекты!";
    expect(applyContactFooter(caption, NOZA)).toBe(`Цена: 1 с.\n${FOOTER_NOZA}\nRoyal Home — только проверенные объекты!`);
  });

  it("идемпотентна и догоняет смену агента, подвал «Объект №» не трогает", () => {
    const first = withPostFooter(applyContactFooter("Текст\n📲 +992 44 650-14-14", NOZA), 112);
    expect(applyContactFooter(first, NOZA)).toBe(first);
    const other = applyContactFooter(first, { fullName: "Умед", phone: "+992000001017" });
    expect(other).toContain("+992 00 000-10-17 Агент Умед");
    expect(other).not.toContain("Ноза");
    expect(other.endsWith("\n\nОбъект №112")).toBe(true);
  });

  it("без номера в тексте встаёт перед подвалом; без агента — только агентство", () => {
    expect(applyContactFooter("Текст\n\nОбъект №5", null)).toBe(
      "Текст\n\n📲 Звоните или пишите в директ:\n+992 44 650-14-14 Royal Home\n\nОбъект №5"
    );
  });
});
