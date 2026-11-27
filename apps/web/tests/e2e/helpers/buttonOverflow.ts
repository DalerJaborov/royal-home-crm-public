import type { Page } from "@playwright/test";

/**
 * СТОРОЖ «ТЕКСТ ВЫХОДИТ ИЗ КНОПКИ» (27.11.2026, жалоба владельца «по всему CRM текст
 * выходит из кнопок»).
 *
 * `noOverflow.ts` проверяет, что элемент не вылез за край окна или предка. Здесь другой
 * вопрос: помещается ли ПОДПИСЬ в самой кнопке. Подпись выходит из кнопки, когда у кнопки
 * фиксированная высота или ширина, а текст по-русски и по-таджикски длиннее задуманного,
 * и ни `scrollWidth` страницы, ни край окна этого не показывают: страница не
 * прокручивается, вылез только хвост слова за рамку кнопки.
 *
 * Берём: `button`, `[role=button]`, `[role=tab]`, `a.pill`, `.chip`, `.pill`, `.seg > *`,
 * ссылки-кнопки (`a[class*="btn"]`). Находка, если
 *  - содержимое шире или выше коробки (`scrollWidth/scrollHeight` больше `client*` больше
 *    чем на 1px), а кнопка не задумана обрезающей многоточием;
 *  - прямоугольник текстового узла или значка внутри выходит за прямоугольник кнопки.
 * Многоточие (`text-overflow: ellipsis`) — осознанная обрезка длинной подписи; её ищет
 * `truncatedTexts` из `noOverflow.ts`, здесь она не находка.
 */
export const BUTTON_SELECTOR = [
  "button", "[role=button]", "[role=tab]", "a.pill", ".chip", ".pill", ".seg > *", "a[class*=btn]", "label.pill", "label.chip",
].join(", ");

export type ButtonOverflow = { kind: "scroll" | "child"; label: string; box: string; detail: string };

export async function overflowingButtons(page: Page, selector: string = BUTTON_SELECTOR): Promise<ButtonOverflow[]> {
  return page.evaluate((sel) => {
    const out: { kind: "scroll" | "child"; label: string; box: string; detail: string }[] = [];
    const seen = new Set<Element>();
    for (const node of document.querySelectorAll(sel)) {
      if (!(node instanceof HTMLElement) || seen.has(node)) continue;
      seen.add(node);
      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || style.display === "contents") continue;
      // скрытый предком (свёрнутый блок, шторка) — человеку не показан
      if (node.closest("[hidden], [aria-hidden=true], [inert]")) continue;
      const label = (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || (node.getAttribute("aria-label") ?? "").slice(0, 40);
      const box = `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 50)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
      const ellipsis = style.textOverflow === "ellipsis" || (style.webkitLineClamp && style.webkitLineClamp !== "none");
      // `scrollWidth` считает и выступающие значки-метки (точка уведомления у иконки): они не
      // «текст из кнопки». Содержимое, выступающее при `overflow: visible`, ловит проверка
      // прямоугольников ниже; здесь — только то, что рамка кнопки РЕЖЕТ.
      const clips = style.overflowX !== "visible" || style.overflowY !== "visible";
      if (!ellipsis && clips) {
        const dx = node.scrollWidth - node.clientWidth;
        const dy = node.scrollHeight - node.clientHeight;
        if (dx > 1 || dy > 1) { out.push({ kind: "scroll", label, box, detail: `scroll +${dx}x${dy}` }); continue; }
      }
      let bad = "";
      const check = (r: DOMRect, what: string) => {
        if (bad || r.width === 0 || r.height === 0) return;
        if (r.right > rect.right + 1.5 || r.left < rect.left - 1.5 || r.bottom > rect.bottom + 1.5 || r.top < rect.top - 1.5) {
          bad = `${what} [${Math.round(r.left - rect.left)},${Math.round(r.top - rect.top)}..${Math.round(r.right - rect.left)},${Math.round(r.bottom - rect.top)}] в ${Math.round(rect.width)}x${Math.round(rect.height)}`;
        }
      };
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t && !bad; t = walker.nextNode()) {
        if (!t.textContent?.trim()) continue;
        const parentStyle = t.parentElement ? getComputedStyle(t.parentElement) : null;
        if (parentStyle && (parentStyle.textOverflow === "ellipsis" || parentStyle.position === "absolute")) continue;
        const range = document.createRange();
        range.selectNodeContents(t);
        for (const r of range.getClientRects()) {
          // подпись, убранная далеко за экран (скрытый текст для чтения с экрана), человеку не показана
          if (r.right < rect.left - 200 || r.left > rect.right + 2000) continue;
          check(r, `текст «${t.textContent.trim().slice(0, 20)}»`);
        }
      }
      if (!bad) for (const child of node.querySelectorAll("svg, img")) {
        const cs = getComputedStyle(child);
        if (cs.position === "absolute" || cs.visibility === "hidden") continue;
        check(child.getBoundingClientRect(), child.tagName.toLowerCase());
        if (bad) break;
      }
      if (bad) out.push({ kind: "child", label, box, detail: bad });
    }
    return out;
  }, selector);
}

/**
 * Нагрузка длинной подписью: к тексту каждой кнопки дописывается длинный хвост
 * (русские и таджикские подписи заметно длиннее английских, на которых рисовали вид).
 * После этого кнопка обязана вырасти или перенести/усечь текст, а не выпустить его за рамку.
 * Меняется только страница в браузере теста, данные не трогаются.
 */
export async function stretchButtonLabels(page: Page, selector: string = BUTTON_SELECTOR): Promise<number> {
  return page.evaluate((sel) => {
    let n = 0;
    for (const node of document.querySelectorAll(sel)) {
      if (!(node instanceof HTMLElement) || node.getBoundingClientRect().width === 0) continue;
      // переключатель из двух-трёх слов («Продавцы · Покупатели», вкладки) — фиксированные слова
      // информационной схемы, а не подписи, которые растут с переводом
      if (node.closest(".seg, [role=tablist]")) continue;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let last: Node | null = null;
      // только словесные подписи: у числа в клетке календаря «длинной подписи» не бывает
      for (let t = walker.nextNode(); t; t = walker.nextNode()) if (t.textContent && /\p{L}{3,}/u.test(t.textContent)) last = t;
      if (!last) continue;
      last.textContent = `${last.textContent} Тасдиқи маълумот дар система`;
      n += 1;
    }
    return n;
  }, selector);
}
