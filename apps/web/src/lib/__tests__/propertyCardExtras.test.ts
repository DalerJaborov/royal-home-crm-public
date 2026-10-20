import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Карточка объекта без лишнего (24.09.2026, разбор карточки, пункты 8, 9, 14).
 *
 * Подбор открывался тремя путями (плитка, вкладка «Клиенты», кнопка), плитка
 * «фотографий в карточке» показывала число без пользы, подпись для Reels
 * занимала шесть строк посреди просмотра, а «Подбор · N» висел голой кнопкой.
 */
const src = readFileSync(fileURLToPath(new URL("../../pages/PropertyDetail.tsx", import.meta.url)), "utf8");

describe("карточка объекта без лишнего", () => {
  it("вкладки «Клиенты» нет — подбор открывает одна плитка", () => {
    expect(src).not.toContain('["clients", "Клиенты"]');
    expect(src).not.toContain('tab === "clients"');
  });

  it("ручной карточки «Приватная ссылка для клиента» нет — ссылка выдаётся сама при отправке", () => {
    expect(src).not.toContain("PropertyShareLinksCard");
  });

  it("плитки «фотографий в карточке» нет, вместо неё дни с приёма", () => {
    expect(src).not.toContain("фотографий в карточке");
    expect(src).toContain("с приёма объекта");
  });

  it("подпись для Reels в просмотре свёрнута в строку", () => {
    // Одна раскладка с 06.10.2026: блок стоит один раз, во вкладке «Коротко».
    expect(src.match(/<ReelsCaptionBlock [^>]*collapsible \/>/g)?.length).toBe(1);
  });

  it("подбор — строкой «N покупателей ждут», голой кнопки «Подбор · N» нет", () => {
    expect(src).not.toMatch(/Подбор\{property\.demandCount/);
    // Строка одна на ПК и телефон (06.10.2026), под действиями; ссылка зовётся «Предложить».
    expect(src.match(/<DemandLine /g)?.length).toBe(1);
    expect(src).toContain("Предложить");
  });
});
