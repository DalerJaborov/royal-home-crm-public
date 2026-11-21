import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Тексты уведомлений и записей сервера после замены «лид» → «заявка» (ревью #341, 20.11.2026): слово женского рода, и глагол
 * рядом обязан быть женским («передана», «не принята»), а не «передан». Правила рода и точные строки проверяются по исходникам:
 * сами функции завязаны на базу и очереди, а ошибка здесь не в логике, а в окончании.
 */
const src = (rel: string) => readFileSync(path.resolve(__dirname, "../src", rel), "utf8");

describe("серверные тексты: «заявка» с правильным родом", () => {
  it("уведомления о передаче и сроке", () => {
    expect(src("lib/clientRefuse.ts")).toContain("Отказная заявка передана вам");
    expect(src("services/leads/reassignment.ts")).toContain('"Заявка по объекту не принята вовремя"');
    expect(src("services/leads/reassignment.ts")).toContain("Заявка переназначена вам");
    expect(src("lib/staffAdmin.ts")).toContain("Возвращено в очередь заявок:");
    expect(src("routes/push.ts")).toContain("Заявка уже не за вами");
  });

  it("в тексте для людей нет мужского рода рядом со словом «заявка»", () => {
    const files = ["lib/clientRefuse.ts", "services/leads/reassignment.ts", "services/leads/assignment.ts", "lib/staffAdmin.ts", "lib/agentLeadPause.ts", "lib/problemReport.ts", "lib/leadAccept.ts", "services/leads/intake.ts", "services/leads/firstCall.ts"];
    const bad = /(?<![а-яё])(?:[Зз]аявк[аиеуой]{1,2}\s+(?:передан|принят|отдан|назначен|создан|снят|возвращён|распределён|переназначен|отклонён|ушёл)(?![а-яё])|непринят(?:ый|ого|ому)\s+заявк|нов(?:ый|ого|ому)\s+заявк)/u;
    const found: string[] = [];
    for (const f of files) {
      src(f).split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (bad.test(line)) found.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("сторож рода проверен поломкой: ловит «заявка передан» и пропускает «заявка передана»", () => {
    const bad = /(?<![а-яё])[Зз]аявк[аиеуой]{1,2}\s+(?:передан|принят)(?![а-яё])/u;
    expect(bad.test("Отказная заявка передан вам")).toBe(true);
    expect(bad.test("Заявка не принят вовремя")).toBe(false);
    expect(bad.test("Отказная заявка передана вам")).toBe(false);
  });
});
