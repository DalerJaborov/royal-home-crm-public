import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * «Одобрить» сделку — только через окно подтверждения (17.11.2026, аудит F3-2).
 *
 * Одобрение закрывает сделку и начисляет доли — отменить нельзя. Кнопка слала
 * PATCH с первого касания, а на телефоне её легко задеть, листая «Ждут
 * одобрения». Сторож: в Deals.tsx перевод в COMPLETED звучит ровно один раз — в
 * обработчике подтверждения окна `DealStageConfirm action="approve"`.
 */
const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../Deals.tsx");

describe("Deals: «Одобрить» только с подтверждением", () => {
  const source = fs.readFileSync(FILE, "utf8");

  it("перевод в COMPLETED — один, и он внутри окна подтверждения", () => {
    const direct = source.match(/updateDeal\.mutate\(\{\s*id:\s*[\w.]+,\s*body:\s*\{\s*stage:\s*"COMPLETED"\s*\}\s*\}\)/g) ?? [];
    expect(direct).toHaveLength(1);
    const confirmBlock = source.match(/<DealStageConfirm\s+action="approve"[\s\S]*?onCancel=/);
    expect(confirmBlock?.[0]).toContain('stage: "COMPLETED"');
  });

  it("кнопки «Одобрить» открывают окно и гаснут на время запроса", () => {
    const buttons = source.match(/<button[^>]*>\s*Одобрить\s*<\/button>|<button[\s\S]{0,400}?>\s*Одобрить\s*<\/button>/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) {
      expect(b).toContain("setApprovingId(");
      expect(b).toContain("disabled={updateDeal.isPending}");
    }
  });
});
