import type { Page } from "@playwright/test";

/**
 * СТОРОЖ ГЕОМЕТРИИ «НОВОГО ВИДА» (20.11.2026, кадры владельца с iPhone).
 *
 * `noOverflow.ts` ловит только вылет вправо и многоточие. Владелец на телефоне нашёл
 * другие механизмы, и ни один из них вылетом не является:
 *
 *  - blur      — заголовок раздела полупрозрачный или под фильтром (читается «размытым»);
 *  - squeeze   — пилюля/счётчик сжаты уже своего текста (пилюля «Ждут проверки: 2» стала
 *                кругом, «Найдено: 117» — в две строки и слиплось с соседом);
 *  - overlap   — соседние элементы одного ряда наезжают друг на друга;
 *  - underNav  — низ страницы прокручивается ПОД плавающее нижнее меню телефона;
 *  - split     — короткая подпись с числом или датой («10 нояб. — 19 нояб.») рвётся на строки;
 *  - stripHint — ряд вкладок обрезан краем без признака, что он листается;
 *  - ghostCall — «Позвонить» внутри реплики стоит отдельным блоком (с пустой строкой);
 *  - lopsided  — у карточки пустой верх: содержимое прижато книзу чужим отступом
 *                («Этап просрочен у 4 объектов» — margin-top строки `.quiet` из темы);
 *  - hole      — в сетке плиток дыра посреди: строка с одной узкой плиткой, а ниже ещё
 *                плитки («Ждут ответа» одна, «Горит» растянута под ней — главная, 390 px);
 *  - navCrowd  — подписи нижнего меню вплотную (зазор меньше 6 px: «ГлавнаяКлиенты» на 320);
 *  - wordBreak — слово в кнопке/вкладке разорвано по буквам («Продавц/ы» на 320).
 *
 * Каждая находка — строка «вид: что и где», чтобы сообщение теста называло место.
 * Без импортов в браузерной части: функция уходит в page.evaluate целиком.
 */
export type GeometryKind = "blur" | "squeeze" | "overlap" | "underNav" | "split" | "stripHint" | "ghostCall" | "lopsided" | "hole" | "navCrowd" | "wordBreak";
export const GEOMETRY_KINDS: readonly GeometryKind[] = ["blur", "squeeze", "overlap", "underNav", "split", "stripHint", "ghostCall", "lopsided", "hole", "navCrowd", "wordBreak"];

/** Пропустить заведомо задуманное: селекторы, внутри которых проверка не идёт. */
export type GeometryOptions = { skip?: string; kinds?: readonly GeometryKind[] };

export async function geometryFindings(page: Page, opts: GeometryOptions = {}): Promise<string[]> {
  const kinds = opts.kinds ?? GEOMETRY_KINDS;
  // Прокрутить всё до низа, чтобы проверить последний элемент страницы над меню.
  if (kinds.includes("underNav")) {
    // До конца — несколько раз: длинный список дорисовывается по мере прокрутки.
    for (let i = 0; i < 6; i++) {
      const before = await page.evaluate(() => {
        const height = document.documentElement.scrollHeight;
        window.scrollTo(0, height);
        for (const el of document.querySelectorAll<HTMLElement>("main, main *, .clean-frame, .app-main-col")) {
          const s = getComputedStyle(el);
          if (/(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2) el.scrollTop = el.scrollHeight;
        }
        return height;
      });
      await page.waitForTimeout(250);
      if ((await page.evaluate(() => document.documentElement.scrollHeight)) === before) break;
    }
  }
  return page.evaluate(([kindList, skipSel]) => {
    const want = new Set(kindList as string[]);
    const out: string[] = [];
    const name = (el: Element) => {
      const cls = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className.trim().split(/\s+/).slice(0, 3).join(".") : "";
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 28);
      return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${text ? ` «${text}»` : ""}`;
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const s = getComputedStyle(el);
      if (s.visibility === "hidden" || s.display === "none") return false;
      // Содержимое свёрнутого <details> в Chromium сохраняет коробки (content-visibility), но не видно.
      const closed = el.closest("details:not([open])");
      return !closed || !!el.closest("summary");
    };
    const skipped = (el: Element) => !!skipSel && !!el.closest(skipSel);
    /** Сколько строк занимает текст элемента (по верхам строк, а не по высоте коробки). */
    const lineCount = (el: Element) => {
      const range = document.createRange(); range.selectNodeContents(el);
      const tops: number[] = [];
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 4) continue;
        if (!tops.some((t) => Math.abs(t - r.top) < r.height * 0.6)) tops.push(r.top);
      }
      return tops.length;
    };
    const root = document.querySelector("main") ?? document.body;
    const nav = document.querySelector<HTMLElement>("nav[data-bottomnav]");
    // Меню считается, только если оно действительно сверху: в открытой переписке телефона его
    // накрывает сама переписка со своим полем ввода.
    const navOnTop = (n: HTMLElement) => {
      const r = n.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && n.contains(hit);
    };
    const navTop = nav && visible(nav) && getComputedStyle(nav).position === "fixed" && navOnTop(nav) ? nav.getBoundingClientRect().top : Infinity;

    // ---- overlap: текст одного соседа наезжает на текст другого ----
    // Сравниваются строки ТЕКСТА, а не коробки: коробка кнопки 44 px законно заходит
    // на соседнюю подпись, а вот буквы на буквах — всегда поломка.
    const textRects = (el: Element) => {
      const rects: { left: number; right: number; top: number; bottom: number }[] = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!(n.textContent ?? "").trim() || !parent || !visible(parent)) continue;
        // Текст для экранного чтеца (1×1 px, clip) не виден — не считается.
        const pr = parent.getBoundingClientRect();
        if (pr.width <= 2 || pr.height <= 2) continue;
        // Видимая часть текста — в пределах режущих предков (многоточие, overflow: hidden).
        let clip = { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
        for (let p: Element | null = parent; p && p !== document.body; p = p.parentElement) {
          if (getComputedStyle(p).overflowX === "visible") continue;
          const r = p.getBoundingClientRect();
          clip = { left: Math.max(clip.left, r.left), right: Math.min(clip.right, r.right), top: Math.max(clip.top, r.top), bottom: Math.min(clip.bottom, r.bottom) };
        }
        const range = document.createRange(); range.selectNodeContents(n);
        for (const r of range.getClientRects()) {
          const box = { left: Math.max(r.left, clip.left), right: Math.min(r.right, clip.right), top: Math.max(r.top, clip.top), bottom: Math.min(r.bottom, clip.bottom) };
          if (box.right - box.left > 1 && box.bottom - box.top > 1) rects.push(box);
        }
      }
      return rects;
    };
    // ---- blur: заголовки раздела и экрана ----
    if (want.has("blur")) {
      for (const el of document.querySelectorAll("[data-topbar-title], main h1, main h2, main .pg-h b, main .pg-h h1")) {
        if (!visible(el) || skipped(el) || !(el.textContent ?? "").trim()) continue;
        let opacity = 1; const why: string[] = [];
        for (let p: Element | null = el; p && p !== document.documentElement; p = p.parentElement) {
          const s = getComputedStyle(p);
          opacity *= Number(s.opacity);
          if (s.filter && s.filter !== "none") why.push(`filter ${s.filter}`);
          const t = s.transform;
          if (t && t !== "none") {
            const m = t.match(/matrix\(([^)]+)\)/);
            const v = m ? m[1].split(",").map(Number) : [];
            if (v.length === 6 && (Math.abs(v[0] - 1) > 0.001 || Math.abs(v[3] - 1) > 0.001)) why.push(`scale ${v[0]}`);
          }
        }
        const color = getComputedStyle(el).color;
        const alpha = /rgba?\([^)]*,\s*([\d.]+)\)$/.exec(color)?.[1];
        if (opacity < 0.99) why.push(`opacity ${opacity.toFixed(2)}`);
        if (alpha !== undefined && color.startsWith("rgba") && Number(alpha) < 0.99) why.push(`color ${color}`);
        if (getComputedStyle(el).textShadow !== "none") why.push("text-shadow");
        if (why.length) out.push(`blur: ${name(el)} — ${why.join(", ")}`);
      }
    }

    // ---- squeeze: пилюли и счётчики уже своего текста ----
    if (want.has("squeeze")) {
      for (const el of root.querySelectorAll<HTMLElement>("*")) {
        if (!visible(el) || skipped(el)) continue;
        const text = (el.textContent ?? "").trim();
        if (text.length < 2 || text.length > 40 || el.children.length > 3) continue;
        // Значок с подписью только для экранного чтеца (кружок соцсети, точка события) — не пилюля с текстом.
        // (Текст, срезанный самой пилюлей, — наоборот, находка: смотрим на коробку родителя текста.)
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let shown = false;
        for (let n = walker.nextNode(); n && !shown; n = walker.nextNode()) {
          const pr = n.parentElement?.getBoundingClientRect();
          shown = !!(n.textContent ?? "").trim() && !!pr && pr.width > 2 && pr.height > 2;
        }
        if (!shown) continue;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        // Точка-метка (событие в клетке календаря на телефоне) — задуманный значок, не пилюля.
        if (r.width <= 12 && r.height <= 12) continue;
        const radius = parseFloat(s.borderTopLeftRadius);
        const pill = radius >= Math.min(r.width, r.height) / 2 - 1 && (s.backgroundColor !== "rgba(0, 0, 0, 0)" || s.borderTopWidth !== "0px");
        if (!pill) continue;
        const clipped = el.scrollWidth > el.clientWidth + 1;
        const round = text.length >= 6 && r.width < r.height * 1.4;
        // «В две строки» — только у самой подписи (без вложенных блоков): переключатель из
        // двух кнопок проверяется по каждой кнопке, а не целиком.
        const wrapped = text.length <= 24 && el.children.length <= 1 && lineCount(el) > 1;
        if (clipped || round || wrapped) out.push(`squeeze: ${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}${clipped ? " текст шире" : ""}${round ? " круг" : ""}${wrapped ? " в две строки" : ""}`);
      }
    }

    if (want.has("overlap")) {
      for (const box of root.querySelectorAll<HTMLElement>("*")) {
        const s = getComputedStyle(box);
        if (!/flex|grid/.test(s.display) || skipped(box) || !visible(box)) continue;
        const kids = [...box.children].filter((k) => visible(k) && !/absolute|fixed/.test(getComputedStyle(k).position));
        if (kids.length < 2 || kids.length > 40) continue;
        const rects = kids.map(textRects);
        for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
          const hit = rects[i].some((a) => rects[j].some((b) =>
            Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4));
          if (hit) out.push(`overlap: ${name(kids[i])} ⨯ ${name(kids[j])}`);
        }
      }
    }

    // ---- underNav: последний элемент страницы над меню ----
    if (want.has("underNav") && Number.isFinite(navTop)) {
      // Ещё раз до конца прямо перед замером: страница могла вернуть прокрутку наверх
      // (перерисовка списка, фокус) между прокруткой выше и этим замером.
      window.scrollTo(0, document.documentElement.scrollHeight);
      for (const el of document.querySelectorAll<HTMLElement>("main, main *, .clean-frame, .app-main-col")) {
        const st = getComputedStyle(el);
        if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 2) el.scrollTop = el.scrollHeight;
      }
      let last: Element | null = null; let bottom = 0;
      for (const el of root.querySelectorAll("*")) {
        if (el.children.length || !visible(el) || skipped(el)) continue;
        if (!(el.textContent ?? "").trim() && !el.matches("button, a, input, select, textarea, img, svg")) continue;
        if (getComputedStyle(el).position === "fixed" || el.closest("[role=dialog], nav[data-bottomnav]")) continue;
        const r = el.getBoundingClientRect();
        if (r.bottom > bottom) { bottom = r.bottom; last = el; }
      }
      if (last && bottom > navTop - 4 && bottom <= window.innerHeight + 2) out.push(`underNav: ${name(last)} низ ${Math.round(bottom)} > меню ${Math.round(navTop)}`);
      // Страница кончилась, а её конец всё ещё под меню и ниже окна — прокрутить уже нельзя.
      if (last && bottom > window.innerHeight + 2) out.push(`underNav: ${name(last)} ниже окна (${Math.round(bottom)}) после прокрутки до конца`);
    }

    // ---- split: короткая подпись с числом/датой рвётся на строки ----
    const MONTH = /\d\s*(янв|фев|мар|апр|ма[яй]|июн|июл|авг|сен|окт|ноя|дек)/i;
    if (want.has("split")) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = (n.textContent ?? "").trim();
        // Только «числовые» подписи: дата, сумма, счётчик «Найдено: 117», «10 нояб. — 19 нояб.».
        // Название объекта или адрес с номером дома переносятся законно.
        if (text.length < 3 || text.length > 28 || !/\d/.test(text)) continue;
        const numeric = MONTH.test(text) || /^[^\d]{0,16}:\s*[\d\s.,]+$/.test(text)
          || text.replace(/[^\d]/g, "").length / text.replace(/\s/g, "").length >= 0.4;
        if (!numeric) continue;
        const el = n.parentElement; if (!el || !visible(el) || skipped(el)) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        const tops: number[] = [];
        for (const r of range.getClientRects()) if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < r.height * 0.6)) tops.push(r.top);
        if (tops.length > 1) out.push(`split: ${name(el)} — «${text}» на ${tops.length} строках`);
      }
      // Подпись из двух узлов («Найдено: <b>117</b>») рвётся между ними.
      for (const el of root.querySelectorAll("p, span, div, small, b, strong, li, dd, dt, td")) {
        const text = (el.textContent ?? "").trim().replace(/\s+/g, " ");
        if (el.children.length === 0 || el.children.length > 3 || text.length < 3 || text.length > 28 || !/\d/.test(text)) continue;
        if (!(MONTH.test(text) || /^[^\d]{0,16}:\s*[\d\s.,]+$/.test(text))) continue;
        if (!visible(el) || skipped(el) || el.querySelector("button, a, input, select, svg")) continue;
        if (lineCount(el) > 1) out.push(`split: ${name(el)} — подпись на ${lineCount(el)} строках`);
      }
    }

    // ---- stripHint: ряд вкладок обрезан без признака прокрутки ----
    if (want.has("stripHint")) {
      for (const el of root.querySelectorAll<HTMLElement>("*")) {
        const s = getComputedStyle(el);
        if (!/(auto|scroll)/.test(s.overflowX) || el.scrollWidth <= el.clientWidth + 4 || !visible(el) || skipped(el)) continue;
        if (!el.querySelector("button, a, [role=tab]") || el.matches("table, table *") || el.querySelector("table")) continue;
        const mask = s.getPropertyValue("mask-image") || s.getPropertyValue("-webkit-mask-image");
        if ((!mask || mask === "none") && el.scrollLeft < el.scrollWidth - el.clientWidth - 4) out.push(`stripHint: ${name(el)} листается без признака (${el.scrollWidth}>${el.clientWidth})`);
      }
    }

    // ---- ghostCall: «Позвонить» в реплике отдельным блоком ----
    if (want.has("ghostCall")) {
      for (const el of root.querySelectorAll("[data-msg-call]")) {
        if (!visible(el)) continue;
        const d = getComputedStyle(el).display;
        if (d === "block" || d === "flex" || d === "grid") out.push(`ghostCall: ${name(el)} display ${d}`);
      }
    }
    // ---- lopsided: карточка с пустым верхом (низом) ----
    if (want.has("lopsided")) {
      // Только карточки и плашки: пузырь переписки, кнопка и значок — не карточки.
      for (const card of root.querySelectorAll<HTMLElement>(".card, .tile, .quiet, [class*='-card'], [class*='overdue'], [class*='notice']")) {
        const s = getComputedStyle(card);
        if (parseFloat(s.borderTopLeftRadius) < 12 || s.backgroundColor === "rgba(0, 0, 0, 0)" || !visible(card) || skipped(card)) continue;
        const r = card.getBoundingClientRect();
        if (r.height > 220 || r.height < 40) continue;
        // Фото и обложки: подписи поверх снимка прижаты к углам нарочно.
        if (/photo|thumb|gallery|cover|avatar|media/i.test(String(card.className)) || s.backgroundImage !== "none" || card.querySelector("img, video, picture, canvas")) continue;
        // Видимое содержимое: листья и то, у чего есть своя заливка (кружок значка пустого
        // состояния виден целиком, а не только контур внутри него).
        const kids = [...card.querySelectorAll("*")].filter((k) => visible(k) && getComputedStyle(k).position !== "absolute"
          && (k.children.length === 0 || getComputedStyle(k).backgroundColor !== "rgba(0, 0, 0, 0)"));
        if (!kids.length) continue;
        const top = Math.min(...kids.map((k) => k.getBoundingClientRect().top)) - r.top;
        const bottom = r.bottom - Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
        // Плитка, вытянутая по высоте соседки в той же строке сетки, законно пустеет снизу.
        const stretched = [...(card.parentElement?.children ?? [])].some((sib) => sib !== card && visible(sib)
          && Math.abs(sib.getBoundingClientRect().top - r.top) < 3 && Math.abs(sib.getBoundingClientRect().height - r.height) < 3);
        // Находка — пустой ВЕРХ: содержимое прижато книзу чужим отступом.
        if (!stretched && top > 16 && top - bottom > 10) out.push(`lopsided: ${name(card)} сверху ${Math.round(top)} снизу ${Math.round(bottom)}`);
      }
    }
    // ---- navCrowd: подписи нижнего меню вплотную ----
    if (want.has("navCrowd") && nav && visible(nav)) {
      const boxes = [...nav.querySelectorAll("[data-tab-label]")].filter(visible).map((l) => {
        const range = document.createRange(); range.selectNodeContents(l);
        return { text: (l.textContent ?? "").trim(), box: range.getBoundingClientRect() };
      }).sort((a, b) => a.box.left - b.box.left);
      for (let i = 1; i < boxes.length; i++) {
        const gap = boxes[i].box.left - boxes[i - 1].box.right;
        if (gap < 6) out.push(`navCrowd: «${boxes[i - 1].text}» и «${boxes[i].text}» — зазор ${Math.round(gap)} px`);
      }
    }

    // ---- wordBreak: слово в кнопке или вкладке разорвано по буквам ----
    if (want.has("wordBreak")) {
      for (const el of root.querySelectorAll("button, a, [role=tab], .chip, .pill")) {
        if (!visible(el) || skipped(el)) continue;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent ?? "";
          for (const m of text.matchAll(/[\p{L}\d]{4,}/gu)) {
            const range = document.createRange();
            range.setStart(n, m.index!); range.setEnd(n, m.index! + m[0].length);
            const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
            if (tops.size > 1) out.push(`wordBreak: ${name(el)} — «${m[0]}» разорвано на ${tops.size} строки`);
          }
        }
      }
    }

    // ---- hole: дыра посреди сетки плиток ----
    if (want.has("hole")) {
      for (const grid of root.querySelectorAll<HTMLElement>("*")) {
        const s = getComputedStyle(grid);
        const tracks = s.gridTemplateColumns.split(" ").map(parseFloat).filter((v) => v > 0);
        // Только сетки плиток: колонки равной ширины. Ряд «значок · текст · кнопка» — не сетка плиток.
        if (s.display !== "grid" || tracks.length < 2 || Math.max(...tracks) / Math.min(...tracks) > 1.15 || !visible(grid) || skipped(grid)) continue;
        const kids = [...grid.children].filter((k) => visible(k) && !/absolute|fixed/.test(getComputedStyle(k).position));
        const rows: Element[][] = [];
        for (const k of kids) {
          const top = k.getBoundingClientRect().top;
          const row = rows.find((r) => Math.abs(r[0].getBoundingClientRect().top - top) < 3);
          if (row) row.push(k); else rows.push([k]);
        }
        const width = grid.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
        rows.slice(0, -1).forEach((row) => {
          const used = row.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0);
          if (used < width * 0.6) out.push(`hole: ${name(grid)} — строка «${(row[0].textContent ?? "").trim().slice(0, 20)}» занимает ${Math.round(used)} из ${Math.round(width)}, ниже ещё плитки`);
        });
      }
    }
    return [...new Set(out)];
  }, [kinds as readonly string[], opts.skip ?? ""] as const);
}

/** Ряд ширин владельца (20.11.2026): телефоны, планшеты, ПК. */
export const OWNER_WIDTHS = [320, 360, 375, 390, 414, 430, 768, 820, 1024, 1280, 1440, 1920] as const;

/** Телефонные отпечатки — сторож гоняется и под iPhone, и под Android. */
export const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
export const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36";
