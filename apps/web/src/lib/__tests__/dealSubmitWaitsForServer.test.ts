import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Окно «на закрытие» ждёт ответа и не теряет суммы (аудит 23.09.2026, №58).
 *
 * Окно закрывалось сразу после нажатия, и при отказе сервера («не хватает
 * документов») введённые цена и комиссия пропадали.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("окно цены и комиссии сделки", () => {
  it("ждёт ответ и показывает отказ", () => {
    const src = read("../../components/DealSubmitModal.tsx");
    expect(src).toMatch(/await onSubmit\(/);
    expect(src).toMatch(/setError\(/);
  });
  for (const file of ["../../pages/Deals.tsx", "../../components/mobile/MobileDeals.tsx"]) {
    it(`${file}: окно закрывается после ответа, а не до`, () => {
      const src = read(file);
      // Каждый вызов из окна закрытия — с await.
      expect(src).not.toMatch(/[^t] onMoveStage\(deal\.id, canComplete/);
      expect(src).toMatch(/await onMoveStage\(deal\.id, canComplete/);
    });
  }
});
