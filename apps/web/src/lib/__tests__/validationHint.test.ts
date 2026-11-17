import { describe, expect, it } from "vitest";
import { withFieldHint } from "../validationHint";

/** «Неверные данные» с названием поля (17.11.2026, аудит F3-4). */
describe("withFieldHint", () => {
  it("называет поле по-русски", () => {
    const data = { error: "Неверные данные", details: { formErrors: [], fieldErrors: { desiredAreaMin: ["Expected integer"] } } };
    expect(withFieldHint("Неверные данные", data)).toBe("Неверные данные. Проверьте поле: Площадь от");
  });
  it("несколько полей — не больше трёх, без повторов", () => {
    const data = { details: { fieldErrors: { rooms: ["x"], desiredRooms: ["x"], price: ["x"], floor: ["x"], areaSqm: ["x"] } } };
    expect(withFieldHint("Неверные данные", data)).toBe("Неверные данные. Проверьте поля: Комнат, Цена, Этаж");
  });
  it("поле без подписи и ответ без details — текст как был", () => {
    expect(withFieldHint("Неверные данные", { details: { fieldErrors: { someInternalKey: ["x"] } } })).toBe("Неверные данные");
    expect(withFieldHint("Нет доступа", { error: "Нет доступа" })).toBe("Нет доступа");
    expect(withFieldHint("Ошибка", undefined)).toBe("Ошибка");
  });
});
