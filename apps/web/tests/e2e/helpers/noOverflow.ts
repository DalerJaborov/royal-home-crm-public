import { expect, type Page } from "@playwright/test";

/**
 * СТОРОЖ ШИРИНЫ «НОВОГО ВИДА» — общий помощник для всех пачек (18.11.2026).
 *
 * Почему мало `scrollWidth` страницы. Рамка чистой оболочки (`.clean-frame`)
 * прокручивается сама (overflow:auto), карточки режут лишнее (overflow:hidden),
 * поэтому кнопка, уехавшая за край, НЕ даёт горизонтальной прокрутки документа —
 * её просто не видно. Так выглядела ошибка макета с третьей кнопкой карточки
 * клиента, и прежний сторож её пропускал (проверено поломкой в пачке clients).
 *
 * Здесь каждый проверяемый элемент сверяется с окном И с краем каждого предка,
 * который режет или прокручивает содержимое. Не вылет — только задуманные ленты с
 * собственной прокруткой (вкладки, ряды фильтров): их перечисляет `strips`.
 */
export const DEFAULT_STRIPS = ".ry-ctabs, .rh-filters-scroll";

/** Элементы `selector`, правый край которых за окном или за краем режущего/прокручиваемого предка. */
export async function overflowingElements(page: Page, selector: string, strips: string = DEFAULT_STRIPS): Promise<string[]> {
  return page.evaluate(([sel, stripSel]) => [...document.querySelectorAll(sel)].filter((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) return false;
    if (stripSel && node.parentElement?.closest(stripSel)) return false;
    let limit = window.innerWidth;
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX === "visible") continue;
      // Задуманная обрезка текста многоточием (строка или несколько строк) — не вылет.
      if (style.textOverflow === "ellipsis" || (style.webkitLineClamp && style.webkitLineClamp !== "none")) return false;
      limit = Math.min(limit, p.getBoundingClientRect().right);
    }
    return rect.right > limit + 1;
  }).map((node) => `${node.tagName.toLowerCase()}.${String((node as HTMLElement).className).slice(0, 40)}`), [selector, strips] as const);
}

/** На ширине `width`: нет прокрутки документа и ни один элемент `selector` не вылез (см. выше). */
export async function expectNoOverflowAt(page: Page, width: number, selector: string, opts: { height?: number; strips?: string } = {}) {
  await page.setViewportSize({ width, height: opts.height ?? 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { message: `горизонтальная прокрутка на ${width}px` }).toBeLessThanOrEqual(0);
  expect(await overflowingElements(page, selector, opts.strips), `элементы шире окна или обрезаны краем на ${width}px`).toEqual([]);
}

/** Ширины, на которых новый вид обязан держаться (бриф переноса, п.5). */
export const LOOK_WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];
