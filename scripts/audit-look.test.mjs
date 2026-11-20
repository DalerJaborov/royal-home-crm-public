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
  const ok = `${R} { font-size: var(--rh-fs-md); font-size: .5em; border-radius: var(--rh-r-lg); border-radius: 50%; border-radius: 0;
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
