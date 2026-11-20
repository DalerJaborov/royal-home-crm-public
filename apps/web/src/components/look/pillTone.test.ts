import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { clientActionPillTone, pillTone, pillToneOf, scorePillTone, type PillMeaning } from "./tileTone";

/**
 * ТОН ПИЛЮЛИ — ОДНА ФУНКЦИЯ (К13, аудит 20.11.2026): обычное нейтрально, жёлтое — сегодня, красное — просрочено,
 * ноль спокоен. Живёт рядом с `tileTone` (тот же файл, то же правило для плиток).
 */
describe("pillTone", () => {
  it("по умолчанию нейтрально; сегодня — жёлтая; просрочено — красная; хорошее — зелёная", () => {
    expect(pillTone("info")).toBe("neutral");
    expect(pillTone("today")).toBe("warn");
    expect(pillTone("overdue")).toBe("crit");
    expect(pillTone("good")).toBe("ok");
  });

  it("ноль, пусто и «нет числа» всегда спокойные — при любом смысле", () => {
    for (const meaning of ["overdue", "today", "good", "info"] as PillMeaning[]) {
      for (const empty of [0, -1, null, Number.NaN, Number.POSITIVE_INFINITY]) expect(pillTone(meaning, empty), `${meaning} ${String(empty)}`).toBe("neutral");
      expect(pillTone(meaning, 3), meaning).toBe(pillTone(meaning));
    }
  });

  it("балл разбора: хороший — зелёный, остальное (в том числе 0) спокойно, красного и жёлтого нет", () => {
    expect(scorePillTone(70)).toBe("ok");
    expect(scorePillTone(95)).toBe("ok");
    for (const score of [69, 45, 44, 10, 0, null, undefined]) expect(scorePillTone(score), String(score)).toBe("neutral");
  });

  it("слово важности из данных идёт через ту же функцию", () => {
    expect(pillToneOf("crit")).toBe("crit");
    expect(pillToneOf("warn")).toBe("warn");
    expect(pillToneOf("ok")).toBe("ok");
    for (const word of ["muted", "info", "neutral", null, undefined] as const) expect(pillToneOf(word)).toBe("neutral");
    expect(pillToneOf("crit", 0)).toBe("neutral");
  });

  it("чип действия клиента: «позвонить сейчас» спокойный (срок виден датой), остальные — сегодня, «никто не принял» — красный", () => {
    expect(clientActionPillTone({ id: "call-now", tone: "warn" })).toBe("neutral");
    expect(clientActionPillTone({ id: "reply", tone: "warn" })).toBe("warn");
    expect(clientActionPillTone({ id: "first-call", tone: "warn" })).toBe("warn");
    expect(clientActionPillTone({ id: "accept", tone: "warn" })).toBe("warn");
    expect(clientActionPillTone({ id: "accept", tone: "crit" })).toBe("crit");
    expect(clientActionPillTone({ id: "waiting", tone: "crit" })).toBe("crit");
  });
});

/**
 * Сторож К13: пилюли и метки нового вида красятся только функцией тона. Ловит буквальный тон на пилюле
 * (RoyalCallFlag, HomeChip, тег сделки), прямые красные/янтарные/зелёные классы Tailwind и `chip warn|crit|hot`
 * строкой в разметке нового вида. Проверен поломкой — второй тест ниже.
 */
function tsxFiles(dir: URL, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) tsxFiles(next, out);
    else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(fileURLToPath(next).replace(/\\/g, "/"));
  }
  return out;
}

type Leak = { rule: "literal-tone" | "literal-data-tone" | "tailwind-color" | "chip-class"; fragment: string };

/** Нарушения в одном тексте разметки. */
export function toneLeaks(source: string): Leak[] {
  const leaks: Leak[] = [];
  // Пилюля с буквальным тоном (строка или строка в фигурных скобках): тон обязан прийти из pillTone()/scorePillTone()/pillToneOf().
  for (const m of source.matchAll(/<(?:RoyalCallFlag|HomeChip)\b[^>]*?\btone=(?:"[^"]*"|\{\s*["'`][^"'`]*["'`]\s*\})/g)) leaks.push({ rule: "literal-tone", fragment: m[0].slice(0, 70) });
  // Тег, пилюля или метка с буквальным data-tone.
  for (const m of source.matchAll(/<span\b[^>]*\bclassName="[^"]*\b[\w-]*(?:tag|chip|pill|flag)\b[^"]*"[^>]*\bdata-tone="(?:crit|warn|ok)"/g)) leaks.push({ rule: "literal-data-tone", fragment: m[0].slice(0, 70) });
  for (const m of source.matchAll(/\b(?:bg|text|border|ring|fill|stroke|from|to|via)-(?:red|amber|yellow|orange|rose|green|emerald|lime|teal)-\d+/g)) leaks.push({ rule: "tailwind-color", fragment: m[0] });
  for (const m of source.matchAll(/className=\{?[`"'][^`"']*\bchip (?:warn|crit|hot)\b/g)) leaks.push({ rule: "chip-class", fragment: m[0].slice(0, 70) });
  return leaks;
}

describe("сторож: пилюли нового вида красятся только функцией тона", () => {
  const roots = [new URL("./", import.meta.url), new URL("../mobile/", import.meta.url), new URL("../../pages/", import.meta.url)];

  it("в components/look, mobile и pages нет буквального тона на пилюлях; в components/look ещё и цветных классов и chip warn", () => {
    const found: string[] = [];
    let scanned = 0;
    for (const dir of roots) {
      for (const file of tsxFiles(dir)) {
        scanned++;
        // Прежний вид (ветка без royal) красит `chip warn/crit` и цветные классы по-старому: правило про разметку нового вида.
        const inLook = file.includes("/components/look/");
        for (const leak of toneLeaks(readFileSync(file, "utf8"))) {
          if (!inLook && (leak.rule === "chip-class" || leak.rule === "tailwind-color")) continue;
          found.push(`${file.split("/src/")[1]}: ${leak.rule}: ${leak.fragment}`);
        }
      }
    }
    // Файлы найдены вовсе — иначе сторож молча ничего не проверял бы.
    expect(scanned).toBeGreaterThan(80);
    expect(found).toEqual([]);
  });

  it("сторож ловит буквальный тон, data-tone, цветной класс и chip warn (проверен поломкой)", () => {
    expect(toneLeaks('<RoyalCallFlag tone="crit">x</RoyalCallFlag>')).toHaveLength(1);
    expect(toneLeaks('<RoyalCallFlag tone={"warn"}>x</RoyalCallFlag>')).toHaveLength(1);
    expect(toneLeaks('<HomeChip tone="ok">x</HomeChip>')).toHaveLength(1);
    expect(toneLeaks('<span className="ry-deal-tag" data-tone="warn">x</span>')).toHaveLength(1);
    expect(toneLeaks('<b className="bg-red-500 text-white">x</b>')).toHaveLength(1);
    expect(toneLeaks('<span className="chip warn">x</span>')).toHaveLength(1);
    expect(toneLeaks('<span className={"chip crit xs"}>x</span>')).toHaveLength(1);
    // Тон из функции — чисто.
    expect(toneLeaks('<RoyalCallFlag tone={pillTone("today")}>x</RoyalCallFlag><HomeChip tone={pillToneOf(flag.tone)}>y</HomeChip>')).toEqual([]);
    expect(toneLeaks('<span className="ry-deal-tag" data-tone={pillTone("info")}>x</span>')).toEqual([]);
  });
});
