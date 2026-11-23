import { expect, type Page } from "@playwright/test";
import { LOOK_TRUNCATE_OK } from "./lookTruncation";

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
 *
 * Многоточие (хвост ревью #285/#286, 19.11.2026). Прежде любой предок с
 * `text-overflow: ellipsis` или `line-clamp` снимал проверку целиком — и обрезанная
 * сумма, статус или причина проходили зелёными. Теперь обрезка многоточием — тоже
 * находка, кроме перечисленного в `LOOK_TRUNCATE_OK` (имена людей в списках;
 * `lookTruncation.ts`, тот же список сверяет сторож слоёв).
 */
export const DEFAULT_STRIPS = ".ry-ctabs, .rh-filters-scroll";
export const DEFAULT_TRUNCATE_OK = LOOK_TRUNCATE_OK.join(", ");

/** Элементы `selector`, правый край которых за окном или за краем режущего/прокручиваемого предка. */
export async function overflowingElements(page: Page, selector: string, strips: string = DEFAULT_STRIPS, truncateOk: string = DEFAULT_TRUNCATE_OK): Promise<string[]> {
  return page.evaluate(([sel, stripSel, okSel]) => [...document.querySelectorAll(sel)].filter((node) => {
    const rect = node.getBoundingClientRect();
    if (rect.width === 0) return false;
    if (stripSel && node.parentElement?.closest(stripSel)) return false;
    let limit = window.innerWidth;
    for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
      const style = getComputedStyle(p);
      if (style.overflowX === "visible") continue;
      // Многоточие у имени человека в списке — задумано; у любого другого текста его
      // ловит truncatedTexts, а здесь предок считается обычным режущим краем.
      const ellipsis = style.textOverflow === "ellipsis" || (style.webkitLineClamp && style.webkitLineClamp !== "none");
      if (ellipsis && okSel && p.matches(okSel)) return false;
      limit = Math.min(limit, p.getBoundingClientRect().right);
    }
    return rect.right > limit + 1;
  }).map((node) => `${node.tagName.toLowerCase()}.${String((node as HTMLElement).className).slice(0, 40)}`), [selector, strips, truncateOk] as const);
}

/**
 * Тексты внутри `root`, РЕАЛЬНО обрезанные многоточием (`text-overflow: ellipsis` при
 * режущем `overflow` и содержимом шире коробки) или зажимом строк (`line-clamp` при
 * содержимом выше коробки), кроме `truncateOk`. Многоточие, которое сейчас не сработало
 * (текст влез), — не находка: проверка идёт на каждой ширине из `LOOK_WIDTHS`.
 */
export async function truncatedTexts(page: Page, root: string = "body", truncateOk: string = DEFAULT_TRUNCATE_OK): Promise<string[]> {
  return page.evaluate(([rootSel, okSel]) => {
    const found: string[] = [];
    for (const top of document.querySelectorAll(rootSel)) for (const node of [top, ...top.querySelectorAll("*")]) {
      if (!(node instanceof HTMLElement) || !node.textContent?.trim()) continue;
      const style = getComputedStyle(node);
      const clamp = !!style.webkitLineClamp && style.webkitLineClamp !== "none";
      const ellipsis = style.textOverflow === "ellipsis" && style.overflowX !== "visible";
      if (!clamp && !ellipsis) continue;
      if (node.getClientRects().length === 0 || style.visibility === "hidden") continue;
      const cut = (ellipsis && node.scrollWidth > node.clientWidth + 1) || (clamp && node.scrollHeight > node.clientHeight + 1);
      if (!cut || (okSel && node.matches(okSel))) continue;
      found.push(`${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)} «${node.textContent.trim().slice(0, 30)}»`);
    }
    return found;
  }, [root, truncateOk] as const);
}

/**
 * На ширине `width`: нет прокрутки документа, ни один элемент `selector` не вылез и ни
 * один текст внутри `textRoot` (по умолчанию — вся страница) не обрезан многоточием,
 * кроме `truncateOk` (см. выше).
 */
export async function expectNoOverflowAt(page: Page, width: number, selector: string, opts: { height?: number; strips?: string; truncateOk?: string; textRoot?: string } = {}) {
  await page.setViewportSize({ width, height: opts.height ?? 900 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    { message: `горизонтальная прокрутка на ${width}px` }).toBeLessThanOrEqual(0);
  expect(await overflowingElements(page, selector, opts.strips, opts.truncateOk), `элементы шире окна или обрезаны краем на ${width}px`).toEqual([]);
  expect(await truncatedTexts(page, opts.textRoot, opts.truncateOk), `текст с данными обрезан многоточием на ${width}px`).toEqual([]);
}

/** Ширины, на которых новый вид обязан держаться (бриф переноса, п.5). */
export const LOOK_WIDTHS = [320, 360, 390, 430, 768, 1024, 1280, 1440, 1920];
