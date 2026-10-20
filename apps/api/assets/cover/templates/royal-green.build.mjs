// Сборка встроенного шаблона «Royal Green», вторая версия (владелец, 29.09.2026:
// «мне не понравилась обложка» — прислал два макета и свой знак).
// Источник правды — ЭТОТ файл: правьте его, а не собранные SVG. Запуск из apps/api:
//   node assets/cover/templates/royal-green.build.mjs
// Числа сняты попиксельно с макетов docs/cover-sources-29-09/reference-square.webp
// (1254 → 1080) и reference-story.webp (941×1672 → 1080×1920). У квадрата и
// вертикали СВОЯ раскладка — на макетах вертикаль не растянутый квадрат.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERIF = "RH Playfair Lining";
const SANS = "TT Norms Pro";

/** Гладкая кромка панели через точки, снятые с макета (Catmull-Rom → кубические кривые). */
function smoothPath(points) {
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const [p1, p2] = [points[i], points[i + 1]];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1.map((n) => n.toFixed(1)).join(" ")} ${c2.map((n) => n.toFixed(1)).join(" ")} ${p2[0]} ${p2[1]}`;
  }
  return d;
}

const L = {
  square: {
    w: 1080,
    h: 1080,
    strip: 345,
    edge: [[0, 195], [327, 440], [357, 482], [515, 740], [640, 835], [770, 880], [1080, 980]],
    logo: { x: 131, y: 56, h: 206 },
    digit: { x: 76, y: 622, size: 338, fit: 330 },
    word: { x: 60, y: 715, size: 106, fit: 470 },
    line: { x: 62, y: 736, w: 254 },
    plate: { x: 57, y: 760, w: 658, h: 165, r: 18 },
    price: { x: 84, y: 905, size: 200, cur: 66, dx: 12, fit: 596, ls: -17, bold: 2.4 },
    row: {
      icon: 56, top: 957, main: 30, sub: 19, big: 48,
      area: { ix: 72, tx: 168, y1: 990, y2: 1027 },
      div1: 357, div2: 688, divTop: 945, divH: 76,
      floor: { ix: 400, tx: 483, y1: 985, y2: 1017, fit: 190 },
      loc: { ix: 737, tx: 810, y1: 985, y2: 1017, y3: 1040, fit: 255 },
    },
  },
  // ВЕРТИКАЛЬ — ДЛЯ СЕТКИ INSTAGRAM (владелец, 02.10.2026): профиль показывает у Reels
  // центр кадра 3:4, строки 240…1679 из 1920. Всё важное — знак, цифра, «ХОНАГА», плашка
  // цены, нижний ряд — собрано в «теле» 1080×1440 по центру (строки 300…1650), а фон
  // (кремовая полоса от самого верха, панель до самого низа, мягкий градиент и золотая
  // линия внизу) идёт на весь кадр 1080×1920. Раскладка — прежняя вертикаль, сжатая по
  // высоте примерно в 0,84 (кегли и ширины как у квадрата), знак по центру полосы.
  story: {
    w: 1080,
    h: 1920,
    strip: 345,
    edge: [[0, 545], [263, 700], [320, 752], [353, 800], [406, 905], [461, 1005], [534, 1105], [635, 1215], [698, 1280], [904, 1405], [1009, 1450], [1080, 1485]],
    logo: { x: 0, y: 290, h: 220 }, // x ставится ниже: знак по центру полосы
    digit: { x: 40, y: 1082, size: 450, fit: 400 },
    word: { x: 48, y: 1218, size: 122, fit: 530 },
    line: { x: 50, y: 1249, w: 300 },
    plate: { x: 55, y: 1298, w: 760, h: 172, r: 20 },
    price: { x: 86, y: 1447, size: 192, cur: 69, dx: 13, fit: 690, ls: -17, bold: 2.4 },
    row: {
      icon: 60, top: 1535, main: 34, sub: 22, big: 62,
      // «²» после «163,2 м» упирался в разделитель: запас у вертикали шире (в квадрате не трогаем).
      areaFitPad: 36,
      area: { ix: 62, tx: 160, y1: 1578, y2: 1616 },
      div1: 357, div2: 705, divTop: 1518, divH: 104,
      floor: { ix: 398, tx: 490, y1: 1569, y2: 1609, fit: 200 },
      loc: { ix: 745, tx: 832, y1: 1569, y2: 1609, y3: 1634, fit: 232 },
    },
    // Ниже блока (после 1680): мягкий глубокий градиент и тонкая золотая линия.
    bottom: { from: 1560, line: 1775 },
  },
};
{
  const { strip, logo } = L.story;
  logo.x = Math.round((strip - Math.round((logo.h * 510) / 642)) / 2);
}

/** Значки в своём боксе 56×56 — масштаб под формат задаёт `scale`. */
const ICON_AREA = `<rect x="1.5" y="1.5" width="53" height="53" rx="2"/><path d="M13 43 L26 30 M13 43 L13 34 M13 43 L22 43 M43 13 L30 26 M43 13 L34 13 M43 13 L43 22"/>`;
const ICON_FLOOR = `<path d="M28 4 L54 17 L28 30 L2 17 Z"/><path d="M8 26 L2 29 L28 42 L54 29 L48 26"/><path d="M8 38 L2 41 L28 54 L54 41 L48 38"/>`;
const ICON_PIN = `<path d="M22 58 C10 43 1 32 1 21.5 A21 21 0 0 1 43 21.5 C43 32 34 43 22 58 Z"/><circle cx="22" cy="21.5" r="7.5"/>`;

function body(k) {
  const c = L[k];
  const r = c.row;
  const s = (r.icon / 56).toFixed(4);
  const panel = `${smoothPath(c.edge)} L${c.w} ${c.h} L0 ${c.h} Z`;
  const logoW = Math.round((c.logo.h * 510) / 642);
  const ph = c.plate;
  return `
<g data-bg="1">
  <rect x="0" y="0" width="${c.strip}" height="${c.h}" fill="url(#strip)"/>
  <rect x="${c.strip - 3}" y="0" width="3" height="${c.h}" fill="#000" opacity="0.06"/>
  <path d="${panel}" fill="url(#panel)"/>${
    c.bottom
      ? `
  <rect x="0" y="${c.bottom.from}" width="${c.w}" height="${c.h - c.bottom.from}" fill="url(#deep)"/>
  <rect x="140" y="${c.bottom.line}" width="${c.w - 280}" height="2" fill="url(#goldLine)"/>`
      : ""
  }
</g>
<image data-if="vectorLogo" href="LOGO_FALLBACK" x="${c.logo.x}" y="${c.logo.y}" width="${logoW}" height="${c.logo.h}" preserveAspectRatio="xMidYMid meet"/>
<g id="rooms" data-if="rooms">
  <text x="${c.digit.x}" y="${c.digit.y}" font-family="${SERIF}" font-size="${c.digit.size}" font-weight="700" fill="url(#gold)" filter="url(#lift)" data-fit="${c.digit.fit}">{{rooms}}</text>
  <text x="${c.word.x}" y="${c.word.y}" font-family="${SERIF}" font-size="${c.word.size}" font-weight="700" fill="url(#cream)" letter-spacing="1" filter="url(#lift)" data-fit="${c.word.fit}">{{roomsWord|upper}}</text>
  <rect x="${c.line.x}" y="${c.line.y}" width="${c.line.w}" height="2" fill="url(#line)"/>
</g>
<g id="price">
  <rect x="${ph.x}" y="${ph.y}" width="${ph.w}" height="${ph.h}" rx="${ph.r}" fill="url(#plate)" filter="url(#plateShadow)"/>
  <rect x="${ph.x + 1}" y="${ph.y + 1}" width="${ph.w - 2}" height="${ph.h - 2}" rx="${ph.r - 1}" fill="none" stroke="#fff8e6" stroke-opacity="0.55" stroke-width="1.5"/>
  <text x="${c.price.x}" y="${c.price.y}" font-family="${SERIF}" font-weight="700" fill="#0b3a2e" data-fit="${c.price.fit}"><tspan font-size="${c.price.size}" letter-spacing="${c.price.ls}" stroke="#0b3a2e" stroke-width="${c.price.bold}" stroke-linejoin="round">{{priceNumber}}</tspan><tspan font-size="${c.price.cur}" dx="${c.price.dx}" dy="-6" letter-spacing="1">{{currency}}</tspan></text>
</g>
<g id="area">
  <g transform="translate(${r.area.ix} ${r.top}) scale(${s})" fill="none" stroke="url(#icon)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${ICON_AREA}</g>
  <text x="${r.area.tx}" y="${r.area.y1}" font-family="${SANS}" font-size="${r.big}" font-weight="800" fill="#ffffff" data-fit="${r.div1 - r.area.tx - (r.areaFitPad ?? 14)}">{{areaNumber}}<tspan font-size="${Math.round(r.big * 0.86)}" dx="${Math.round(r.big * 0.16)}">м</tspan><tspan font-size="${Math.round(r.big * 0.6)}" dy="${-Math.round(r.big * 0.42)}">2</tspan></text>
  <text x="${r.area.tx + 2}" y="${r.area.y2}" font-family="${SANS}" font-size="${r.sub}" font-weight="500" fill="#e9efe9" letter-spacing="${(r.sub * 0.14).toFixed(1)}">МАСОҲАТ</text>
</g>
<rect x="${r.div1}" y="${r.divTop}" width="1.6" height="${r.divH}" fill="#d8c08c" opacity="0.6"/>
<g id="floor" data-if="floor">
  <g transform="translate(${r.floor.ix} ${r.top}) scale(${s})" fill="none" stroke="url(#icon)" stroke-width="2.6" stroke-linejoin="round">${ICON_FLOOR}</g>
  <text x="${r.floor.tx}" y="${r.floor.y1}" font-family="${SANS}" font-size="${r.main}" font-weight="800" fill="#ffffff" data-fit="${r.floor.fit}">{{floor|upper}}</text>
  <text x="${r.floor.tx + 1}" y="${r.floor.y2}" font-family="${SANS}" font-size="${r.sub}" font-weight="500" fill="#e9efe9" letter-spacing="${(r.sub * 0.14).toFixed(1)}">ЭТАЖ</text>
</g>
<rect x="${r.div2}" y="${r.divTop}" width="1.6" height="${r.divH}" fill="#d8c08c" opacity="0.6"/>
<g id="location">
  <g transform="translate(${r.loc.ix} ${r.top - Math.round(r.icon * 0.05)}) scale(${s})" fill="none" stroke="url(#icon)" stroke-width="2.6" stroke-linejoin="round">${ICON_PIN}</g>
  <text x="${r.loc.tx}" y="${r.loc.y1}" font-family="${SANS}" font-size="${r.main}" font-weight="800" fill="#ffffff" data-fit="${r.loc.fit}">{{city|upper}}</text>
  <text x="${r.loc.tx + 1}" y="${r.loc.y2}" font-family="${SANS}" font-size="${r.sub}" font-weight="500" fill="#e9efe9" letter-spacing="${(r.sub * 0.1).toFixed(1)}" data-if="district" data-fit="${r.loc.fit}">РАЙОН: {{district|upper}}</text>
  <text x="${r.loc.tx + 1}" y="${r.loc.y3}" font-family="${SANS}" font-size="${Math.round(r.sub * 0.76)}" font-weight="500" fill="#e9efe9" letter-spacing="1.2" data-if="landmark" data-fit="${r.loc.fit}" data-fit-min="11">ОРИЕНТИР: {{landmark|upper}}</text>
</g>`;
}

const defs = `
<defs>
  <linearGradient id="strip" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#e2d3c4"/><stop offset="0.16" stop-color="#ece3d9"/><stop offset="0.3" stop-color="#f2ede6"/><stop offset="1" stop-color="#f1ebe3"/>
  </linearGradient>
  <linearGradient id="panel" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0" stop-color="#0b3a2e"/><stop offset="0.5" stop-color="#05322a"/><stop offset="1" stop-color="#032a21"/>
  </linearGradient>
  <linearGradient id="gold" x1="0" y1="0" x2="0.3" y2="1">
    <stop offset="0" stop-color="#fbe9c2"/><stop offset="0.35" stop-color="#ecd09a"/><stop offset="0.7" stop-color="#d9b173"/><stop offset="1" stop-color="#c3924f"/>
  </linearGradient>
  <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#f8f1e2"/><stop offset="1" stop-color="#e8d3a8"/>
  </linearGradient>
  <linearGradient id="line" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#e3c68b"/><stop offset="1" stop-color="#e3c68b" stop-opacity="0.75"/>
  </linearGradient>
  <linearGradient id="plate" x1="0" y1="0" x2="0.15" y2="1">
    <stop offset="0" stop-color="#fcf1da"/><stop offset="0.5" stop-color="#f2dcab"/><stop offset="1" stop-color="#e2bb77"/>
  </linearGradient>
  <linearGradient id="icon" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#f1d9a2"/><stop offset="1" stop-color="#d4a960"/>
  </linearGradient>
  <filter id="lift" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.35"/></filter>
  <filter id="plateShadow" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="9" flood-color="#000" flood-opacity="0.3"/></filter>
</defs>`;

/** Градиенты низа кадра — только у вертикали (`bottom` в раскладке); квадрат остаётся прежним байт в байт. */
const bottomDefs = `  <linearGradient id="deep" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#021a14" stop-opacity="0"/><stop offset="0.45" stop-color="#021a14" stop-opacity="0.55"/><stop offset="1" stop-color="#010d0a" stop-opacity="0.92"/>
  </linearGradient>
  <linearGradient id="goldLine" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#e3c68b" stop-opacity="0"/><stop offset="0.5" stop-color="#e3c68b" stop-opacity="0.85"/><stop offset="1" stop-color="#e3c68b" stop-opacity="0"/>
  </linearGradient>
</defs>`;

const header = (fmt) =>
  `<!-- «Royal Green» v2, ${fmt}. СОБРАНО royal-green.build.mjs — правьте сборщик, а не этот файл.
     data-if — блок только при наличии поля; data-fit — кегль ужимается до ширины;
     data-fit-min — меньше этого кегля строка не рисуется; data-bg — фон (страж зоны его не смотрит). -->`;

const logo = fs.readFileSync(path.join(here, "..", "royal-green-logo.png")).toString("base64");
const withLogo = (s) => s.replace("LOGO_FALLBACK", `data:image/png;base64,${logo}`);

for (const [k, label] of [["square", "квадрат 1080×1080"], ["story", "вертикаль 1080×1920"]]) {
  const { w, h } = L[k];
  fs.writeFileSync(
    path.join(here, `royal-green-${k}.svg`),
    withLogo(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${header(label)}${L[k].bottom ? defs.replace(/<\/defs>$/, bottomDefs) : defs}${body(k)}\n</svg>\n`)
  );
}
console.log("royal-green v2: square + story собраны");
