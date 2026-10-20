import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ГЛАВНЫЕ КНОПКИ СИНИЕ ВЕЗДЕ — ПК, ТЕЛЕФОН, МАСТЕР.
 *
 * Решение владельца 21.09.2026: акцент синий, никакого графита. `theme-2026-brand.css`
 * задаёт токен `--pill`/`--acc`, но три сгенерированных файла (собираются скриптами,
 * править их нельзя) переопределяют его СВОЕЙ же специфичностью на графит/чужой синий:
 *
 *   1. ПК: `theme-2026-proto.css:1340` `.rh2 .wrap .pill:not(.ghost), .rh2 .dsr
 *      .pill:not(.ghost), .rh2 .lf .pill:not(.ghost){background:var(--hover)}` —
 *      серые кнопки на пульте, в профиле и настройках.
 *   2. Телефон: `theme-2026-mobile-home.css:38,56` `.rh2 .mh{--pill:#15171a}` —
 *      графит побеждает `.rh2{--pill}`, потому что объявлен на более специфичном
 *      предке (`.mh`).
 *   3. Мастер: `theme-2026-wizard.css:34,50` `--acc:#0f62fe`/`#2f6bff` — свой синий,
 *      не акцент бренда `#1d5fe0`/`#3d7bff`.
 *
 * Найдено ночным аудитом 24.09.2026 (verify-1 №2, №3, №4). `theme-2026-brand.css`
 * подключается в `index.css` последним, поэтому при равной специфичности побеждает
 * он — но только если в нём объявлен ровно тот же селектор. Этот тест читает
 * исходник (jsdom тут не поднять, см. `noApiHrefs.test.ts`) и проверяет, что три
 * переопределения на месте; без починки — красный.
 */
const BRAND_CSS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../theme-2026-brand.css",
);

function readBrandCss(): string {
  return fs.readFileSync(BRAND_CSS, "utf8");
}

describe("theme-2026-brand.css — синие главные кнопки", () => {
  it("ПК: .wrap/.dsr/.lf .pill:not(.ghost) красится в --pill, не в --hover", () => {
    const css = readBrandCss();
    // Тот же селектор, что проигрывает в proto.css:1340 — иначе специфичность не совпадёт.
    expect(css).toMatch(
      /\.rh2 \.wrap \.pill:not\(\.ghost\),\s*\.rh2 \.dsr \.pill:not\(\.ghost\),\s*\.rh2 \.lf \.pill:not\(\.ghost\)\s*\{[^}]*background:\s*var\(--pill\)/,
    );
  });

  it("Телефон: .rh2 .mh переопределяет --pill акцентом бренда (день и ночь)", () => {
    const css = readBrandCss();
    // День: тот же предок .rh2 .mh, что в mobile-home.css:38.
    expect(css).toMatch(/\.rh2(?:,\s*\n?)?\s*\.rh2 \.mh\s*\{[^}]*--pill:\s*#1d5fe0/);
    // Ночь: тот же селектор с data-theme, что в mobile-home.css:56.
    expect(css).toMatch(
      /html\[data-theme="royal-home-2026-night"\][^{]*\.rh2 \.mh\s*\{[^}]*--pill:\s*#3d7bff/,
    );
  });

  it("Мастер: .rh2 .wiz переопределяет --acc акцентом бренда (день и ночь)", () => {
    const css = readBrandCss();
    expect(css).toMatch(/(?<!\.rh2 \.wiz \S*\s*)\.rh2 \.wiz\s*\{\s*--acc:\s*#1d5fe0/);
    expect(css).toMatch(
      /html\[data-theme="royal-home-2026-night"\]\s*\.rh2 \.wiz\s*\{\s*--acc:\s*#3d7bff/,
    );
  });

  it("Вход: .rh2 .scr .lgn .pill.gold красится акцентом бренда, не золотом (находка №265/Э1-4)", () => {
    const css = readBrandCss();
    // Тот же селектор, что проигрывает в proto.css:3711 — золотой градиент снят,
    // фон и текст идут через токены --pill/--pill-ink (акцент бренда, раздел 2).
    expect(css).toMatch(
      /\.rh2 \.scr \.lgn \.pill\.gold\s*\{[^}]*background-color:\s*var\(--pill\)[^}]*color:\s*var\(--pill-ink\)/,
    );
    // Наведение — через --pill-hover, тем же приёмом, что и золотой градиент в proto.css:3714.
    expect(css).toMatch(
      /\.rh2 \.scr \.lgn \.pill\.gold:hover\s*\{[^}]*background-color:\s*var\(--pill-hover\)/,
    );
  });
});
