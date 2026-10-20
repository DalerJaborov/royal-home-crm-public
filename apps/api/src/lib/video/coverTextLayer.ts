/**
 * ТЕКСТОВЫЙ СЛОЙ ОБЛОЖКИ CHATGPT — режим OVERLAY (v3, 25.09.2026).
 *
 * Почему: живой прогон v2 на проде — gpt-image-1 системно не пишет кириллицу,
 * таджикские буквы и длинные числа («117000000» вместо 1 700 000, ОНАГА, ЭТАХ,
 * ДУЩАНБЕ, РАИОН). Поэтому модель рисует только ОФОРМЛЕНИЕ (пустые панели в
 * стиле эталона), а весь текст кладём мы — SVG тем же шрифтом TT Norms Pro и
 * тем же рендером (sharp → librsvg → системный fontconfig), что старый шаблон
 * (`coverTemplate.ts`, шрифты `assets/fonts/cover/`).
 *
 * ПАНЕЛИ — НАШИ, по раскладке эталонов (`FIXED_PANELS`, сняты с glass-square.png /
 * glass-story.png). Живой прогон 25.09: рамки от второй модели не находились,
 * а панели модель рисовала прозрачным стеклом не там — поэтому чёрное стекло,
 * золото, кромки, блики и иконки рисует `buildPlatesSvg`, текст ложится в них.
 */
import sharp, { type OverlayOptions } from "sharp";
import { COVER_CAP_HEIGHT, type CoverMetricsWeight } from "./coverMetrics.js";
import { COVER_FONT_FAMILY, measureCoverText } from "./coverTemplate.js";
import { escapeXml } from "./svgText.js";
import type { CoverPosterValues } from "./coverPoster.js";

/** Рамка панели в долях кадра (0..1) и наклон в градусах (минус — против часовой). */
export interface PanelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
}

export interface CoverPanels {
  /** Место большой цифры комнат — нужно, только когда цифру кладём мы. */
  roomsDigit: PanelBox | null;
  roomsWord: PanelBox;
  price: PanelBox;
  area: PanelBox;
  bottom: PanelBox;
}

export type CoverPanelAspect = "square" | "story" | "storyFull";

/** Раскладка эталонов владельца, снятая по пикселям glass-square.png (1254²) и glass-story.png (941×1672). */
export const FIXED_PANELS: Record<CoverPanelAspect, CoverPanels> = {
  square: {
    roomsDigit: { x: 0.14, y: 0.15, w: 0.3, h: 0.3, angle: -6 },
    roomsWord: { x: 0.03, y: 0.45, w: 0.62, h: 0.13, angle: -6 },
    price: { x: 0.03, y: 0.59, w: 0.61, h: 0.2, angle: -3 },
    area: { x: 0.65, y: 0.58, w: 0.32, h: 0.18, angle: -4 },
    bottom: { x: 0.17, y: 0.82, w: 0.66, h: 0.09, angle: 0 },
  },
  story: {
    roomsDigit: { x: 0.12, y: 0.28, w: 0.38, h: 0.2, angle: -6 },
    roomsWord: { x: 0.02, y: 0.49, w: 0.69, h: 0.11, angle: -6 },
    price: { x: 0.03, y: 0.62, w: 0.63, h: 0.15, angle: -3 },
    area: { x: 0.65, y: 0.61, w: 0.32, h: 0.14, angle: -4 },
    bottom: { x: 0.12, y: 0.8, w: 0.76, h: 0.06, angle: 0 },
  },
  // Вертикаль целиком 1080×1920 (фон — настоящее фото, полей нет): та же раскладка,
  // что у тела 1080×1620, пересчитанная с отступом 150 px сверху.
  storyFull: {} as CoverPanels,
};
{
  const toFull = (b: PanelBox): PanelBox => ({ ...b, y: (150 + b.y * 1620) / 1920, h: (b.h * 1620) / 1920 });
  const s = FIXED_PANELS.story;
  FIXED_PANELS.storyFull = {
    roomsDigit: s.roomsDigit ? toFull(s.roomsDigit) : null,
    roomsWord: toFull(s.roomsWord),
    price: toFull(s.price),
    area: toFull(s.area),
    bottom: toFull(s.bottom),
  };
}

// ───────────────────────── вёрстка ─────────────────────────

const INK = "#111111";
const WHITE = "url(#whiteGloss)";
const CAPTION = "#d9d2c3";
const GOLD_GRADIENT = `<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1b8"/><stop offset="0.45" stop-color="#e3b44f"/><stop offset="1" stop-color="#9c6a1c"/></linearGradient>`;
const SHADOW = `<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.55"/></filter>`;
/** Панели эталона: чёрное стекло, золото, стекло — градиенты, блик сверху, тень под панелью. */
const PLATE_DEFS =
  `<linearGradient id="glassDark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3632" stop-opacity="0.92"/><stop offset="0.5" stop-color="#141210" stop-opacity="0.9"/><stop offset="1" stop-color="#050505" stop-opacity="0.94"/></linearGradient>` +
  `<linearGradient id="glassLight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="1" stop-color="#1a1a1a" stop-opacity="0.55"/></linearGradient>` +
  `<linearGradient id="goldPlate" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="#fff3bf"/><stop offset="0.35" stop-color="#f2cf6b"/><stop offset="0.7" stop-color="#d9a441"/><stop offset="1" stop-color="#a8741d"/></linearGradient>` +
  `<linearGradient id="goldEdge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff0b0"/><stop offset="0.5" stop-color="#c8912e"/><stop offset="1" stop-color="#fbe39a"/></linearGradient>` +
  `<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>` +
  `<linearGradient id="whiteGloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#f4f4f4"/><stop offset="1" stop-color="#c9c9c9"/></linearGradient>` +
  `<filter id="plateShadow" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.5"/></filter>`;

const n2 = (v: number): string => (Math.round(v * 100) / 100).toString();

interface Line {
  text: string;
  weight: CoverMetricsWeight;
}

/** Кегль, при котором строка влезает в ширину и её прописные — в высоту. */
export function fitSize(line: Line, maxWidth: number, maxCapHeight: number, ls = 0): number {
  const byHeight = maxCapHeight / COVER_CAP_HEIGHT;
  const widthAt100 = measureCoverText(line.text, 100, 0, line.weight) + Math.max(0, [...line.text].length - 1) * ls;
  const byWidth = widthAt100 > 0 ? (maxWidth / widthAt100) * 100 : byHeight;
  return Math.max(8, Math.min(byHeight, byWidth));
}

function textEl(p: {
  x: number;
  y: number;
  size: number;
  weight: CoverMetricsWeight;
  fill: string;
  content: string;
  anchor?: "start" | "middle" | "end";
  ls?: number;
  stroke?: boolean;
  shadow?: boolean;
}): string {
  const attrs = [
    `x="${n2(p.x)}"`,
    `y="${n2(p.y)}"`,
    `font-family="${COVER_FONT_FAMILY}"`,
    `font-weight="${p.weight === "ExtraBold" ? 800 : 500}"`,
    `font-size="${n2(p.size)}"`,
    `fill="${p.fill}"`,
    p.anchor && p.anchor !== "start" ? `text-anchor="${p.anchor}"` : "",
    p.ls ? `letter-spacing="${n2(p.ls)}"` : "",
    p.stroke ? `stroke="#0b0b0b" stroke-width="${n2(p.size * 0.035)}" paint-order="stroke" stroke-linejoin="round"` : "",
    p.shadow ? `filter="url(#sh)"` : "",
  ].filter(Boolean);
  return `<text ${attrs.join(" ")}>${escapeXml(p.content)}</text>`;
}

function group(box: PanelBox, W: number, H: number, inner: string): string {
  const cx = (box.x + box.w / 2) * W;
  const cy = (box.y + box.h / 2) * H;
  return `<g transform="rotate(${n2(box.angle)} ${n2(cx)} ${n2(cy)})">${inner}</g>`;
}

/** Рамка в пикселях с внутренними полями. */
function px(box: PanelBox, W: number, H: number, padX = 0.08, padY = 0.12) {
  const x = box.x * W;
  const y = box.y * H;
  const w = box.w * W;
  const h = box.h * H;
  return { x: x + w * padX, y: y + h * padY, w: w * (1 - 2 * padX), h: h * (1 - 2 * padY), cx: x + w / 2 };
}

/** Одна панель: тень, заливка, тонкая золотая/светлая кромка, блик на верхней трети. */
function plate(box: PanelBox, W: number, H: number, kind: "dark" | "gold" | "glass"): string {
  const x = box.x * W;
  const y = box.y * H;
  const w = box.w * W;
  const h = box.h * H;
  const rx = Math.min(w, h) * 0.18;
  const fill = kind === "gold" ? "url(#goldPlate)" : kind === "dark" ? "url(#glassDark)" : "url(#glassLight)";
  const stroke = kind === "glass" ? "rgba(255,255,255,0.55)" : "url(#goldEdge)";
  return group(
    box,
    W,
    H,
    `<rect x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" rx="${n2(rx)}" fill="${fill}" stroke="${stroke}" stroke-width="${n2(Math.max(2, h * 0.02))}" filter="url(#plateShadow)"/>` +
      `<rect x="${n2(x + rx * 0.4)}" y="${n2(y + h * 0.04)}" width="${n2(w - rx * 0.8)}" height="${n2(h * 0.38)}" rx="${n2(rx * 0.8)}" fill="url(#gloss)" opacity="${kind === "gold" ? 0.55 : 0.35}"/>`
  );
}

/** Мини-иконки нижнего блока: этажи (три ромба) и геометка — золотом. */
function bottomIcons(box: PanelBox, W: number, H: number, withFloor: boolean): string {
  const x = box.x * W;
  const y = box.y * H;
  const w = box.w * W;
  const h = box.h * H;
  const s = h * 0.42;
  const cy = y + h / 2;
  const icons: string[] = [];
  const half = w / 2;
  if (withFloor) {
    const cx = x + half * 0.16 + 4;
    for (const dy of [-0.32, 0, 0.32]) {
      const yy = cy + dy * s;
      icons.push(`<path d="M${n2(cx - s * 0.6)} ${n2(yy)} L${n2(cx)} ${n2(yy - s * 0.26)} L${n2(cx + s * 0.6)} ${n2(yy)} L${n2(cx)} ${n2(yy + s * 0.26)} Z" fill="none" stroke="url(#goldEdge)" stroke-width="${n2(s * 0.09)}" stroke-linejoin="round"/>`);
    }
    icons.push(`<rect x="${n2(x + half - 1)}" y="${n2(y + h * 0.2)}" width="2" height="${n2(h * 0.6)}" fill="url(#goldEdge)" opacity="0.8"/>`);
  }
  const px0 = withFloor ? x + half + half * 0.16 : x + half / 2 + half * 0.16;
  icons.push(
    `<path d="M${n2(px0)} ${n2(cy + s * 0.62)} C${n2(px0 - s * 0.55)} ${n2(cy + s * 0.05)} ${n2(px0 - s * 0.5)} ${n2(cy - s * 0.6)} ${n2(px0)} ${n2(cy - s * 0.6)} C${n2(px0 + s * 0.5)} ${n2(cy - s * 0.6)} ${n2(px0 + s * 0.55)} ${n2(cy + s * 0.05)} ${n2(px0)} ${n2(cy + s * 0.62)} Z" fill="url(#goldPlate)"/>` +
      `<circle cx="${n2(px0)}" cy="${n2(cy - s * 0.15)}" r="${n2(s * 0.17)}" fill="#1a1a1a"/>`
  );
  return group(box, W, H, icons.join(""));
}

/** Все панели эталона нашим SVG (модель их рисует ненадёжно — живой прогон 25.09). */
export function buildPlatesSvg(W: number, H: number, panels: CoverPanels, withFloor: boolean): string {
  return (
    plate(panels.roomsWord, W, H, "dark") +
    plate(panels.price, W, H, "gold") +
    plate(panels.area, W, H, "dark") +
    plate(panels.bottom, W, H, "dark") +
    bottomIcons(panels.bottom, W, H, withFloor)
  );
}

/**
 * SVG текстового слоя W×H. `drawDigit` — большую цифру комнат рисуем мы
 * (модель её не нарисовала или нарисовала криво).
 */
export function buildTextLayerSvg(
  W: number,
  H: number,
  values: CoverPosterValues,
  panels: CoverPanels,
  drawDigit: boolean,
  fixedFallback: FixedFallbackAspect = "square",
  drawPlates = true
): string {
  const parts: string[] = [];
  if (drawPlates) parts.push(buildPlatesSvg(W, H, panels, !!values.floor));

  // Цифра комнат (если кладём мы) — золотой градиент и тень, как в старом шаблоне.
  if (drawDigit && values.roomsNumber) {
    const box = panels.roomsDigit ?? FIXED_PANELS[fixedFallback].roomsDigit!;
    const r = px(box, W, H, 0.05, 0.05);
    const size = fitSize({ text: values.roomsNumber, weight: "ExtraBold" }, r.w, r.h);
    parts.push(
      group(box, W, H, textEl({ x: r.cx, y: r.y + r.h / 2 + (size * COVER_CAP_HEIGHT) / 2, size, weight: "ExtraBold", fill: "url(#gold)", content: values.roomsNumber, anchor: "middle", shadow: true }))
    );
  }

  // «ХОНАГА» — белый ExtraBold с тёмной обводкой и тенью.
  {
    const r = px(panels.roomsWord, W, H, 0.07, 0.16);
    const word = values.roomsWord.toUpperCase();
    const size = fitSize({ text: word, weight: "ExtraBold" }, r.w, r.h);
    parts.push(group(panels.roomsWord, W, H, textEl({ x: r.cx, y: r.y + r.h / 2 + (size * COVER_CAP_HEIGHT) / 2, size, weight: "ExtraBold", fill: WHITE, content: word, anchor: "middle", stroke: true, shadow: true })));
  }

  // Цена: «НАРХ» мелко сверху слева, число чёрным ExtraBold, «TJS» меньше справа внизу.
  {
    const r = px(panels.price, W, H, 0.06, 0.12);
    const labelSize = fitSize({ text: "НАРХ", weight: "ExtraBold" }, r.w * 0.3, r.h * 0.14);
    const tjsSize = fitSize({ text: "TJS", weight: "ExtraBold" }, r.w * 0.14, r.h * 0.16);
    const tjsW = measureCoverText("TJS", tjsSize, 0, "ExtraBold");
    const numTop = r.y + labelSize * COVER_CAP_HEIGHT * 1.6;
    const numH = r.h - (numTop - r.y);
    const priceSize = fitSize({ text: values.priceNumber, weight: "ExtraBold" }, r.w - tjsW - r.w * 0.04, numH * 0.92);
    const priceW = measureCoverText(values.priceNumber, priceSize, 0, "ExtraBold");
    const baseline = numTop + numH / 2 + (priceSize * COVER_CAP_HEIGHT) / 2;
    const startX = r.x + (r.w - priceW - tjsW - r.w * 0.03) / 2;
    parts.push(
      group(
        panels.price,
        W,
        H,
        textEl({ x: startX, y: r.y + labelSize * COVER_CAP_HEIGHT, size: labelSize, weight: "ExtraBold", fill: INK, content: "НАРХ", ls: labelSize * 0.05 }) +
          textEl({ x: startX, y: baseline, size: priceSize, weight: "ExtraBold", fill: INK, content: values.priceNumber }) +
          textEl({ x: startX + priceW + r.w * 0.03, y: baseline, size: tjsSize, weight: "ExtraBold", fill: INK, content: "TJS" })
      )
    );
  }

  // Площадь: «МАСОҲАТ» сверху, число белым, «М²» рядом.
  {
    const r = px(panels.area, W, H, 0.08, 0.12);
    const labelSize = fitSize({ text: "МАСОҲАТ", weight: "ExtraBold" }, r.w * 0.7, r.h * 0.13);
    const unitSize = fitSize({ text: "М²", weight: "ExtraBold" }, r.w * 0.22, r.h * 0.2);
    const unitW = measureCoverText("М²", unitSize, 0, "ExtraBold");
    const numTop = r.y + labelSize * COVER_CAP_HEIGHT * 1.7;
    const numH = r.h - (numTop - r.y);
    const areaSize = fitSize({ text: values.areaNumber, weight: "ExtraBold" }, (r.w - unitW - r.w * 0.08) * 0.9, numH * 0.9);
    const areaW = measureCoverText(values.areaNumber, areaSize, 0, "ExtraBold");
    const baseline = numTop + numH / 2 + (areaSize * COVER_CAP_HEIGHT) / 2;
    const startX = r.cx - (areaW + unitW + r.w * 0.07) / 2;
    parts.push(
      group(
        panels.area,
        W,
        H,
        textEl({ x: r.cx, y: r.y + labelSize * COVER_CAP_HEIGHT, size: labelSize, weight: "ExtraBold", fill: WHITE, content: "МАСОҲАТ", anchor: "middle", ls: labelSize * 0.05 }) +
          textEl({ x: startX, y: baseline, size: areaSize, weight: "ExtraBold", fill: WHITE, content: values.areaNumber, stroke: true, shadow: true }) +
          textEl({ x: startX + areaW + r.w * 0.07, y: baseline, size: unitSize, weight: "ExtraBold", fill: WHITE, content: "М²" })
      )
    );
  }

  // Нижний ряд: слева этаж (место под иконку этажей — модель), справа город и район (иконка геометки).
  {
    const box = panels.bottom;
    const r = px(box, W, H, 0.03, 0.14);
    const half = r.w / 2;
    const cell = (x0: number, top: string, bottom: string) => {
      const textX = x0 + half * 0.3; // левые 30 % половины — иконка модели
      const maxW = half * 0.66;
      const topSize = fitSize({ text: top, weight: "ExtraBold" }, maxW, r.h * 0.36);
      const botSize = fitSize({ text: bottom, weight: "Medium" }, maxW, r.h * 0.24);
      return (
        textEl({ x: textX, y: r.y + r.h * 0.45, size: topSize, weight: "ExtraBold", fill: WHITE, content: top }) +
        textEl({ x: textX, y: r.y + r.h * 0.92, size: botSize, weight: "Medium", fill: CAPTION, content: bottom, ls: botSize * 0.06 })
      );
    };
    const left = values.floor ? cell(r.x, values.floor.toUpperCase(), "ЭТАЖ") : "";
    const right = cell(values.floor ? r.x + half : r.x + half / 2, values.city.toUpperCase(), values.district ? `РАЙОН: ${values.district.toUpperCase()}` : "");
    parts.push(group(box, W, H, left + right));
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"><defs>${GOLD_GRADIENT}${SHADOW}${PLATE_DEFS}</defs>${parts.join("")}</svg>`;
}

export type FixedFallbackAspect = CoverPanelAspect;

/**
 * Подложка из НАСТОЯЩЕГО фото (режим фото ORIGINAL, живой прогон 25.09): gpt-image-1
 * при правке фото перерисовывает комнату (пропадала люстра, менялся ракурс и цвет),
 * а правило владельца — «фото не менять». Здесь только кадрирование, лёгкий контраст
 * и мягкое затемнение нижней части под панели. `digit` — объёмная цифра от ChatGPT
 * (прозрачный PNG), кладётся в рамку цифры с наклоном панели.
 */
export async function originalPhotoBase(photo: Buffer, W: number, H: number, digit: Buffer | null, aspect: CoverPanelAspect): Promise<Buffer> {
  // Тёплый кинематографичный тон эталона — мягко, без перекраски: насыщенность,
  // контраст и полупрозрачная тёплая заливка в режиме soft-light.
  const graded = await sharp(photo).rotate().resize(W, H, { fit: "cover", position: "centre" }).modulate({ saturation: 1.1, brightness: 1.02 }).linear(1.08, -10).png().toBuffer();
  const warm = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#ffb060" fill-opacity="0.35"/></svg>`);
  const base = await sharp(graded).composite([{ input: warm, blend: "soft-light" }]).png().toBuffer();
  const shade = Buffer.from(
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="d" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000" stop-opacity="0.25"/><stop offset="0.35" stop-color="#000" stop-opacity="0.05"/><stop offset="1" stop-color="#000" stop-opacity="0.6"/>` +
      `</linearGradient><radialGradient id="v" cx="0.5" cy="0.45" r="0.75"><stop offset="0.6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></radialGradient>` +
      `</defs><rect width="${W}" height="${H}" fill="url(#d)"/><rect width="${W}" height="${H}" fill="url(#v)"/></svg>`
  );
  const layers: OverlayOptions[] = [{ input: shade, left: 0, top: 0 }];
  if (digit) {
    const box = FIXED_PANELS[aspect].roomsDigit!;
    // Цифра эталона огромная и заходит низом на плашку «ХОНАГА».
    const bw = Math.round(box.w * W * 1.35);
    const bh = Math.round(box.h * H * 1.45);
    const sprite = await sharp(await sharp(digit).trim().rotate(box.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer())
      .resize(bw, bh, { fit: "inside" })
      .png()
      .toBuffer();
    const meta = await sharp(sprite).metadata();
    const left = Math.round((box.x + box.w / 2) * W - (meta.width ?? bw) / 2);
    const top = Math.round((box.y + box.h) * H - (meta.height ?? bh) + box.h * H * 0.2);
    layers.push({ input: sprite, left: Math.max(0, left), top: Math.max(0, top) });
  }
  return sharp(base).composite(layers).png().toBuffer();
}

/** Картинка модели (без текста) → та же картинка W×H с нашим текстом. */
export async function overlayCoverText(
  image: Buffer,
  W: number,
  H: number,
  values: CoverPosterValues,
  panels: CoverPanels,
  drawDigit: boolean,
  aspect: CoverPanelAspect
): Promise<Buffer> {
  const base = await sharp(image).resize(W, H, { fit: "cover" }).png().toBuffer();
  const svg = buildTextLayerSvg(W, H, values, panels, drawDigit, aspect);
  return sharp(base).composite([{ input: Buffer.from(svg), left: 0, top: 0 }]).png().toBuffer();
}
