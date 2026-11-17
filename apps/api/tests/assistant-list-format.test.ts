import { describe, expect, it } from "vitest";
import { LIST_MESSAGE_LIMIT, listNumber, renderAssistantListHtml, renderAssistantListText } from "../src/telegram/assistantList.js";

/**
 * Один вид всех списков помощницы (владелец 10.11.2026, telegram/assistantList.ts):
 * заголовок с иконкой и числом, номер-эмодзи, код карточки первым и жирным,
 * главное — второй строкой, срок — третьей, совет отдельной строкой, предел
 * Telegram — страницами с продолжением нумерации, ru/tg.
 */
describe("список помощницы", () => {
  it("образец владельца", () => {
    const [html] = renderAssistantListHtml({
      icon: "🏠", title: "Объекты без движения",
      items: [
        { code: "ОБ-000161", title: "3к · Ашан", main: ["💰 $120 750 · 📉 соседние дешевле ~10%"], when: "📅 48 дней без продажи" },
        { code: "ОБ-000162", title: "2к · Сино", main: ["💰 $80 000"], when: "📅 31 день без продажи" },
      ],
      tip: "предложите собственникам пересмотреть цену.",
    });
    expect(html).toBe([
      "🏠 <b>Объекты без движения</b> · 2",
      "1️⃣ <b>ОБ-000161</b> — 3к · Ашан\n💰 $120 750 · 📉 соседние дешевле ~10%\n📅 48 дней без продажи",
      "2️⃣ <b>ОБ-000162</b> — 2к · Сино\n💰 $80 000\n📅 31 день без продажи",
      "💡 Совет: предложите собственникам пересмотреть цену.",
    ].join("\n\n"));
  });

  it("номера: 1️⃣…🔟, дальше «11.»", () => {
    expect(listNumber(1)).toBe("1️⃣");
    expect(listNumber(10)).toBe("🔟");
    expect(listNumber(11)).toBe("11.");
  });

  it("длинный список — страницы не длиннее предела, нумерация продолжается, совет на последней", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      code: `ПК-${String(i + 1).padStart(6, "0")}`, title: `Клиент ${i + 1}`, main: ["x".repeat(120)], when: "📅 завтра",
    }));
    const pages = renderAssistantListHtml({ icon: "👥", title: "Клиенты", items, tip: "позвоните первым трём." });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(page.length).toBeLessThanOrEqual(LIST_MESSAGE_LIMIT);
    expect(pages[0]).toContain(`(стр. 1/${pages.length})`);
    expect(pages[1]).toMatch(/^👥 <b>Клиенты<\/b> · 60 \(стр\. 2\//);
    expect(pages.join("\n")).toContain("60. <b>ПК-000060</b>");
    expect(pages.at(-1)).toContain("💡 Совет:");
    expect(pages.slice(0, -1).join("")).not.toContain("💡");
  });

  it("одна карточка длиннее страницы — обрезается, а не теряется и не ломает разметку", () => {
    const [page] = renderAssistantListHtml({ icon: "📋", title: "Задачи", items: [{ title: "a & b ".repeat(2000) }] });
    expect(page.length).toBeLessThanOrEqual(LIST_MESSAGE_LIMIT);
    expect(page).not.toMatch(/&[a-z]*…$/);
  });

  it("текст экранируется, длинное — свёрнутой цитатой", () => {
    const [page] = renderAssistantListHtml({ icon: "📋", title: "<Задачи>", items: [{ title: "Позвонить <Умеду>", details: "долгий рассказ" }] });
    expect(page).toContain("&lt;Задачи&gt;");
    expect(page).toContain("Позвонить &lt;Умеду&gt;");
    expect(page).toContain("<blockquote expandable>долгий рассказ</blockquote>");
  });

  it("таджикский: совет и страницы по-таджикски, пустой список — своей строкой", () => {
    const [empty] = renderAssistantListHtml({ icon: "📋", title: "Вазифаҳо", items: [], lang: "tg" });
    expect(empty).toContain("Ҳоло холӣ.");
    const [tip] = renderAssistantListHtml({ icon: "📋", title: "Вазифаҳо", items: [{ title: "a" }], tip: "занг занед.", lang: "tg" });
    expect(tip).toContain("💡 Маслиҳат: занг занед.");
  });

  it("текстовый вид для ответа помощницы — код карточки ссылкой", () => {
    const [text] = renderAssistantListText({ icon: "👥", title: "Клиенты агента Умед", total: 6, items: [{ code: "ПК-000012", href: "/clients/12", title: "Фарход" }], note: "Показываю 1 из 6." });
    expect(text).toBe("👥 Клиенты агента Умед · 6\n\n1️⃣ [ПК-000012](/clients/12) — Фарход\n\nПоказываю 1 из 6.");
  });
});
