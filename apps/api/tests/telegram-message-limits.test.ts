import { describe, expect, it } from "vitest";
import { splitTelegramText } from "../src/telegram/api.js";

/**
 * Telegram отвергает текст >4096 символов ЦЕЛИКОМ: длинный ответ (список объектов,
 * разошедшаяся модель) раньше ронял отправку — клиент не получал ничего.
 */
describe("нарезка длинного текста для Telegram", () => {
  it("короткий текст остаётся одним сообщением", () => {
    expect(splitTelegramText("привет")).toEqual(["привет"]);
  });

  it("длинный текст режется на куски не длиннее 4096, без потери содержимого", () => {
    const line = "строка о квартире в Сино с ценой и адресом\n";
    const text = line.repeat(300); // ~12 900 символов
    const parts = splitTelegramText(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    // Содержимое сохраняется (нормируем пробелы на стыках — они съедаются trim'ом).
    expect(parts.join("\n").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });

  it("режет по границе строки, а не посреди слова", () => {
    const text = `${"а".repeat(4000)}\n${"б".repeat(4000)}`;
    const parts = splitTelegramText(text);
    expect(parts[0]).toBe("а".repeat(4000));
    expect(parts[1]).toBe("б".repeat(4000));
  });

  it("сплошная простыня без пробелов всё равно укладывается в предел", () => {
    const parts = splitTelegramText("х".repeat(10_000));
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    expect(parts.join("")).toBe("х".repeat(10_000));
  });
});
