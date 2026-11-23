// Сборка встроенного шаблона «Royal Green», третья версия (владелец, 21.11.2026: макет
// Reels — `Reels (new).psd`: фото сверху, кремовый градиент, зелёная плашка с золотой
// окантовкой, три преимущества, золотая волна). Источник правды — ЭТОТ файл: правьте его,
// а не собранные SVG. Запуск из apps/api:
//   node assets/cover/templates/royal-green.build.mjs
// Числа — из слоёв PSD (1080×1920). Волна, плашка и значки — PNG-слои из того же PSD
// (`assets/cover/royal-green-parts`), вшиваются в SVG base64. Шрифт макета — Montserrat,
// у нас его нет с таджикскими буквами и метриками, поэтому TT Norms Pro 800/500.
//
// Вертикаль — макет как есть. Квадрат — тот же макет, сдвинутый вверх: верхний блок
// (знак, цена) на `dyTop`, нижний (плашка, ряд, волна) на `dyLow`; фото в полосе сверху
// (`photoBox` в coverRegistry.ts), кремовый градиент рисует сам SVG.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SANS = "TT Norms Pro";
const INK = "#01412f";
const PRICE_INK = "#003d36";

const part = (name) => `data:image/png;base64,${fs.readFileSync(path.join(here, "..", "royal-green-parts", name)).toString("base64")}`;
const logo = `data:image/png;base64,${fs.readFileSync(path.join(here, "..", "royal-green-logo.png")).toString("base64")}`;

const FORMATS = {
  story: { w: 1080, h: 1920, dyTop: 0, dyLow: 0 },
  square: { w: 1080, h: 1080, dyTop: -215, dyLow: -561 },
};

// Прозрачность кремового градиента (смещение от 1012 → доля), снята со слоя «Слой 3» макета.
const FADE = [[0, 0], [40, 0.004], [80, 0.024], [120, 0.067], [160, 0.157], [200, 0.31], [240, 0.52], [280, 0.737], [320, 0.9], [360, 0.98], [400, 1]];
const FADE_H = 568;

function body(k) {
  const { w, h, dyTop: t, dyLow: d } = FORMATS[k];
  const y = (v, dy) => +(v + dy).toFixed(1);
  const fadeTop = y(1012, d);
  const waveTop = y(1513, d);
  return `
<g data-bg="1">
  <rect x="0" y="${y(230, t)}" width="${w}" height="330" fill="url(#haze)"/>
  <rect x="0" y="${fadeTop}" width="${w}" height="${FADE_H}" fill="url(#cream)"/>
  <rect x="0" y="${fadeTop + FADE_H}" width="${w}" height="${Math.max(0, h - fadeTop - FADE_H)}" fill="#f3e6e0"/>
  <image href="${part("footer-wave.png")}" x="0" y="${waveTop}" width="1080" height="407"/>
  <image href="${part("plate.png")}" x="0" y="${y(1261, d)}" width="530" height="144"/>
  <rect x="570" y="${y(1260, d)}" width="5" height="146" fill="#0a4b3a"/>
  <image href="${part("pin.png")}" x="614" y="${y(1297, d)}" width="52" height="72"/>
  <image href="${part("icon-home.png")}" x="90" y="${y(1455, d)}" width="61" height="61"/>
  <image href="${part("icon-diamond.png")}" x="416" y="${y(1454, d)}" width="76" height="62"/>
  <image href="${part("icon-pin-outline.png")}" x="754" y="${y(1455, d)}" width="43" height="61"/>
</g>
<image data-if="vectorLogo" href="${logo}" x="100" y="${y(285, t)}" width="164" height="207" preserveAspectRatio="xMidYMid meet"/>
<g id="price">
  <text x="761" y="${y(400, t)}" text-anchor="middle" font-family="${SANS}" font-size="108" font-weight="500" fill="${PRICE_INK}" filter="url(#glow)" data-fit="450">{{priceNumber}}</text>
  <text x="762" y="${y(445, t)}" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="500" fill="${PRICE_INK}" letter-spacing="5" filter="url(#glow)">СОМОНӢ</text>
</g>
<g id="kind" data-if="kindSub">
  <text x="101" y="${y(1334, d)}" font-family="${SANS}" font-size="57" font-weight="800" fill="#ffffff" data-fit="262">{{kind}}</text>
  <text x="101" y="${y(1378, d)}" font-family="${SANS}" font-size="47" font-weight="800" fill="#ffffff" data-fit="262">{{kindSub}}</text>
</g>
<g id="kindSolo" data-if="kindSolo">
  <text x="101" y="${y(1356, d)}" font-family="${SANS}" font-size="62" font-weight="800" fill="#ffffff" data-fit="262">{{kindSolo}}</text>
</g>
<g id="area">
  <text x="512" y="${y(1353, d)}" text-anchor="end" font-family="${SANS}" font-size="66" font-weight="800" fill="#ffffff" data-fit="138">{{areaBig}}<tspan font-size="50" dx="7">{{areaUnit}}</tspan><tspan font-size="30" dy="-24">{{areaSup}}</tspan></text>
</g>
<g id="location">
  <text x="697" y="${y(1341, d)}" font-family="${SANS}" font-size="31" font-weight="800" fill="${INK}" data-fit="286">{{placeLine}}</text>
</g>
<g id="perks" font-family="${SANS}" font-size="22" font-weight="800" fill="${INK}">
  <text x="167" y="${y(1479, d)}">Банақшагирии</text><text x="167" y="${y(1503, d)}">васеъ</text>
  <text x="508" y="${y(1479, d)}">Сатҳи баланди</text><text x="508" y="${y(1503, d)}">бароҳатӣ</text>
  <text x="815" y="${y(1479, d)}">Ҷойгиршавии</text><text x="815" y="${y(1503, d)}">қулай</text>
</g>`;
}

const defs = `
<defs>
  <linearGradient id="cream" x1="0" y1="0" x2="0" y2="1">
${FADE.map(([o, a]) => `    <stop offset="${(o / FADE_H).toFixed(4)}" stop-color="#f3e6e0" stop-opacity="${a}"/>`).join("\n")}
    <stop offset="1" stop-color="#f3e6e0"/>
  </linearGradient>
  <linearGradient id="haze" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0"/><stop offset="0.3" stop-color="#ffffff" stop-opacity="0.5"/><stop offset="0.7" stop-color="#ffffff" stop-opacity="0.5"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <filter id="glow" x="-10%" y="-20%" width="120%" height="140%"><feDropShadow dx="0" dy="0" stdDeviation="9" flood-color="#ffffff" flood-opacity="0.6"/></filter>
</defs>`;

const header = (fmt) =>
  `<!-- «Royal Green» v3 (макет Reels 21.11.2026), ${fmt}. СОБРАНО royal-green.build.mjs — правьте сборщик, а не этот файл.
     data-if — блок только при наличии поля; data-fit — кегль ужимается до ширины;
     data-bg — фон (страж зоны его не смотрит). -->`;

for (const [k, label] of [["square", "квадрат 1080×1080"], ["story", "вертикаль 1080×1920"]]) {
  const { w, h } = FORMATS[k];
  fs.writeFileSync(
    path.join(here, `royal-green-${k}.svg`),
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n${header(label)}${defs}${body(k)}\n</svg>\n`
  );
}
console.log("royal-green v3: square + story собраны");
