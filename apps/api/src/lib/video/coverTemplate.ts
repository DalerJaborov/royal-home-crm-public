/**
 * ШАБЛОН ОБЛОЖКИ ОБЪЕКТА — чистый строитель SVG (без БД, без sharp), под
 * рендер `coverPoster.ts`.
 *
 * ИСТОЧНИК ЧИСЕЛ (23.09.2026) — слоистые исходники владельца от ChatGPT:
 * `royal_home_template/` (spec.json, templates/cover-square.svg, assets/),
 * `royal_home_vertical_source/` (cover.svg + spec.json, 1080×1920).
 * Оттуда взяты: палитра (#F2B94B / #FFD77A / #C88A25 / #07130F / #020805),
 * золотой градиент 45° (0 → 48 % → 100 %), тёмное наложение 135°
 * (0.78 → 0.17 → 0.71), нижняя лента, радиусы плашек (20/22 и 12), обводки,
 * тени (dy 7, размытие 10, 35 %), слой листьев и порядок слоёв.
 * ВЕРТИКАЛЬ перенесена из исходника ЦЕЛИКОМ: все координаты, кегли и
 * межбуквенные расстояния — его.
 *
 * ЧЕМ ОТЛИЧАЕМСЯ ОТ ИСХОДНИКА И ПОЧЕМУ (проверено рендером):
 * 1. КВАДРАТ. В `templates/cover-square.svg` нижний ряд (линия y=860,
 *    ДУШАНБЕ 895, РАЙОН 917, ОРИЕНТИР 939) лежит ПОВЕРХ плашки цены
 *    (785…917) и рамки площади (939…1051), а иконки — на самой плашке.
 *    Это сам по себе сломанный макет и он расходится с эталоном IMG_9508,
 *    поэтому координаты квадрата оставлены замеренными с эталона (сетка
 *    1254), а из исходника взят только стиль.
 * 2. ШРИФТ. В spec.json Montserrat помечен как ДОГАДКА (confidence 0.72,
 *    «cannot be proven from a flattened PNG»). У нас есть настоящий TT Norms
 *    Pro владельца, он ближе к эталону — оставлен он, кегли исходника взяты
 *    как есть.
 * 3. «90 M²» латиницей в исходнике — у нас «90 м²» кириллицей (правило брифа).
 * 4. Ширина плашки цены и рамки площади растёт под длинное число
 *    («1 035 500 TJS», «112,5 м²»): в исходнике они фиксированы под 890 000/90.
 * 5. Нижняя лента затемнения добавлена и в квадрат (в исходнике её нет — там
 *    нижние подписи лежат на золотой плашке и фон им не мешает).
 * 6. `photo_adjustment` исходника (яркость −0.02, насыщенность −0.08) НЕ взят:
 *    владелец 22.09 прямо сказал, что обложки тусклые. Своя коррекция в
 *    `coverPoster.ts` делает кадр светлее и сочнее.
 * 7. Эмблему рисуем НАСТОЯЩИМ файлом из Настроек, а не фигурами из
 *    `assets/logo.svg` (тот — приблизительная перерисовка, бриф её запрещает);
 *    из исходника взяты только кольца-рамка и место подписи.
 *
 * Ширины строк считаются по hmtx-таблицам шрифта (`coverMetrics.ts`):
 * librsvg метрики наружу не отдаёт, а плашка цены строится по ширине текста.
 * Горизонтальное сжатие — `transform: scale(sx 1)`, а не `textLength`
 * (librsvg поддерживает его не везде).
 */
import { COVER_ADVANCE, COVER_CAP_HEIGHT, COVER_SUP_HEIGHT, COVER_X_HEIGHT, type CoverMetricsWeight } from "./coverMetrics.js";
import { escapeXml } from "./svgText.js";

export const COVER_FONT_FAMILY = "TT Norms Pro";
export const COVER_SERIF_FAMILY = "Playfair Display";


interface FontSpec {
  family: string;
  weight: number;
  metrics: CoverMetricsWeight;
}
const FONT = {
  display: { family: COVER_FONT_FAMILY, weight: 800, metrics: "ExtraBold" },
  // Подписи «TJS», «м²», город, этаж — тоже ExtraBold: у файла Bold нет
  // typographic-family (nameID 16), и pango на запрос веса 700 первым в
  // документе молча отдавал серифный запасной шрифт (поймано сверкой 22.09).
  strong: { family: COVER_FONT_FAMILY, weight: 800, metrics: "ExtraBold" },
  caption: { family: COVER_FONT_FAMILY, weight: 500, metrics: "Medium" },
  serif: { family: COVER_SERIF_FAMILY, weight: 700, metrics: "ExtraBold" },
} satisfies Record<string, FontSpec>;

// Палитра, градиенты и радиусы — из `spec.json` исходников владельца
// (`royal_home_template`, `royal_home_vertical_source`, 23.09.2026).
const GOLD = "#F2B94B";
const GOLD_HI = "#FFD77A";
const GOLD_DARK = "#C88A25";
const CAPTION_FILL = "#FFFFFF";
const INK = "#07130F";
const DEEP = "#020805";
/** Радиусы плашек: квадрат 20/12, вертикаль 22/12 (spec elements.*.radius). */
const PLATE_RADIUS = 20;
const AREA_RADIUS = 12;

export const COVER_SLOGAN = "Хонаи орзуҳои шумо дар Душанбе";

/** Данные, которые шаблон кладёт на обложку. Любое null — строки просто нет. */
export interface CoverTemplateData {
  rooms: string | null;
  roomsWord: string;
  /** Только число: «890 000». «TJS» рисуется отдельно, мельче. */
  priceNumber: string;
  currency: string;
  /** Только число площади: «90». «м²» рисуется отдельно. */
  areaNumber: string;
  /** «15 ошёна» или null. */
  floor: string | null;
  city: string;
  district: string | null;
  landmark: string | null;
}

export interface CoverTemplateResult {
  shadeSvg: string;
  textSvg: string;
  /** Куда sharp кладёт настоящий файл логотипа (px итогового кадра). */
  logo: { left: number; top: number; size: number };
  /** Верх «чернил» ключевого блока (макушка цифры/плашки). */
  contentTopY: number;
  contentBottomY: number;
  /** Низ подписи «HOME TJ» под эмблемой. */
  logoBottomY: number;
  /** Где рисунок обязан уместиться, чтобы его не срезал ни один кроп показа. */
  safeZone: CoverSafeZone;
  /** Коробки всех надписей и плашек в пикселях кадра — для стражей в тестах. */
  inkBoxes: CoverInkBox[];
}

const num = (n: number): string => (Math.round(n * 100) / 100).toString();
const sizeForCap = (cap: number): number => cap / COVER_CAP_HEIGHT;

export function measureCoverText(text: string, size: number, ls = 0, weight: CoverMetricsWeight = "ExtraBold"): number {
  const table = COVER_ADVANCE[weight];
  const chars = [...text];
  let w = 0;
  for (const ch of chars) w += table[ch] ?? 700;
  return (w / 1000) * size + Math.max(0, chars.length - 1) * ls;
}

interface TextOpts {
  x: number;
  y: number;
  size: number;
  font?: FontSpec;
  fill: string;
  anchor?: "start" | "middle" | "end";
  ls?: number;
  content: string;
  /** Горизонтальный масштаб глифов (1 — без изменений). */
  sx?: number;
}

function text({ x, y, size, font = FONT.display, fill, anchor = "start", ls = 0, content, sx = 1 }: TextOpts): string {
  const attrs = [
    `font-family="${font.family}"`,
    `font-weight="${font.weight}"`,
    `font-size="${num(size)}"`,
    `fill="${fill}"`,
    anchor !== "start" ? `text-anchor="${anchor}"` : "",
    ls ? `letter-spacing="${num(ls)}"` : "",
  ].filter(Boolean);
  if (sx === 1) {
    return `<text x="${num(x)}" y="${num(y)}" ${attrs.join(" ")}>${escapeXml(content)}</text>`;
  }
  return `<text transform="translate(${num(x)} ${num(y)}) scale(${num(sx)} 1)" x="0" y="0" ${attrs.join(" ")}>${escapeXml(content)}</text>`;
}

interface PricePlateSpec {
  /** Высота прописной у цены и у валюты — в единицах сетки этого формата. */
  priceCap: number;
  curCap: number;
  padL: number;
  gap: number;
  padR: number;
  /** Горизонтальное сжатие цены (у валюты его нет). */
  sx: number;
  /** Шире этого плашка быть не может — край холста минус поля. */
  maxWidth: number;
}

interface PricePlateFit {
  priceSize: number;
  currencySize: number;
  priceWidth: number;
  currencyWidth: number;
  plateWidth: number;
  /** Во сколько раз пришлось уменьшить кегли, 1 — влезло как есть. */
  scale: number;
}

/**
 * Подбирает кегль цены и валюты так, чтобы надпись влезла в плашку.
 *
 * До 22.09.2026 ширина плашки бралась как `Math.min(предел, нужная ширина)`,
 * а текст рисовался натуральной величины и за обрезанный край вылезал. Замер:
 * в вертикали (её предел уже, 960 против ~1000 у квадрата) с 13 000 000 TJS
 * «TJS» уходит за плашку, а к 20 000 000 — и за холст. Цена в сомони такой и
 * бывает: 13 млн — это примерно 1,2 млн долларов, обычная коммерция, а она у
 * агентства прямо в шапке постера («КВАРТИРАҲО | ХОНАҲО | КОММЕРСИЯ»).
 * Обложка при этом рисуется без единой ошибки — ни сборка, ни тесты такого
 * не видят.
 *
 * Уменьшается кегль, а не сжатие по горизонтали: сжатая TT Norms Pro слипается
 * в столбики (та же причина, по которой цифры площади не подгонялись под
 * эталон). Ширина текста линейна по кеглю, поэтому один пересчёт даёт точный
 * ответ, без поиска шагами.
 */
function fitPricePlate(d: CoverTemplateData, spec: PricePlateSpec): PricePlateFit {
  const measure = (scale: number): PricePlateFit => {
    const priceSize = sizeForCap(spec.priceCap * scale);
    const currencySize = sizeForCap(spec.curCap * scale);
    const priceWidth = measureCoverText(d.priceNumber, priceSize) * spec.sx;
    const currencyWidth = measureCoverText(d.currency, currencySize, 0, FONT.strong.metrics);
    const plateWidth = spec.padL + priceWidth + spec.gap + currencyWidth + spec.padR;
    return { priceSize, currencySize, priceWidth, currencyWidth, plateWidth, scale };
  };
  const natural = measure(1);
  if (natural.plateWidth <= spec.maxWidth) return natural;
  // Поля не сжимаются вместе с буквами — вычитаем их, считаем долю по тексту.
  const pads = spec.padL + spec.gap + spec.padR;
  const room = Math.max(spec.maxWidth - pads, 1);
  return measure(room / (natural.plateWidth - pads));
}

/** Кегль «м» и «²» рядом с числом площади: у строчной своя мерка (x-height),
 *  у надстрочного — своя, поэтому считать их долей от кегля цифр нельзя —
 *  выходят вдвое мельче. Отношения высот сняты с эталона: «м» 0,79 от высоты
 *  цифр, «²» — 0,27. */
function areaUnitSizes(valueSize: number): { unitSize: number; supSize: number } {
  const digits = valueSize * COVER_CAP_HEIGHT;
  return { unitSize: (digits * 0.79) / COVER_X_HEIGHT, supSize: (digits * 0.27) / COVER_SUP_HEIGHT };
}

function defs(_width: number, _height: number): string {
  // Тёмное наложение и золото — ровно как в исходных SVG владельца:
  // 135° «darkOverlay» (0.78 → 0.16 → 0.70/0.72) и 45° «goldGradient».
  return `<defs>
<linearGradient id="goldGradient" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="${GOLD_HI}"/><stop offset="48%" stop-color="${GOLD}"/><stop offset="100%" stop-color="${GOLD_DARK}"/>
</linearGradient>
<linearGradient id="darkOverlay" x1="0%" y1="0%" x2="100%" y2="100%">
<stop offset="0%" stop-color="${DEEP}" stop-opacity="0.78"/><stop offset="52%" stop-color="${INK}" stop-opacity="0.17"/><stop offset="100%" stop-color="${DEEP}" stop-opacity="0.71"/>
</linearGradient>
<linearGradient id="bottomFade" x1="0%" y1="0%" x2="0%" y2="100%">
<stop offset="0%" stop-color="${INK}" stop-opacity="0"/><stop offset="100%" stop-color="${DEEP}" stop-opacity="0.82"/>
</linearGradient>
<radialGradient id="logoPad" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" stop-color="${DEEP}" stop-opacity="0.62"/><stop offset="0.45" stop-color="${DEEP}" stop-opacity="0.38"/><stop offset="0.75" stop-color="${DEEP}" stop-opacity="0.14"/><stop offset="1" stop-color="${DEEP}" stop-opacity="0"/>
</radialGradient>
<filter id="softShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="7" stdDeviation="10" flood-color="#000000" flood-opacity="0.35"/></filter>
<filter id="logoDrop" x="-30%" y="-30%" width="170%" height="180%"><feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#000000" flood-opacity="0.5"/></filter>
<filter id="textDrop" x="-30%" y="-40%" width="180%" height="200%"><feDropShadow dx="0" dy="6" stdDeviation="12" flood-color="#04120c" flood-opacity="0.55"/></filter>
</defs>`;
}

/** Общее для обоих форматов затемнение по `spec.json` + нижняя лента: без неё
 *  белые подписи нижнего ряда садятся прямо на светлое фото (в исходном SVG
 *  квадрата нижний ряд лежит поверх плашки цены — там эта беда не видна). */
function overlay(width: number, height: number, fadeTopY: number): string {
  return [
    `<rect x="0" y="0" width="${width}" height="${height}" fill="url(#darkOverlay)"/>`,
    `<rect x="0" y="${num(fadeTopY)}" width="${width}" height="${num(height - fadeTopY)}" fill="url(#bottomFade)"/>`,
  ].join("\n");
}

/** Булавка перед городом — SVG-путь, тянется вместе с кеглем. */
function pinIcon(x: number, y: number, s: number, fill: string): string {
  const r = s * 0.5;
  const cx = x + r;
  const cy = y + r;
  const tip = y + s * 1.35;
  return (
    `<g fill="${fill}"><path d="M ${num(cx)} ${num(tip)} C ${num(cx - r * 0.95)} ${num(cy + r * 0.72)} ${num(cx - r)} ${num(cy + r * 0.3)} ${num(cx - r)} ${num(cy)}` +
    ` A ${num(r)} ${num(r)} 0 1 1 ${num(cx + r)} ${num(cy)}` +
    ` C ${num(cx + r)} ${num(cy + r * 0.3)} ${num(cx + r * 0.95)} ${num(cy + r * 0.72)} ${num(cx)} ${num(tip)} Z"/>` +
    `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r * 0.36)}" fill="${DEEP}"/></g>`
  );
}

/** «Слои» перед этажом — три ромба, SVG-путями. */
function layersIcon(x: number, y: number, w: number, fill: string): string {
  const h = w * 0.52;
  const cx = x + w / 2;
  const step = w * 0.26;
  const paths = [0, 1, 2]
    .map((i) => {
      const top = y + i * step;
      const o = i === 0 ? 1 : i === 1 ? 0.85 : 0.7;
      return `<path opacity="${o}" d="M ${num(cx)} ${num(top)} L ${num(x + w)} ${num(top + h / 2)} L ${num(cx)} ${num(top + h)} L ${num(x)} ${num(top + h / 2)} Z"/>`;
    })
    .join("");
  return `<g fill="${fill}">${paths}</g>`;
}


function splitSlogan(): [string, string] {
  const words = COVER_SLOGAN.toUpperCase().split(/\s+/);
  const cut = Math.max(1, Math.ceil(words.length * 0.6));
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

function svgDoc(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${defs(w, h)}\n${body}\n</svg>`;
}

// ---------------------------------------------------------------------------
// БЕЗОПАСНАЯ ЗОНА (владелец, 23.09.2026: «нижние надписи вылезают из кадра»).
// ---------------------------------------------------------------------------
/**
 * Где обложку обрезают на самом деле (снято с кода сайта `site-pr-verify` и
 * правил Instagram, 23.09.2026):
 *
 *  КВАДРАТ 1080×1080 (сайт + лента):
 *   • карточка каталога, главная, избранное, похожие — `aspect-[16/10]`,
 *     object-cover по центру (`CardPhotoCarousel.tsx:150`) → видна полоса
 *     y 202…878, это самое тесное место;
 *   • главное фото объявления на телефоне — `aspect-[4/3]` (y 135…945),
 *     на компьютере снова 16:10 (`ListingDetailPage.tsx:232`);
 *   • сетка профиля Instagram — 4:5 по центру → x 108…972;
 *   • миниатюры — 1:1, режут ничего.
 *   Пересечение: x 108…972, y 203…877, плюс поле 12 px от кромки.
 *
 *  ВЕРТИКАЛЬ 1080×1920 (Reels, TikTok, Shorts, Telegram):
 *   • сетка профиля Instagram показывает Reels кропом 4:5 по центру
 *     (y 285…1635), старый кроп 1:1 — y 420…1500;
 *   Пересечение: y 420…1500 по всей ширине, плюс поле.
 *
 * Композиция эталона при этом НЕ меняется: весь рисунок (эмблема сверху,
 * крупная цифра, «ХОНАГА», плашка цены, площадь, нижний ряд, слоган) строится в
 * прежней сетке 1254 замера IMG_9508 и целиком вписывается в безопасную зону —
 * эмблема отдельной группой по центру, остальной блок своей группой слева.
 * Так ни одна надпись не попадает под обрез ни в одном из мест показа.
 */
export interface CoverSafeZone {
  x: number;
  y: number;
  width: number;
  height: number;
}

const SAFE_MARGIN = 12;

export const COVER_SQUARE_CROPS = [
  { name: "16:10", ratio: 16 / 10 },
  { name: "4:3", ratio: 4 / 3 },
  { name: "4:5", ratio: 4 / 5 },
  { name: "1:1", ratio: 1 },
] as const;

/** Прямоугольник, видимый при центрированном кропе `ratio` (ширина/высота). */
export function centeredCrop(width: number, height: number, ratio: number): CoverSafeZone {
  if (width / height > ratio) {
    const w = height * ratio;
    return { x: (width - w) / 2, y: 0, width: w, height };
  }
  const h = width / ratio;
  return { x: 0, y: (height - h) / 2, width, height: h };
}

function intersect(zones: CoverSafeZone[]): CoverSafeZone {
  const x = Math.max(...zones.map((z) => z.x));
  const y = Math.max(...zones.map((z) => z.y));
  const right = Math.min(...zones.map((z) => z.x + z.width));
  const bottom = Math.min(...zones.map((z) => z.y + z.height));
  return { x, y, width: right - x, height: bottom - y };
}

function inset(zone: CoverSafeZone, margin: number): CoverSafeZone {
  return { x: zone.x + margin, y: zone.y + margin, width: zone.width - margin * 2, height: zone.height - margin * 2 };
}

/** Безопасная зона формата: пересечение всех реальных кропов минус поле. */
export function coverSafeZone(width: number, height: number): CoverSafeZone {
  if (height / width > 1.2) {
    // Вертикаль: кроп 4:5 сетки Instagram и старый 1:1 на y=420 (для 1920 —
    // это ровно центр). Ширина кадра видна вся.
    const profile = { x: 0, y: (height - width) / 2, width, height: width };
    return inset(intersect([centeredCrop(width, height, 4 / 5), profile]), SAFE_MARGIN + 18);
  }
  return inset(intersect(COVER_SQUARE_CROPS.map((c) => centeredCrop(width, height, c.ratio))), SAFE_MARGIN);
}

/** Коробка нарисованного элемента в пикселях итогового кадра — для стражей. */
export interface CoverInkBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Группа в сетке 1254 → пиксели кадра: `px = tx + k·x`. */
interface GroupTransform {
  k: number;
  tx: number;
  ty: number;
}

/** Рисует текст и запоминает его коробку в пикселях кадра (для стражей). */
function makeInk(transform: GroupTransform, boxes: CoverInkBox[]) {
  const toPx = (x: number, y: number, w: number, h: number): Omit<CoverInkBox, "id"> => ({
    x: transform.tx + transform.k * x,
    y: transform.ty + transform.k * y,
    width: transform.k * w,
    height: transform.k * h,
  });
  const weightOf = (font?: FontSpec): CoverMetricsWeight => (font ?? FONT.display).metrics;
  return {
    text(id: string, opts: TextOpts): string {
      const w = measureCoverText(opts.content, opts.size, opts.ls ?? 0, weightOf(opts.font)) * (opts.sx ?? 1);
      const left = opts.anchor === "middle" ? opts.x - w / 2 : opts.anchor === "end" ? opts.x - w : opts.x;
      // Высота по самим буквам строки: у цифр и латиницы — прописная (0,7
      // кегля) с запасом; надстрочные таджикские (Ӣ, Ӯ, Ё, Й) поднимают верх,
      // хвосты «Д», «Ц», «Щ», «у», «р» опускают низ. Грубая единая коробка
      // «на всякий случай» врала бы стражам: цифра «2» выглядела бы наползшей
      // на эмблему, которой она на самом деле не касается.
      const top = opts.y - opts.size * (/[ЁЙӢӮёйӣӯ]/.test(opts.content) ? 0.92 : 0.74);
      const bottom = opts.y + opts.size * (/[ДЦЩдцщуурфgjpqy,]/.test(opts.content) ? 0.22 : 0.04);
      boxes.push({ id, ...toPx(left, top, w, bottom - top) });
      return text(opts);
    },
    rect(id: string, x: number, y: number, w: number, h: number): void {
      boxes.push({ id, ...toPx(x, y, w, h) });
    },
  };
}

// Сетка 1254 (замер IMG_9508): границы двух групп рисунка.
/** Эмблема + «ROYAL / HOME TJ»: знак 551…703 по x, 69…221 по y, подпись до 284. */
const LOGO_BOX = { x: 538, y: 69, width: 180, height: 222, cx: 628 };
const LOGO_MARK = { x: 551, y: 69, size: 152 };
/** Информационный блок: от макушки цифры до низа слогана. */
const BLOCK_BOX = { x: 74, y: 678 - 223, width: 1178 - 74, height: 1192 - (678 - 223) };
/** Доля высоты зоны под эмблему и зазор до блока. */
/** Предел ширины крупной цифры в сетке 1254: левая половина блока, под эмблемой. */
const HERO_MAX_WIDTH = 540;
const LOGO_SHARE = 0.2;
const LOGO_GAP_SHARE = 0.03;

function buildCover(d: CoverTemplateData, w: number, h: number): CoverTemplateResult {
  const zone = coverSafeZone(w, h);
  const boxes: CoverInkBox[] = [];

  // Масштабы групп — чтобы эмблема и блок вместе встали в зону.
  const logoH = zone.height * LOGO_SHARE;
  const kLogo = logoH / LOGO_BOX.height;
  const gap = zone.height * LOGO_GAP_SHARE;
  const kBlock = Math.min((zone.height - logoH - gap) / BLOCK_BOX.height, zone.width / BLOCK_BOX.width);
  const totalH = logoH + gap + BLOCK_BOX.height * kBlock;
  const top = zone.y + (zone.height - totalH) / 2;
  const cx = zone.x + zone.width / 2;

  const logoT: GroupTransform = { k: kLogo, tx: cx - LOGO_BOX.cx * kLogo, ty: top - LOGO_BOX.y * kLogo };
  const blockTop = top + logoH + gap;
  const blockT: GroupTransform = { k: kBlock, tx: zone.x - BLOCK_BOX.x * kBlock, ty: blockTop - BLOCK_BOX.y * kBlock };

  // --- эмблема ---
  const logoInk = makeInk(logoT, boxes);
  logoInk.rect("logo", LOGO_MARK.x, LOGO_MARK.y, LOGO_MARK.size, LOGO_MARK.size);
  const logoItems = [
    `<g>` +
      logoInk.text("wordmark-royal", { x: LOGO_BOX.cx, y: 244, size: 35, font: FONT.serif, fill: "url(#goldGradient)", anchor: "middle", ls: 5.5, content: "ROYAL" }) +
      logoInk.text("wordmark-home", { x: LOGO_BOX.cx, y: 279, size: 35, font: FONT.serif, fill: "url(#goldGradient)", anchor: "middle", ls: 5.5, content: "HOME TJ" }) +
      `</g>`,
  ];

  // --- информационный блок (прежняя сетка эталона) ---
  const ink = makeInk(blockT, boxes);
  const L = 76;
  const R = 1178;
  const items: string[] = [];

  if (d.rooms !== null) {
    // Одна цифра — как в эталоне; «10», «12» или площадь «582» сужаем, чтобы не вылезти за левую половину блока.
    const heroSize = sizeForCap(223);
    const heroWide = measureCoverText(d.rooms, heroSize) * 1.2;
    const heroFit = Math.min(1, HERO_MAX_WIDTH / heroWide);
    items.push(`<g filter="url(#textDrop)">${ink.text("rooms", { x: L, y: 678, size: heroSize * heroFit, fill: "url(#goldGradient)", content: d.rooms, sx: 1.2 })}</g>`);
    items.push(`<g filter="url(#textDrop)">${ink.text("roomsWord", { x: L + 2, y: 770, size: sizeForCap(74), fill: "#ffffff", content: d.roomsWord.toUpperCase() })}</g>`);
  }

  // плашка цены: «TJS» мельче цены (53 против 93 по высоте прописной)
  const pSx = 0.86;
  const padL = 40;
  const gapP = 30;
  const padR = 44;
  const {
    priceSize: pSize,
    currencySize: cSize,
    priceWidth: pw,
    plateWidth: plateW,
  } = fitPricePlate(d, { priceCap: 93, curCap: 53, padL, gap: gapP, padR, sx: pSx, maxWidth: R - 74 });
  ink.rect("pricePlate", 74, 789, plateW, 153);
  items.push(
    `<g filter="url(#softShadow)"><rect x="74" y="789" width="${num(plateW)}" height="153" rx="${num(PLATE_RADIUS * 1.1613)}" fill="url(#goldGradient)"/></g>`
  );
  items.push(ink.text("price", { x: 114, y: 905, size: pSize, fill: INK, content: d.priceNumber, sx: pSx }));
  items.push(ink.text("currency", { x: 114 + pw + gapP, y: 897, size: cSize, font: FONT.strong, fill: INK, content: d.currency }));

  // площадь
  {
    const bx = 77;
    const by = 960;
    const bh = 132;
    const mainSize = sizeForCap(70);
    const { unitSize, supSize } = areaUnitSizes(mainSize);
    const aSx = 0.88;
    const wNum = measureCoverText(d.areaNumber, mainSize) * aSx;
    const wUnit = measureCoverText("м", unitSize, 0, FONT.strong.metrics);
    const wSup = measureCoverText("²", supSize, 0, FONT.strong.metrics);
    const total = wNum + 15 + wUnit + 2 + wSup;
    // рамка эталона 307 — под «90 м²»; дробная площадь («112,5 м²») раздвигает её
    const bw = Math.max(307, total + 64);
    ink.rect("areaBox", bx, by, bw, bh);
    items.push(`<rect x="${bx}" y="${by}" width="${num(bw)}" height="${bh}" rx="${AREA_RADIUS * 1.1613}" fill="${DEEP}" fill-opacity="0.38" stroke="${GOLD}" stroke-opacity="0.95" stroke-width="2"/>`);
    const acx = bx + bw / 2;
    let ax = acx - total / 2;
    items.push(ink.text("area", { x: ax, y: 1040, size: mainSize, fill: "#ffffff", content: d.areaNumber, sx: aSx }));
    ax += wNum + 15;
    items.push(ink.text("areaUnit", { x: ax, y: 1040, size: unitSize, font: FONT.strong, fill: "#ffffff", content: "м" }));
    ax += wUnit + 2;
    items.push(ink.text("areaSup", { x: ax, y: 1017, size: supSize, font: FONT.strong, fill: "#ffffff", content: "²" }));
    items.push(ink.text("areaLabel", { x: acx, y: 1074, size: 23, font: FONT.caption, fill: CAPTION_FILL, anchor: "middle", ls: 7, content: "МАСОҲАТ" }));
  }

  // нижний ряд: линия, булавка + город/район/ориентир, разделитель, слои + этаж, слоган
  ink.rect("rule", L, 1106, R - L, 1.6);
  items.push(`<rect x="${L}" y="1106" width="${R - L}" height="1.6" fill="${GOLD}" fill-opacity="0.55"/>`);
  const CAP_SIZE = 19;
  const CAP_LS = 2.6;
  const cityTxt = d.city.toUpperCase();
  const l1 = d.district ? `РАЙОН: ${d.district.toUpperCase()}` : null;
  const l2 = d.landmark ? `ОРИЕНТИР: ${d.landmark.toUpperCase()}` : null;
  const tx = 156;
  const widths = [measureCoverText(cityTxt, sizeForCap(19), 1.2, FONT.strong.metrics)];
  if (l1) widths.push(measureCoverText(l1, CAP_SIZE, CAP_LS, FONT.caption.metrics));
  if (l2) widths.push(measureCoverText(l2, CAP_SIZE, CAP_LS, FONT.caption.metrics));
  // Длинный ориентир не должен съесть этаж и слоган: ограничиваем колонку
  // и ужимаем строку по горизонтали, а не переносим (ряд одной высоты).
  const addrMax = 470;
  const addrSx = (line: string): number => Math.min(1, addrMax / measureCoverText(line, CAP_SIZE, CAP_LS, FONT.caption.metrics));
  const cityEnd = tx + Math.min(addrMax, Math.max(...widths));
  ink.rect("pin", 76, 1124, 37, 50);
  items.push(pinIcon(76, 1124, 37, GOLD));
  items.push(ink.text("city", { x: tx, y: 1141, size: sizeForCap(19), font: FONT.strong, fill: "#ffffff", ls: 1.2, content: cityTxt }));
  let ly = 1161;
  if (l1) {
    items.push(ink.text("district", { x: tx, y: ly, size: CAP_SIZE, font: FONT.caption, fill: CAPTION_FILL, ls: CAP_LS, content: l1, sx: addrSx(l1) }));
    ly += 20;
  }
  if (l2) items.push(ink.text("landmark", { x: tx, y: ly, size: CAP_SIZE, font: FONT.caption, fill: CAPTION_FILL, ls: CAP_LS, content: l2, sx: addrSx(l2) }));

  let floorEnd = cityEnd;
  if (d.floor) {
    const sepX = Math.round(cityEnd + 34);
    const iconX = sepX + 36;
    const fx = iconX + 81;
    const fMain = d.floor.toUpperCase();
    items.push(`<rect x="${sepX}" y="1124" width="1.6" height="56" fill="${GOLD}" fill-opacity="0.5"/>`);
    ink.rect("floorIcon", iconX, 1133, 46, 46);
    items.push(layersIcon(iconX, 1133, 46, GOLD));
    items.push(ink.text("floor", { x: fx, y: 1146, size: sizeForCap(19), font: FONT.strong, fill: "#ffffff", ls: 1.2, content: fMain }));
    items.push(ink.text("floorLabel", { x: fx + 1, y: 1170, size: CAP_SIZE, font: FONT.caption, fill: CAPTION_FILL, ls: 6, content: "ЭТАЖ" }));
    floorEnd = fx + Math.max(measureCoverText(fMain, sizeForCap(19), 1.2, FONT.strong.metrics), measureCoverText("ЭТАЖ", CAP_SIZE, 6, FONT.caption.metrics));
  }

  const [s1, s2] = splitSlogan();
  const dashW = 46;
  const dashGap = 20;
  let sSize = 19;
  let sLs = 3;
  const widest = (): number => Math.max(measureCoverText(s1, sSize, sLs, "Medium"), measureCoverText(s2, sSize, sLs, "Medium"));
  while (sSize > 13.5 && R - widest() - dashGap - dashW < floorEnd + 12) {
    sSize -= 0.5;
    sLs = Math.max(1.5, sLs - 0.15);
  }
  const w1 = measureCoverText(s1, sSize, sLs, "Medium");
  items.push(ink.text("slogan1", { x: R, y: 1157, size: sSize, font: FONT.caption, fill: CAPTION_FILL, anchor: "end", ls: sLs, content: s1 }));
  items.push(ink.text("slogan2", { x: R, y: 1180, size: sSize, font: FONT.caption, fill: CAPTION_FILL, anchor: "end", ls: sLs, content: s2 }));
  items.push(`<rect x="${num(R - w1 - dashGap - dashW)}" y="1150" width="${dashW}" height="1.6" fill="${GOLD}" fill-opacity="0.9"/>`);

  // Затемнение: 135° наложение из `spec.json` на весь кадр и нижняя лента от
  // верха информационного блока — белые подписи должны лежать на тёмном там,
  // где они реально стоят, а не на фиксированной доле высоты кадра.
  // Мягкая тёмная подушка под эмблемой: на светлом потолке (частый случай у
  // готовых квартир) золотая подпись без неё растворяется в фото.
  const shade =
    overlay(w, h, blockTop + BLOCK_BOX.height * kBlock * 0.25) +
    `
`;

  const group = (t: GroupTransform, body: string[]): string =>
    `<g transform="translate(${num(t.tx)} ${num(t.ty)}) scale(${num(t.k)})">\n${body.join("\n")}\n</g>`;

  const logoBox = boxes.find((b) => b.id === "logo")!;
  const wordmarkBottom = Math.max(...boxes.filter((b) => b.id.startsWith("wordmark")).map((b) => b.y + b.height));
  const blockBoxes = boxes.filter((b) => b.id !== "logo" && !b.id.startsWith("wordmark"));
  return {
    shadeSvg: svgDoc(w, h, shade),
    textSvg: svgDoc(w, h, `${group(logoT, logoItems)}\n${group(blockT, items)}`),
    logo: { left: Math.round(logoBox.x), top: Math.round(logoBox.y), size: Math.round(logoBox.width) },
    contentTopY: Math.min(...blockBoxes.map((b) => b.y)),
    contentBottomY: Math.max(...blockBoxes.map((b) => b.y + b.height)),
    logoBottomY: wordmarkBottom,
    safeZone: zone,
    inkBoxes: boxes,
  };
}

/** Квадрат и вертикаль строятся одним рисунком, вписанным в безопасную зону
 *  своего формата (`coverSafeZone`). */
export function buildCoverTemplate(d: CoverTemplateData, width: number, height: number): CoverTemplateResult {
  return buildCover(d, width, height);
}
