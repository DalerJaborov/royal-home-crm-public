import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Одобряющий видит цену и комиссию сделки, которую одобряет (глубокая проверка
 * 02.10.2026, C15; решение владельца «да, по советам»).
 *
 * Сервер отдаёт суммы сделки «Ждёт одобрения» тому, кто вправе её одобрить,
 * и без права на финансы. Экран прятал их по одному праву на финансы —
 * менеджер нажимал «Одобрить» вслепую. Полоса «Решить сейчас» общая для
 * телефона и компьютера (Deals.tsx отдаёт её в MobileDeals), пульт — свой.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("суммы сделки на одобрении — тому, кто одобряет", () => {
  it("«Решить сейчас»: цена и комиссия видны и по праву одобрять", () => {
    const src = read("../../pages/Deals.tsx");
    const start = src.indexOf("const solve =");
    const solve = src.slice(start, src.indexOf(`className="acts"`, start));
    expect(solve).toMatch(/\{seesMoney \|\| canComplete \? \(/);
    expect(solve).toContain(". Цена <b>");
  });

  it("пульт: строка сделки на одобрении показывает цену и комиссию, если сервер их прислал", () => {
    const src = read("../../components/pult/PultActions.tsx");
    expect(src).not.toMatch(/data\.seesMoney && deal\.commissionAmount/);
    expect(src).toMatch(/deal\.soldPrice != null \? `цена/);
    expect(src).toMatch(/deal\.commissionAmount \? `комиссия/);
  });
});
