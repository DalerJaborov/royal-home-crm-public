import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Сторож клавиатуры (аудит К07, 21.11.2026): клавиатуру считает ОДНО место (lib/keyboardInset.ts), а шторки
 * поднимает над ней ОДНО правило (theme-2026-mobile-shell.css, п. 8). Шторка со своим `bottom:` или своим
 * чтением visualViewport возвращает ровно ту поломку, из-за которой 89 шторок не знали о клавиатуре.
 */
const SRC = join(__dirname, "..", "..");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? (name === "__tests__" || name === "node_modules" ? [] : walk(p)) : [p];
  });
const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");

/** Файлы, которым читать visualViewport разрешено, и причина. */
const VIEWPORT_READERS: Record<string, string> = {
  "lib/keyboardInset.ts": "общий расчёт клавиатуры",
  "hooks/useScrollLock.ts": "расхождение низа экрана и layout viewport (--rh-vv-over)",
  "hooks/useCleanViewport.ts": "высота и верх переписки нового вида при клавиатуре",
  "hooks/useRevealFocusedField.ts": "прокрутка поля в фокусе после появления клавиатуры",
  "components/mobile/MobileChatView.tsx": "композер полноэкранной переписки (старый вид)",
  "pages/UiCheck.tsx": "страница проверки на телефоне, только показывает числа",
};

/** Файлы стилей, где у шторки разрешён собственный `bottom:` и чтение `--rh-kb-inset`. */
const SHEET_BOTTOM_OWNERS = new Set(["theme-2026-proto.css", "theme-2026-mobile-shell.css", "theme-2026-assistant-panel.css", "theme-2026-mobile-home.css"]);
const KB_VAR_OWNERS = new Set(["theme-2026-mobile-shell.css", "theme-2026-assistant-panel.css"]);

export function sheetBottomRules(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: string[] = [];
  for (const m of clean.matchAll(/([^{}@][^{}]*)\{([^{}]*)\}/g)) {
    if (/\.sheet(?![\w-])/.test(m[1]) && /(^|[;\s])bottom\s*:/.test(m[2])) out.push(m[1].trim());
  }
  return out;
}

describe("клавиатура: одно место расчёта, одно правило подъёма", () => {
  it("visualViewport читают только перечисленные файлы", () => {
    const offenders = walk(SRC)
      .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p))
      .filter((p) => readFileSync(p, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").includes("visualViewport"))
      .map(rel)
      .filter((f) => !(f in VIEWPORT_READERS));
    expect(offenders, "клавиатуру считает lib/keyboardInset.ts: зови useKeyboardInset, а не visualViewport").toEqual([]);
  });

  it("у шторки свой `bottom:` задают только слои, перечисленные в сторожe", () => {
    const offenders = walk(SRC)
      .filter((p) => p.endsWith(".css"))
      .filter((p) => !SHEET_BOTTOM_OWNERS.has(rel(p)))
      .flatMap((p) => sheetBottomRules(readFileSync(p, "utf8")).map((sel) => `${rel(p)}: ${sel}`));
    expect(offenders, "подъём шторки над клавиатурой — п. 8 theme-2026-mobile-shell.css, свой bottom не нужен").toEqual([]);
  });

  it("`--rh-kb-inset` читают только оболочка и панель ассистента", () => {
    const offenders = walk(SRC)
      .filter((p) => p.endsWith(".css") && !KB_VAR_OWNERS.has(rel(p)))
      .filter((p) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").includes("--rh-kb-inset"))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("`--rh-kb-inset` не пишут и не читают из TSX (инлайн-стиль в обход правила шторки)", () => {
    const offenders = walk(SRC)
      .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p) && rel(p) !== "lib/keyboardInset.ts")
      .filter((p) => readFileSync(p, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").includes("--rh-kb-inset"))
      .map(rel);
    expect(offenders, "переменную ставит только lib/keyboardInset.ts, читает только CSS слоя шторки").toEqual([]);
  });

  it("высота 62% — только у шторок-форм: правило требует data-form, а Rh2Sheet его ставит при подвале или отправке", () => {
    const shell = readFileSync(join(SRC, "theme-2026-mobile-shell.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...shell.matchAll(/([^{}]+)\{([^{}]*62dvh[^{}]*)\}/g)].map((m) => m[1].trim());
    expect(rules.length).toBeGreaterThan(0);
    for (const sel of rules) expect(sel, "62% без [data-form] растянет короткие меню").toContain("[data-form]");
    expect(readFileSync(join(SRC, "components/rh2/Rh2Sheet.tsx"), "utf8")).toMatch(/data-form=\{onSubmit \|\| footer/);
  });

  it("сторож проверен поломкой: шторка со своим bottom ловится, подвал и padding — нет", () => {
    expect(sheetBottomRules(".rh2 .sheet.bottom { bottom: 0; }")).toEqual([".rh2 .sheet.bottom"]);
    expect(sheetBottomRules(".rh2 .sheet-f { bottom: 0; } .rh2 .sheet.bottom { padding-bottom: 8px; }")).toEqual([]);
  });

  it("шторка и оболочка действительно подписаны на клавиатуру", () => {
    expect(readFileSync(join(SRC, "components/rh2/Rh2Sheet.tsx"), "utf8")).toContain("useKeyboardInset(");
    expect(readFileSync(join(SRC, "layouts/AppLayout.tsx"), "utf8")).toContain("useKeyboardInset(");
    const shell = readFileSync(join(SRC, "theme-2026-mobile-shell.css"), "utf8");
    expect(shell).toMatch(/html\[data-kb-open\] nav\[data-bottomnav\]\s*\{\s*display:\s*none/);
    expect(shell).toMatch(/\.sheet\.bottom\s*\{[^}]*bottom:\s*var\(--rh-kb-inset/);
  });
});
