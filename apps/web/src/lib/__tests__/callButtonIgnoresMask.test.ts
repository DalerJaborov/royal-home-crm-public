import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Кнопка звонка не прячется из-за маски в номере (аудит 23.09.2026, №54).
 *
 * CRM звонит по карточке, номер берёт сервер. Строки списков решали «можно ли
 * звонить» по «•» в номере — агенту без права видеть номера кнопка пропадала на
 * телефоне и на Главной, хотя на компьютере в списке клиентов она была.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const FILES = [
  // Desktop and legacy phone rows now use the same eligibility workflow.
  "../../hooks/useClientRowActions.ts",
  // Главная агента с 06.10.2026 одна и собрана из трёх файлов; решение «звонить
  // можно» принимается в карточке «Сначала это» и в строках очереди.
  "../../components/home/agent/AgentFocusCard.tsx",
  "../../components/home/agent/AgentQueue.tsx",
  // ClientDetail.tsx здесь больше нет: полоса «первый звонок» («Срок вышел —
  // звоните сейчас») убрана с карточки 29.09.2026 по решению владельца.
];

describe("решение «показать звонок» не смотрит на маску номера", () => {
  for (const file of FILES) {
    it(file, () => {
      const lines = read(file)
        .split("\n")
        .filter((l) => /const canCall =/.test(l));
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(line).not.toContain('includes("•")');
    });
  }
});
