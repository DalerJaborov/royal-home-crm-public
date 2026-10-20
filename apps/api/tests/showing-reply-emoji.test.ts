import { describe, expect, it } from "vitest";
import { classifyShowingReply } from "../src/lib/showingReply.js";

/**
 * Эмодзи-«да» не должно перебивать явный отказ в тексте (CRM-SHOWING01):
 * «Не смогу прийти 👍» раньше уходило в «подтвердил», агент получал «показ в силе»,
 * хотя клиент отказался. Чистая функция, БД не нужна.
 */
describe("classifyShowingReply: эмодзи и отказ", () => {
  it("отказ с эмодзи остаётся отказом", () => {
    expect(classifyShowingReply("Не смогу прийти 👍")).toBe("no");
    expect(classifyShowingReply("Нет, перенесём на завтра ✅")).toBe("no");
    expect(classifyShowingReply("отменяю 👌")).toBe("no");
  });

  it("эмодзи по-прежнему подтверждает, когда отказа нет", () => {
    expect(classifyShowingReply("👍")).toBe("yes");
    expect(classifyShowingReply("ок 👍")).toBe("yes");
    expect(classifyShowingReply("Спасибо 👍")).toBe("yes");
  });

  it("«нет проблем» с эмодзи это согласие", () => {
    expect(classifyShowingReply("нет проблем 👍")).toBe("yes");
  });

  it("пустой текст без эмодзи не ясен", () => {
    expect(classifyShowingReply("   ")).toBe("unclear");
  });
});
