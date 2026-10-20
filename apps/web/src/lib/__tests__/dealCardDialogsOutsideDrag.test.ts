import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Окна карточки сделки — снаружи перетаскиваемого элемента (аудит 23.09.2026, №53).
 *
 * События React всплывают по дереву компонентов даже из портала: окна, стоявшие
 * внутри карточки с onClick и обработчиками перетаскивания, открывали клиента
 * кликом по фону и тащили карточку при выделении текста.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

function closingAfterLastDialog(src: string): string | null {
  const from = src.lastIndexOf("<DealDocumentsModal");
  const m = /\n\s*<\/(article|div|)>\n/.exec(src.slice(from));
  return m ? m[1] : null;
}

describe("окна сделки не внутри перетаскиваемой карточки", () => {
  it("доска на компьютере", () => {
    expect(closingAfterLastDialog(read("../../pages/Deals.tsx"))).toBe("");
  });
  it("доска на телефоне", () => {
    expect(closingAfterLastDialog(read("../../components/mobile/MobileDeals.tsx"))).toBe("");
  });
});
