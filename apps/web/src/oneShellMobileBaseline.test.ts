import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ОДНА ОБОЛОЧКА: ПРЕЖНИЕ ТЕЛЕФОННЫЕ ЭКРАНЫ ТОЛЬКО УБЫВАЮТ (пачка B, 20.11.2026).
 *
 * Решение владельца 20.11: одна оболочка («Новый вид») для всех, старая тема и её
 * отдельные телефонные копии (`components/mobile/*`, `components/home/mh/*`)
 * удаляются. Агент на телефоне в новом виде их уже не видит (hooks/shellDevicePolicy.ts,
 * сторож — tests/e2e/one-shell.spec.ts), но остальные экраны ещё выбирают телефонную
 * копию по устройству. Пока они переносятся, этот сторож не даёт классу расти:
 *   — новый файл, который подключает телефонную копию, — красный;
 *   — новый файл в components/mobile или components/home/mh — красный;
 *   — файл из списка перестал их подключать — красный, пока его не вычеркнут
 *     (список только убывает, иначе он врёт).
 * Убрали копию насовсем — вычеркните строку здесь.
 */
const IMPORTERS_BASELINE = [
  "components/Topbar.tsx",
  "components/home/HomeHead.tsx",
  "components/home/TeamCharts.tsx",
  "components/pult/MorningBriefingCard.tsx",
  "pages/Calendar.tsx",
  "pages/Calls.tsx",
  "pages/ClientDetail.tsx",
  "pages/Clients.tsx",
  "pages/Dashboard.tsx",
  "pages/Deals.tsx",
  "pages/Finance.tsx",
  "pages/Funnel.tsx",
  "pages/Insights.tsx",
  "pages/Messages.tsx",
  "pages/More.tsx",
  "pages/Notifications.tsx",
  "pages/Profile.tsx",
  "pages/Properties.tsx",
  "pages/PropertyDetail.tsx",
];

const SRC = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_DIRS = ["components/mobile", "components/home/mh"];
const rel = (file: string) => path.relative(SRC, file).split(path.sep).join("/");
const isLegacy = (relPath: string) => LEGACY_DIRS.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`));
const isTest = (relPath: string) => /\.test\.tsx?$/.test(relPath) || relPath.includes("__tests__/");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** Файлы вне прежних папок (и не тесты), которые импортируют что-то из них — статически или `import()`. */
export function legacyImporters(files: { path: string; text: string }[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const own = rel(file.path);
    if (isLegacy(own) || isTest(own)) continue;
    for (const match of file.text.matchAll(/(?:from\s+|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = rel(path.resolve(path.dirname(file.path), match[1]));
      if (isLegacy(target)) found.add(own);
    }
  }
  return [...found].sort();
}

describe("одна оболочка: прежние телефонные экраны не прибавляются", () => {
  const files = walk(SRC).map((p) => ({ path: p, text: readFileSync(p, "utf8") }));

  it("список подключающих прежние телефонные копии только убывает", () => {
    expect(legacyImporters(files)).toEqual([...IMPORTERS_BASELINE].sort());
  });

  it("в прежних папках не появляются новые файлы", () => {
    const now = files.map((f) => rel(f.path)).filter((p) => isLegacy(p) && !isTest(p));
    // Число на 20.11.2026: components/mobile — 23 файла, components/home/mh — 7.
    expect(now.length, now.join("\n")).toBeLessThanOrEqual(30);
  });

  it("сторож проверен поломкой: новый подключающий файл виден", () => {
    const fake = { path: path.join(SRC, "pages", "NewScreen.tsx"), text: 'import { MobileX } from "../components/mobile/MobileX";\nconst H = lazy(() => import("../components/home/mh/MobileY"));' };
    const legacyInside = { path: path.join(SRC, "components", "mobile", "MobileZ.tsx"), text: 'import { A } from "./MobileX";' };
    expect(legacyImporters([...files, fake, legacyInside])).toContain("pages/NewScreen.tsx");
    expect(legacyImporters([fake, legacyInside])).toEqual(["pages/NewScreen.tsx"]);
  });
});
