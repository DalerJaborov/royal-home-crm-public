import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { claimStepUp, globalStepUpNeeded } from "../stepUpOwners";

/**
 * «Подтвердите, что это вы» открывается на любом экране (аудит 23.09.2026, №34).
 * Обучение ИИ, передача дел уволенного, улучшение фото упирались в 428 без окна.
 */
const SRC = fileURLToPath(new URL("../..", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "__tests__" || n === "dev" ? [] : tsxFiles(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

describe("общее окно подтверждения личности", () => {
  it("нужно, пока ни один экран не обрабатывает подтверждение сам", () => {
    expect(globalStepUpNeeded()).toBe(true);
    const release = claimStepUp();
    expect(globalStepUpNeeded()).toBe(false);
    release();
    release();
    expect(globalStepUpNeeded()).toBe(true);
  });

  it("стоит в приложении рядом с остальными общими окнами", () => {
    expect(readFileSync(join(SRC, "App.tsx"), "utf8")).toMatch(/<GlobalStepUpHost \/>/);
  });

  it("каждый экран со своим окном подтверждения забирает его на себя — двух окон не будет", () => {
    const own = tsxFiles(SRC).filter((f) => {
      const src = readFileSync(f, "utf8");
      return /<StepUp(Dialog|Gate)\b/.test(src) && !f.endsWith("GlobalStepUpHost.tsx") && !f.endsWith("StepUpGate.tsx");
    });
    const unclaimed = own.filter((f) => !readFileSync(f, "utf8").includes("claimStepUp"));
    // Экраны, где StepUpGate только вставлен (Настройки), — он сам забирает окно.
    const gateOnly = unclaimed.filter((f) => !/<StepUpDialog\b/.test(readFileSync(f, "utf8")));
    expect(unclaimed.filter((f) => !gateOnly.includes(f)).map((f) => f.slice(SRC.length))).toEqual([]);
    expect(readFileSync(join(SRC, "components/StepUpGate.tsx"), "utf8")).toContain("claimStepUp");
  });
});
