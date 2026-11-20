// Сторож сторожа: audit-look обязан краснеть на каждой поломке, которую ловит (правило 29.09.2026:
// новый сторож проверяется внесением поломки). Запуск: node --test scripts/audit-look.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { blurredShadowLayer, compare, countKeys, cssFindings, shrink, tsxFindings } from "./audit-look.mjs";

const R = ':root[data-ui-look="royal"] [data-ry-section="x"] .a';
const kinds = (css, o) => cssFindings(css, o).map((f) => f.kind).sort();

test("литералы вне токенов ловятся по каждому виду", () => {
  assert.deepEqual(kinds(`${R} { font-size: 19px; }`), ["font-size"]);
  assert.deepEqual(kinds(`${R} { font-size: clamp(13px, 11cqi, 40px); }`), ["font-size"]);
  assert.deepEqual(kinds(`${R} { border-radius: 11px; }`), ["radius"]);
  assert.deepEqual(kinds(`${R} { border-top-left-radius: 32%; }`), ["radius"]);
  assert.deepEqual(kinds(`${R} { color: #123456; }`), ["color"]);
  assert.deepEqual(kinds(`${R} { background: rgba(0, 0, 0, .4); }`), ["color"]);
  assert.deepEqual(kinds(`${R} { box-shadow: 0 4px 10px var(--rh-ui-sep); }`), ["shadow"]);
  assert.deepEqual(kinds(`@media (max-width: 640px) { ${R} { color: var(--rh-ui-text); } }`), ["media"]);
  assert.deepEqual(kinds(`@media (min-width: 1180px) { ${R} { color: var(--rh-ui-text); } }`), ["media"]);
  assert.deepEqual(kinds(`@media (max-width: 768px) { ${R} { color: var(--rh-ui-text); } }`), ["media"]);
});

test("токены, круг, линия-обводка и маска — не нарушения", () => {
  const ok = `${R} { font-size: var(--rh-fs-md); border-radius: var(--rh-r-lg); border-radius: 50%; border-radius: 0;
    box-shadow: var(--rh-ui-shadow), 0 0 0 1px var(--rh-ui-ring); box-shadow: inset 0 -1px 0 var(--rh-ui-sep); box-shadow: none !important;
    color: color-mix(in srgb, var(--rh-ui-crit) 86%, var(--rh-ui-mix-dark)); mask-image: linear-gradient(90deg, #000 80%, transparent); }
    @media (max-width: 767.98px) and (min-width: 390px) { ${R} { color: var(--rh-ui-text); } }
    @media (prefers-reduced-motion: reduce) { ${R} { transition: none; } }`;
  assert.deepEqual(cssFindings(ok), []);
});

test("свой цвет-переменная в слое экрана — нарушение, в файле токенов — нет", () => {
  const css = `${R} { --ry-green: #0b7a41; }`;
  assert.deepEqual(kinds(css), ["color"]);
  assert.deepEqual(cssFindings(css, { tokenFile: true }), []);
  // Но в файле токенов правило (не объявление переменной) тоже проверяется.
  assert.deepEqual(kinds(`${R} { color: #fff; }`, { tokenFile: true }), ["color"]);
});

test("тень: слой с размытием числом — да, линия без размытия — нет", () => {
  assert.equal(blurredShadowLayer("0 2px 8px rgba(0,0,0,.2)"), true);
  assert.equal(blurredShadowLayer("inset 0 0 0 2px color-mix(in srgb, var(--rh-ui-warn) 35%, transparent)"), false);
  assert.equal(blurredShadowLayer("var(--rh-ui-shadow-lg)"), false);
  assert.equal(blurredShadowLayer("0 0 0 3px var(--rh-ui-primary)"), false);
});

test("номер строки указывает на объявление", () => {
  const f = cssFindings(`${R} {\n  color: var(--rh-ui-text);\n  font-size: 19px;\n}`);
  assert.equal(f[0].line, 3);
});

test("встроенные стили деталей (TSX)", () => {
  assert.equal(tsxFindings(`<b style={{ fontSize: 12 }} />`).length, 1);
  assert.equal(tsxFindings(`<b style={{ color: "#ff0000" }} />`).length, 1);
  assert.equal(tsxFindings(`<b style={{ boxShadow: "0 1px 2px red" }} />`).length, 1);
  assert.equal(tsxFindings(`// ревью #285\n<b style={{ fontSize: "var(--rh-fs-sm)" }} />`).length, 0);
});

test("база: новое и выросшее валит, меньшее — подсказка, без причины — ошибка", () => {
  const files = { "a.css": cssFindings(`${R} { color: #111; color: #111; font-size: 19px; }`) };
  const base = { files: { "a.css": { reason: "ветка X", counts: { "color #111": 2 } } } };
  const r1 = compare(files, base);
  assert.equal(r1.errors.length, 1); // font-size не в базе
  assert.match(r1.errors[0], /font-size/);
  const grown = { "a.css": cssFindings(`${R} { color: #111; color: #111; color: #111; }`) };
  assert.equal(compare(grown, base).errors.length, 1);
  const fewer = { "a.css": cssFindings(`${R} { color: #111; }`) };
  const r3 = compare(fewer, base);
  assert.equal(r3.errors.length, 0);
  assert.equal(r3.shrinkable.length, 1);
  assert.equal(compare(fewer, { files: { "a.css": { reason: " ", counts: {} } } }).badBase.length, 1);
});

test("сжатие базы только уменьшает", () => {
  const base = { files: { "a.css": { reason: "r", counts: { "color #111": 2, "color #222": 1 } } } };
  const files = { "a.css": cssFindings(`${R} { color: #111; color: #333; color: #333; }`) };
  const next = shrink(files, base);
  assert.deepEqual(next.files["a.css"].counts, { "color #111": 1 });
  assert.deepEqual(countKeys(files["a.css"]), { "color #111": 1, "color #333": 2 });
});

/* ───── обходы, найденные ревью #337: каждый обязан краснеть ───── */
import { baselineGrowth, badShadowLayer, commitsDeclareGrowth, shadowTokensOf } from "./audit-look.mjs";

test("шрифт: своя переменная, em/%/vw, слова, calc — всё мимо шкалы", () => {
  for (const v of ["var(--x)", ".62em", "120%", "4vw", "small", "larger", "calc(var(--rh-fs-md) + 1px)", "max(1em, var(--rh-fs-sm))", "var(--rh-fs-md-base)"]) {
    assert.deepEqual(kinds(`${R} { font-size: ${v}; }`), ["font-size"], v);
  }
  assert.deepEqual(kinds(`${R} { font: 600 11px/1.2 Onest; }`), ["font-size"]);
  assert.deepEqual(cssFindings(`${R} { font-size: var(--rh-fs-lg) !important; font: inherit; }`), []);
});

test("скругление: своя переменная и посторонние единицы", () => {
  assert.deepEqual(kinds(`${R} { border-radius: var(--x); }`), ["radius"]);
  assert.deepEqual(kinds(`${R} { border-radius: 1em; }`), ["radius"]);
  assert.deepEqual(cssFindings(`${R} { border-radius: var(--rh-r-lg) var(--rh-r-lg) 0 0; }`), []);
});

test("цвет словом, hsl(), color()", () => {
  for (const v of ["red", "White", "rebeccapurple", "hsl(0 0% 100%)", "color(srgb 1 0 0)"]) assert.deepEqual(kinds(`${R} { color: ${v}; }`), ["color"], v);
  assert.deepEqual(cssFindings(`${R} { color: currentColor; background: transparent; content: "red"; white-space: normal; }`), []);
});

test("тень: text-shadow, drop-shadow, своя переменная, чужая «тень»", () => {
  const tokens = shadowTokensOf(":root { --rh-ui-shadow: 0 1px 2px #000; --rh-ui-shadow-lg: none; }");
  const k = (css) => cssFindings(css, { shadowTokens: tokens }).map((f) => f.kind);
  assert.deepEqual(k(`${R} { text-shadow: 0 1px 2px var(--rh-ui-sep); }`), ["shadow"]);
  assert.deepEqual(k(`${R} { filter: drop-shadow(0 2px 4px var(--rh-ui-sep)); }`), ["shadow"]);
  assert.deepEqual(k(`${R} { box-shadow: var(--my-glow); }`), ["shadow"]);
  assert.deepEqual(k(`${R} { box-shadow: var(--fake-shadow); }`), ["shadow"]);
  assert.deepEqual(k(`${R} { box-shadow: var(--rh-ui-shadow-lg), 0 0 0 1px var(--rh-ui-ring); }`), []);
  assert.equal(badShadowLayer("var(--rh-ui-shadow)", tokens), false);
});

test("@media: запись диапазоном и em — мимо списка", () => {
  for (const q of ["(900px <= width)", "(width >= 768px)", "(min-width: 48em)", "(max-width: 767px)", "(768px <= width <= 1023.98px)"]) {
    assert.deepEqual(kinds(`@media ${q} { ${R} { color: var(--rh-ui-text); } }`), ["media"], q);
  }
});

test("TSX: tailwind с числом, text-xs, стиль на нескольких строках, hsl", () => {
  assert.equal(tsxFindings(`<b className="text-[11px]" />`).length, 1);
  assert.equal(tsxFindings(`<b className="bg-[#fff] p-2" />`).length, 2); // и цвет, и произвольное значение
  assert.equal(tsxFindings(`<b className="rounded-[3px]" />`).length, 1);
  assert.equal(tsxFindings(`<b className="md:text-xs" />`).length, 1);
  assert.equal(tsxFindings(`<b style={{\n  color: "hsl(0 0% 100%)",\n}} />`).length, 1);
  assert.equal(tsxFindings(`<b style={{\n  fontSize:\n    14,\n}} />`).length, 1);
  assert.equal(tsxFindings(`<b style={{ borderRadius: "var(--rh-r-md)", fontSize: "var(--rh-fs-sm)" }} className="bg-[var(--rh-ui-card)]" />`).length, 0);
});

test("база против main: новый ключ и рост — красное, сжатие — нет; объявление вслух", () => {
  const main = { files: { "a.css": { reason: "r", counts: { "color #111": 2 } } } };
  assert.deepEqual(baselineGrowth({ files: { "a.css": { reason: "r", counts: { "color #111": 1 } } } }, main), []);
  assert.equal(baselineGrowth({ files: { "a.css": { reason: "r", counts: { "color #111": 3 } } } }, main).length, 1);
  assert.equal(baselineGrowth({ files: { "a.css": { reason: "r", counts: { "color #222": 1 } } } }, main).length, 1);
  assert.equal(baselineGrowth({ files: { "b.css": { reason: "r", counts: { "color #111": 1 } } } }, { files: {} }).length, 1);
  assert.equal(commitsDeclareGrowth("feat: x\n\nLook-Audit-Base-Growth: первая база\n"), true);
  assert.equal(commitsDeclareGrowth("Look-Audit-Base-Growth:   \n"), false);
});
