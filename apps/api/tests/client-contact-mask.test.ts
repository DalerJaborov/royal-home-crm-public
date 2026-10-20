import { describe, expect, it } from "vitest";
import { maskClientPhone, maskPhonesInFreeText, maskPhonesInText } from "../src/lib/clientPhone.js";

/**
 * Расширение маскировки телефона на ссылки t.me/wa.me и ники @username
 * (владелец 01.09.2026). До этой правки regex ловил только цифры номера —
 * ссылка на Telegram/WhatsApp и ник Instagram/Telegram проходили в переписке
 * немаскированными, то есть тот же обход АТС, что уже чинили с номером в
 * тексте, но через другой канал. См. историю в lib/clientPhone.ts.
 */
describe("маскировка контактов в тексте — не только номер", () => {
  it("телефон по-прежнему маскируется (regression)", () => {
    expect(maskPhonesInText("звони +992910001003")).toBe(`звони ${maskClientPhone("+992910001003")}`);
  });

  it("ссылка t.me/username — маскирована, но опознаваема как ссылка", () => {
    const res = maskPhonesInText("пиши сюда t.me/ivan_petrov договоримся");
    expect(res).not.toContain("ivan_petrov");
    expect(res).toContain("t.me/•••••");
    expect(res).toBe("пиши сюда t.me/••••• договоримся");
  });

  it("полная ссылка https://t.me/username тоже маскируется", () => {
    const res = maskPhonesInText("вот https://t.me/ivan_petrov");
    expect(res).not.toContain("ivan_petrov");
    expect(res).toContain("t.me/•••••");
  });

  it("ссылка wa.me/79161234567 — маскирована, но опознаваема как ссылка", () => {
    const res = maskPhonesInText("напишите wa.me/79161234567 пожалуйста");
    expect(res).not.toContain("79161234567");
    expect(res).toMatch(/wa\.me\/•{6,}/);
  });

  it("ник @username — маскирован, первый символ (@) остаётся опознаваемым", () => {
    const res = maskPhonesInText("мой инстаграм @ivan_petrov_92");
    expect(res).not.toContain("ivan_petrov_92");
    expect(res).toBe("мой инстаграм @•••••");
  });

  it("email НЕ маскируется — вне задачи", () => {
    const res = maskPhonesInText("пишите на ivan.petrov@example.com");
    expect(res).toBe("пишите на ivan.petrov@example.com");
  });

  it("обычный текст без признаков контакта не портится", () => {
    const text = "Клиент ищет двушку в Сино до пятидесяти тысяч, бюджет 450000 сомони.";
    expect(maskPhonesInText(text)).toBe(text);
  });

  it("короткое слово из 1-2 символов после @ не считается ником (порог 3 символа)", () => {
    const res = maskPhonesInText("встретимся в 18:00 @ дома");
    expect(res).toBe("встретимся в 18:00 @ дома");
  });

  it("работает и в свободном пересказе (ИИ-сводка): ссылка + номер вместе", () => {
    const res = maskPhonesInFreeText("Клиент оставил t.me/ivan_petrov и продиктовал 910 00 10 03");
    expect(res).not.toContain("ivan_petrov");
    expect(res).not.toContain("910 00 10 03");
    expect(res).toContain("t.me/•••••");
  });
});
