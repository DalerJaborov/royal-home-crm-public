import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * НИЖНЕЕ МЕНЮ ТЕЛЕФОНА: СТЕКЛО, РАЗМЕР ПОДПИСЕЙ, ВЫСОТА (владелец 26.11.2026: «меню
 * мобильное серое… как стекло… либо буквы большие, либо оно больше»).
 *
 * Замер на стенде до правки (390×844, «Новый вид»): капсула — серая подложка
 * rgba(238,240,244,.86) с размытием без насыщенности, подписи 15 px (59 из 69 px
 * ячейки), выбранный раздел — белая таблетка на сером, низ капсулы на 12 px + safe-area
 * (на iPhone 46 px от края). Сторож держит итог, чтобы следующая правка темы молча не
 * вернула ни одно из четырёх.
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const royal = strip(readFileSync(new URL("./theme-look-royal.css", import.meta.url), "utf8"));
const shell = strip(readFileSync(new URL("./theme-2026-mobile-shell.css", import.meta.url), "utf8"));

const NAV = ':root[data-ui-look="royal"][data-mobile-ux] nav[data-bottomnav]';
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Тела всех правил с ровно этим селектором (в любом @media/@supports). */
function bodiesOf(css: string, selector: string): string[] {
  return [...css.matchAll(new RegExp(`(?:^|[}\\s])${esc(selector)}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
}
/** Значение токена в первом блоке, где он объявлен после `marker`. */
function tokenAfter(css: string, marker: string, name: string): string | undefined {
  const at = css.indexOf(marker);
  return new RegExp(`${esc(name)}\\s*:\\s*([^;]+);`).exec(css.slice(at))?.[1].trim();
}

describe("нижнее меню телефона: стекло, а не серая капсула", () => {
  it("подложка — белое (днём) стекло 72–85 %, ночью тёмное, а не серое #eef0f4", () => {
    const day = tokenAfter(royal, ':root[data-ui-look="royal"] {', "--rh-ui-nav-bg");
    const night = tokenAfter(royal, ':root[data-ui-look="royal"][data-theme="royal-home-2026-night"]', "--rh-ui-nav-bg");
    const alpha = (v?: string) => Number(/rgba\([^)]*,\s*([0-9.]+)\)/.exec(v ?? "")?.[1]);
    expect(day).toMatch(/^rgba\(255,\s*255,\s*255,/);
    expect(alpha(day)).toBeGreaterThanOrEqual(0.72);
    expect(alpha(day)).toBeLessThanOrEqual(0.85);
    expect(night).toMatch(/^rgba\((\d+),\s*(\d+),\s*(\d+),/);
    expect(alpha(night)).toBeGreaterThanOrEqual(0.7);
  });

  it("капсула берёт свои токены --rh-ui-nav-*, размытие ≥ 20 px с насыщенностью", () => {
    const all = bodiesOf(royal, NAV).join("\n");
    expect(all).toMatch(/background:\s*var\(--rh-ui-nav-bg\)/);
    expect(all).not.toMatch(/--rh-ui-cap-(bg|solid|pill)\b/);
    const filter = /(?:^|;)\s*backdrop-filter:\s*blur\((\d+)px\)\s*saturate\((\d+)%\)/.exec(all);
    expect(filter, "backdrop-filter: blur(..) saturate(..)").not.toBeNull();
    expect(Number(filter![1])).toBeGreaterThanOrEqual(20);
    expect(Number(filter![2])).toBeGreaterThanOrEqual(140);
  });

  // 27.11.2026 (пачка shell2): «нижнее меню как в макете» — выбранный раздел белой таблеткой с чёрным
  // залитым значком (прежняя синяя таблетка 26.11 снята заданием владельца). Таблетка отличима от
  // капсулы тенью; без стекла капсула светло-серая, а не белая — белая таблетка на ней видна сама.
  it("выбранный раздел — белой таблеткой с чёрным значком и тенью; без стекла капсула не белая", () => {
    const active = bodiesOf(royal, `${NAV} .sh-tab[aria-current="page"]`).join("\n");
    expect(active).toMatch(/background:\s*var\(--rh-ui-nav-on\)/);
    expect(active).toMatch(/color:\s*var\(--rh-ui-nav-on-fg\)/);
    expect(active).toMatch(/box-shadow:\s*var\(--rh-ui-nav-on-shadow\)/);
    expect(tokenAfter(royal, ':root[data-ui-look="royal"] {', "--rh-ui-nav-on")).toBe("#ffffff");
    expect(tokenAfter(royal, ':root[data-ui-look="royal"] {', "--rh-ui-nav-on-fg")).toBe("#0e0f12");
    expect(tokenAfter(royal, ':root[data-ui-look="royal"] {', "--rh-ui-nav-solid")).not.toBe("#ffffff");
  });

  it("меню отвечает сразу: без перехода, анимации и отклика нажатием (макет)", () => {
    const tab = bodiesOf(royal, `${NAV} .sh-tab`).join("\n");
    expect(tab).toMatch(/transition:\s*none/);
    expect(tab).toMatch(/animation:\s*none/);
    expect(bodiesOf(royal, `${NAV} .sh-tab:active`).join("\n")).toMatch(/transform:\s*none/);
  });

  it("тумблер «Эффект стекла» гасит стекло капсулы", () => {
    const off = bodiesOf(royal, ':root[data-ui-look="royal"][data-mobile-ux].fx-no-glass nav[data-bottomnav]').join("\n");
    expect(off).toMatch(/backdrop-filter:\s*none/);
    expect(off).toMatch(/background:\s*var\(--rh-ui-nav-solid\)/);
  });
});

describe("нижнее меню телефона: подписи и высота", () => {
  it("подпись вкладки — 13 px на любой ширине телефона, без подъёма до 15", () => {
    expect(bodiesOf(royal, `${NAV} [data-tab-label]`).join("\n")).toMatch(/font-size:\s*var\(--rh-fs-xs\)/);
    expect(tokenAfter(royal, ':root[data-ui-look="royal"] {', "--rh-fs-xs-base")).toBe("13px");
    // Никакое правило подписи телефонного меню не берёт шаг крупнее (--rh-fs-sm = 15 px на телефоне).
    const labelRules = [...royal.matchAll(/([^{}]*nav\[data-bottomnav\][^{}]*\[data-tab-label\][^{}]*)\{([^}]*)\}/g)]
      .filter((m) => !/768px|1023/.test(m[1]));
    for (const [, sel, body] of labelRules) expect(body, sel.trim()).not.toMatch(/font-size:\s*var\(--rh-fs-(sm|md|lg)\)/);
  });

  it("капсула 56 + 4 + 4 и низ — общей переменной, а не «12 px + safe-area»", () => {
    expect(bodiesOf(royal, `${NAV} > .grid`).join("\n")).toMatch(/height:\s*56px/);
    const nav = bodiesOf(royal, NAV).join("\n");
    expect(nav).toMatch(/bottom:\s*var\(--rh-nav-bottom\)/);
    expect(nav).not.toMatch(/bottom:\s*calc\(12px \+ env\(safe-area-inset-bottom/);
    const root = bodiesOf(royal, ':root[data-ui-look="royal"][data-mobile-ux]').join("\n");
    expect(root).toMatch(/--rh-nav-bottom:\s*max\(10px,\s*calc\(env\(safe-area-inset-bottom,\s*0px\)\s*-\s*10px\)\)/);
    expect(root).toMatch(/--rh-nav-h:\s*calc\(64px \+ var\(--rh-nav-bottom\)\)/);
  });
});

describe("кнопка «+»: дорожка кольца только при удержании", () => {
  it("в покое дорожка прозрачная, при удержании — видна; дуга остаётся белой", () => {
    expect(bodiesOf(shell, "nav[data-bottomnav] [data-fab] > [data-fab-ring] circle").join("\n")).toMatch(/stroke:\s*transparent/);
    expect(bodiesOf(shell, 'nav[data-bottomnav] [data-fab][data-holding="true"] > [data-fab-ring] circle:first-child').join("\n"))
      .toMatch(/stroke:\s*rgba\(255,\s*255,\s*255,/);
    expect(bodiesOf(shell, "nav[data-bottomnav] [data-fab] > [data-fab-ring] circle + circle").join("\n")).toMatch(/stroke:\s*#fff/);
  });

  it("на лаймовой «+» «Нового вида» дуга цвета значка, а не белая (белая на лайме не видна)", () => {
    expect(bodiesOf(royal, ':root[data-ui-look="royal"] nav[data-bottomnav] [data-fab] > [data-fab-ring] circle + circle').join("\n"))
      .toMatch(/stroke:\s*var\(--rh-ui-tile-fg\)/);
    expect(bodiesOf(royal, ':root[data-ui-look="royal"] nav[data-bottomnav] [data-fab][data-holding="true"] > [data-fab-ring] circle:first-child').join("\n"))
      .toMatch(/stroke:\s*var\(--rh-ui-tile-track\)/);
  });
});
