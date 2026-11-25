/**
 * КАРТОЧКА ОБЪЕКТА ДЛЯ ИСТОРИЙ INSTAGRAM (решение владельца 21.09.2026).
 *
 * Ролик монтажёр делает не для каждого объекта — очередь «строго по одному»
 * (lib/videoHandoff.ts) физически не успевает за темпом добавления объектов.
 * Фотографии есть ВСЕГДА (MIN_PROPERTY_PHOTOS, lib/propertyPipeline.ts) —
 * значит статичной карточкой можно закрыть публикацию любого объекта, пока
 * ролика ещё нет или не будет вовсе.
 *
 * ГРАНИЦА: этот модуль рисует картинку и только её. Публикация в истории —
 * отдельная задача (`publishInstagramStory` в lib/socialPublish.ts, ветка
 * feat/instagram-stories параллельного агента) — сюда не лезем.
 *
 * ФАКТЫ БЕРУТСЯ ИЗ ТОГО ЖЕ МЕСТА, ЧТО И ПОДПИСЬ REELS
 * (reelsCaptionValuesFromProperty, lib/reelsCaptionTemplate.ts) — цена,
 * район, этаж форматируются один раз для обоих форматов публикации. Второго
 * форматтера цены/этажа здесь нет и быть не должно.
 *
 * ШРИФТ — ГЛАВНЫЙ РИСК ЗАДАЧИ. sharp рисует SVG-текст через librsvg/pango,
 * а те берут шрифты из системного fontconfig. `fontconfig` и файлы шрифтов
 * были УДАЛЕНЫ из рантайм-образа 04.09.2026 вместе с автомонтажом (drawtext/
 * libass в старом lib/video/*.ts, см. apps/api/Dockerfile) — на проде их
 * сейчас нет вовсе, и без вмешательства кириллический текст карточки вышел
 * бы прямоугольниками-заглушками, а сборка и тесты этого не увидят (растровое
 * сравнение никто не гоняет). Возвращены этим PR: `fontconfig` +
 * `fonts-dejavu-core` (DejaVu Sans — полное покрытие кириллицы, легче Noto).
 * Проверено живым рендером на реальном фото, файл-пример приложен к PR —
 * см. docs/story-card-sample.md.
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { prisma } from "../../db.js";
import { uploadsDir } from "../../upload.js";
import { logSystemError } from "../systemError.js";
import { propertyPriceTjs } from "@royal-home/shared";
import { reelsCaptionValuesFromProperty, type ReelsCaptionValues } from "../reelsCaptionTemplate.js";
import { loadMoneyContext, loadUsdRateInfo } from "../money.js";
import { escapeXml } from "./svgText.js";
import { STORY_ADVANCE, STORY_CAP_HEIGHT, type StoryFontWeight } from "./storyMetrics.js";

export const STORY_CARD_WIDTH = 1080;
export const STORY_CARD_HEIGHT = 1920;

/**
 * БЕЗОПАСНЫЕ ПОЛЯ INSTAGRAM STORIES (проверено 21.09.2026 по просьбе владельца
 * «проверь в интернете безопасную зону, чтобы надписи не уходили за окна»).
 *
 * Официальные страницы Meta Business Help — «About text overlays and the Safe
 * Zone for ads in Stories and Reels» (facebook.com/business/help/980593475366490)
 * и «Design Specifications for Stories Ads» (facebook.com/business/help/188477725155524) —
 * отдают через автоматическое чтение только пустую JS-заготовку без текста, живым
 * WebFetch их не прочитать. Числа ниже — пересечение независимых пересказов ЭТИХ
 * же официальных страниц в нескольких источниках 2026 года (сверка нескольких —
 * потому что ни один по отдельности не назван авторитетным):
 *   - сверху 250 px (~14% высоты) — сходится ВО ВСЕХ найденных источниках, это
 *     аватар/имя аккаунта/индикаторы прогресса вверху экрана;
 *   - снизу разброс 340-672 px (18-35%) — источники расходятся сильнее, потому
 *     что мартовское обновление 2026 объединило безопасную зону Историй и Reels
 *     и подняло нижнюю границу под кнопку CTA/поле «Отправить сообщение»/ряд
 *     реакций. Рекламные размещения (там же встречается верхняя граница
 *     диапазона, 672 px) добавляют ещё и надпись «Спонсировано» — у обычной
 *     (не рекламной) истории Royal Home её нет, поэтому берём НЕ верхнюю
 *     границу диапазона, а значение выше типичного «обычного» (340 px) с
 *     запасом под вырезы и панель жестов на телефонах без физической кнопки
 *     Home — 420 px. Если Meta опубликует официальную цифру, которую получится
 *     прочитать напрямую, — сузить не раньше, чем страница откроется читаемой.
 *   Источники (третьи стороны, пересказывающие одну и ту же официальную
 *   страницу — блоги-подрядчики годятся только как подтверждение, не как
 *   первоисточник):
 *     https://adlibrary.com/posts/instagram-story-specs
 *     https://www.1clickreport.com/blog/meta-ads-creative-safe-zones-2026-guide
 *     https://www.firstpier.com/resources/instagram-ad-safe-zones
 *     https://billo.app/blog/meta-ads-safe-zones/
 *   Рекламные и обычные истории (не-ad Stories/Reels) используют, по этим же
 *   источникам, ОДНУ безопасную зону с марта 2026 — Meta объединила их; отдельного,
 *   более узкого поля для органических историй в найденных материалах нет.
 *   На телефонах с вырезом/чёлкой само приложение Instagram уже учитывает вырез
 *   при позиционировании своего интерфейса (аватар/поле ввода не залезают под
 *   вырез) — дополнительный отступ сверх безопасной зоны ниже не нужен, вырез
 *   не отъедает дополнительных пикселей у 1080x1920 холста.
 *   Боковые поля 6% (~65 px) — совпадают во всех источниках.
 */
export const SAFE_TOP_PX = 250;
export const SAFE_BOTTOM_PX = 420;
export const SIDE_MARGIN_PX = 65;

export interface StoryCardResult {
  ok: boolean;
  /** JPEG 1080x1920; null при отказе. */
  image: Buffer | null;
  /** Человеческая причина отказа — уходит в ответ роута. */
  error: string | null;
}

/** Номер объекта на карточке — тот же формат, что и везде в интерфейсе
 *  (`ОБ-${String(shortId).padStart(6, "0")}`, см. web/PultActions.tsx) — не
 *  второй способ его собрать. */
function propertyNumber(shortId: number): string {
  return `ОБ-${String(shortId).padStart(6, "0")}`;
}

/* ==========================================================================
 * ОБЛИК КАРТОЧКИ (25.11.2026, владелец: «история выходит очень некрасивая»).
 *
 * Прежняя карточка — голый белый текст на затемнённом фото шрифтом DejaVu Sans.
 * Теперь — «Royal Clean», язык CRM и сайта: фото во весь экран, белая карточка
 * с мягкой тенью, шрифт Onest (как в интерфейсе), один синий акцент `#1D5FE0`,
 * золото — только в логотипе. Зелёно-золотой постер обложек владелец для историй
 * отверг. Выбор среди макетов A–D — docs/journal/2026-11-25-istoriya-b-bez-ceny.md.
 *
 * ШРИФТ. Onest Medium/SemiBold — статические TTF из OFL-шрифта Google Fonts
 * (assets/fonts/cover/, лицензия OFL-Onest.txt). Dockerfile кладёт ВСЕ `*.ttf`
 * этой папки в системный fontconfig, `tests/coverFonts.ts` подключает её в тестах.
 * Ширины строк считаются по таблице `storyMetrics.ts` (генератор рядом со шрифтами):
 * librsvg размеры текста наружу не отдаёт.
 * ========================================================================== */
const FONT_FAMILY = "Onest";
const BLUE = "#1D5FE0";
const GOLD = "#C9A24B";
const INK = "#0E1726";
const MUTED = "#8A94A6";
const TILE_BG = "#F3F5F8";
const GREEN = "#14803C";
const GREEN_BG = "#E6F6EC";

const CARD_X = 48;
const CARD_W = STORY_CARD_WIDTH - CARD_X * 2;
const CARD_PAD_X = 48;
const CARD_PAD_TOP = 44;
const CARD_PAD_BOTTOM = 44;
const CARD_RADIUS = 48;
/** Нижний край карточки: над полем «Отправить сообщение» (SAFE_BOTTOM_PX) и ещё 20 px запаса. */
const CARD_BOTTOM_Y = STORY_CARD_HEIGHT - SAFE_BOTTOM_PX - 20;
const LOGO_TOP = SAFE_TOP_PX + 12;

/** Ширина строки в px по таблице глифов Onest; неизвестный символ — как «0» (с запасом). */
export function measureStoryText(text: string, size: number, weight: StoryFontWeight = "SemiBold", letterSpacing = 0): number {
  const table = STORY_ADVANCE[weight];
  const chars = [...text];
  let w = 0;
  for (const ch of chars) w += table[ch] ?? table["0"] ?? 600;
  return (w / 1000) * size + Math.max(0, chars.length - 1) * letterSpacing;
}

/** Строка в ширину `maxWidth`: сначала уменьшаем кегль до `minSize`, потом режем по слову с «…». */
function fitStoryText(text: string, size: number, minSize: number, weight: StoryFontWeight, maxWidth: number): { text: string; size: number } {
  let s = size;
  while (s > minSize && measureStoryText(text, s, weight) > maxWidth) s -= 2;
  if (measureStoryText(text, s, weight) <= maxWidth) return { text, size: s };
  const words = text.split(/\s+/);
  while (words.length > 1 && measureStoryText(`${words.join(" ")}…`, s, weight) > maxWidth) words.pop();
  let cut = words.join(" ");
  while (cut.length > 1 && measureStoryText(`${cut}…`, s, weight) > maxWidth) cut = cut.slice(0, -1);
  return { text: `${cut.trimEnd()}…`, size: s };
}

/** Цена на карточке: что рисовать крупно, старая цена и «сколько сэкономили». */
export interface StoryPriceLines {
  /** Крупная строка: «870 000» (сомони числом) или готовый текст цены, если число получить нельзя. */
  now: string;
  /** «TJS» мельче справа от числа; null — валюта уже внутри `now`. */
  currency: string | null;
  /** Старая цена зачёркнутой серой строкой; null — строки нет. */
  was: string | null;
  /** «−20 000» зелёной плашкой рядом со старой ценой; только когда обе цены — числа. */
  saved: string | null;
}

const groupDigits = (n: number): string => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/**
 * Цена карточки. Только сомони и только числом, как на обложках (владелец 21.11.2026: «цена в
 * сомони по нашему курсу»); число — общее `propertyPriceTjs`, его получает вызывающий.
 * Числа нет (доллары без курса в Настройках) — откат на готовый текст цены карточки, как раньше.
 * Старая цена, не выше новой, не рисуется: «цена снижена» без снижения — враньё на картинке.
 */
export function storyPriceLines(input: {
  priceText: string;
  priceNowTjs?: number | null;
  priceWasTjs?: number | null;
  priceWasText?: string | null;
}): StoryPriceLines {
  const nowOk = typeof input.priceNowTjs === "number" && Number.isFinite(input.priceNowTjs) && input.priceNowTjs > 0;
  const wasNum = typeof input.priceWasTjs === "number" && Number.isFinite(input.priceWasTjs) && input.priceWasTjs > 0 ? input.priceWasTjs : null;
  if (nowOk) {
    const now = input.priceNowTjs as number;
    if (wasNum !== null) {
      return wasNum > now
        ? { now: groupDigits(now), currency: "TJS", was: `${groupDigits(wasNum)} TJS`, saved: `−${groupDigits(wasNum - now)}` }
        : { now: groupDigits(now), currency: "TJS", was: null, saved: null };
    }
    return { now: groupDigits(now), currency: "TJS", was: input.priceWasText?.trim() || null, saved: null };
  }
  return { now: input.priceText, currency: null, was: input.priceWasText?.trim() || null, saved: null };
}

interface FactTile {
  value: string;
  label: string;
}

/** Плитки: комнаты, площадь, этаж. Нет поля — нет плитки (участок без этажа не печатает пустоту). */
function buildFactTiles(values: ReelsCaptionValues): FactTile[] {
  const tiles: FactTile[] = [];
  if (values.rooms) tiles.push({ value: String(values.rooms), label: "комн." });
  if (values.areaSqm) tiles.push({ value: String(values.areaSqm).replace(".", ","), label: "м²" });
  if (values.floor) tiles.push({ value: values.totalFloors ? `${values.floor}/${values.totalFloors}` : String(values.floor), label: "этаж" });
  return tiles;
}

/** Координаты текстового блока для теста «не выходит за безопасные поля» — без разбора SVG. */
export interface StoryCardTextLayout {
  /** Самая верхняя отрисованная надпись (логотип) — не выше SAFE_TOP_PX. */
  topY: number;
  /** Нижний край карточки — не ниже STORY_CARD_HEIGHT - SAFE_BOTTOM_PX. */
  bottomY: number;
}

/**
 * ПЕЧАТЬ «ПРОДАНО» (21.09.2026, владелец: «типа печать поставить типа продано, как в других компаниях»).
 * Рисуется поверх фото НЕЗАВИСИМО от карточки и всегда в одном месте (верхняя треть, ниже аватара
 * и индикаторов Instagram, выше карточки). Наклон и двойная рамка — чтобы читалось как оттиск.
 */
export const SOLD_STAMP_TEXT = "ПРОДАНО";
const SOLD_STAMP_CENTER_Y = 700;
const SOLD_STAMP_ANGLE_DEG = -11;

function buildSoldStampSvg(): string {
  const fontSize = 96;
  const letterSpacing = 8;
  const textW = measureStoryText(SOLD_STAMP_TEXT, fontSize, "SemiBold", letterSpacing);
  const padX = 52;
  const padY = 30;
  const boxW = Math.min(textW + padX * 2, STORY_CARD_WIDTH - SIDE_MARGIN_PX * 2);
  const boxH = fontSize + padY * 2;
  const x = (STORY_CARD_WIDTH - boxW) / 2;
  const y = SOLD_STAMP_CENTER_Y - boxH / 2;
  return `
  <g transform="rotate(${SOLD_STAMP_ANGLE_DEG} ${STORY_CARD_WIDTH / 2} ${SOLD_STAMP_CENTER_Y})" opacity="0.92">
    <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="16" fill="#000000" fill-opacity="0.35" />
    <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="16" fill="none" stroke="#ff3b30" stroke-width="9" />
    <rect x="${x + 14}" y="${y + 14}" width="${boxW - 28}" height="${boxH - 28}" rx="8" fill="none" stroke="#ff3b30" stroke-width="3" />
    <text x="${STORY_CARD_WIDTH / 2}" y="${SOLD_STAMP_CENTER_Y + (fontSize * STORY_CAP_HEIGHT) / 2}" text-anchor="middle"
      font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="600" letter-spacing="${letterSpacing}"
      fill="#ff3b30">${SOLD_STAMP_TEXT}</text>
  </g>`;
}

const t = (n: number): string => String(Math.round(n * 10) / 10);

function text(x: number, y: number, size: number, weight: 500 | 600, fill: string, content: string, extra = ""): string {
  return `<text x="${t(x)}" y="${t(y)}" font-family="${FONT_FAMILY}" font-size="${t(size)}" font-weight="${weight}" fill="${fill}"${extra ? ` ${extra}` : ""}>${escapeXml(content)}</text>`;
}

interface StoryCardInput {
  values: ReelsCaptionValues;
  number: string;
  priceWasText?: string | null;
  priceNowTjs?: number | null;
  priceWasTjs?: number | null;
  soldStamp: boolean;
}

/** Логотип-пилюля сверху слева: белая, золотая точка, «ROYAL HOME TJ». */
function buildLogoSvg(): string {
  const size = 26;
  const ls = size * 0.14;
  const textW = measureStoryText("ROYAL HOME TJ", size, "SemiBold", ls);
  const h = 64;
  const w = 28 + 12 + 12 + textW + 28;
  const x = SIDE_MARGIN_PX - 1;
  return `
  <rect x="${x}" y="${LOGO_TOP}" width="${t(w)}" height="${h}" rx="32" fill="#ffffff" fill-opacity="0.94" filter="url(#logoShadow)" />
  <circle cx="${x + 28 + 6}" cy="${LOGO_TOP + h / 2}" r="6" fill="${GOLD}" />
  ${text(x + 28 + 12 + 12, LOGO_TOP + h / 2 + (size * STORY_CAP_HEIGHT) / 2, size, 600, "#1b1b1b", "ROYAL HOME TJ", `letter-spacing="${t(ls)}"`)}`;
}

function buildPinSvg(x: number, cy: number, size: number): string {
  const k = size / 24;
  return `<g transform="translate(${t(x)} ${t(cy - size / 2)}) scale(${t(k)})" fill="none" stroke="${BLUE}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></g>`;
}

function buildSvgOverlay(input: StoryCardInput): { svg: string; layout: StoryCardTextLayout } {
  const { values, number, soldStamp } = input;
  const price = storyPriceLines({
    priceText: values.price,
    priceNowTjs: input.priceNowTjs,
    priceWasTjs: input.priceWasTjs,
    priceWasText: input.priceWasText,
  });
  const tiles = buildFactTiles(values);
  const innerW = CARD_W - CARD_PAD_X * 2;
  const x0 = CARD_X + CARD_PAD_X;
  const cap = STORY_CAP_HEIGHT;
  const dropped = Boolean(price.was) && !soldStamp;

  // ---- Раскладка сверху вниз в локальных координатах (0 = верх карточки); потом сдвиг на CARD_BOTTOM_Y.
  const parts: string[] = [];
  let y = CARD_PAD_TOP;

  // Ряд 1: синяя пилюля «Цена снижена» + номер объекта справа (без пилюли — номер слева).
  const badgeH = 56;
  if (dropped) {
    const badgeSize = 30;
    const bw = measureStoryText("Цена снижена", badgeSize, "SemiBold") + 52;
    parts.push(`<rect x="${x0}" y="${y}" width="${t(bw)}" height="${badgeH}" rx="28" fill="${BLUE}" />`);
    parts.push(text(x0 + 26, y + badgeH / 2 + (badgeSize * cap) / 2, badgeSize, 600, "#ffffff", "Цена снижена"));
    const nw = measureStoryText(number, 28, "Medium");
    parts.push(text(x0 + innerW - nw, y + badgeH / 2 + (28 * cap) / 2, 28, 500, MUTED, number));
  } else {
    parts.push(text(x0, y + badgeH / 2 + (28 * cap) / 2, 28, 500, MUTED, number));
  }
  y += badgeH;

  // Ряд 2: крупная новая цена + «TJS» мельче; кегль сжимается, пока всё не влезет в карточку.
  y += 30;
  const curSizeRatio = 48 / 124;
  let priceSize = 124;
  const priceWidth = (size: number) =>
    measureStoryText(price.now, size, "SemiBold", -size * 0.02) +
    (price.currency ? 24 + measureStoryText(price.currency, size * curSizeRatio, "Medium") : 0);
  while (priceSize > 56 && priceWidth(priceSize) > innerW) priceSize -= 2;
  const priceBase = y + priceSize * cap;
  parts.push(text(x0, priceBase, priceSize, 600, INK, price.now, `letter-spacing="${t(-priceSize * 0.02)}"`));
  if (price.currency) {
    const nowW = measureStoryText(price.now, priceSize, "SemiBold", -priceSize * 0.02);
    parts.push(text(x0 + nowW + 24, priceBase, priceSize * curSizeRatio, 500, MUTED, price.currency));
  }
  y = priceBase;

  // Ряд 3: старая цена зачёркнутой серой + зелёная плашка экономии.
  if (price.was && !soldStamp) {
    const oldSize = 38;
    const oldCapTop = y + 28;
    const oldBase = oldCapTop + oldSize * cap;
    const wasFit = fitStoryText(price.was, oldSize, 26, "Medium", innerW);
    const wasW = measureStoryText(wasFit.text, wasFit.size, "Medium");
    parts.push(text(x0, oldBase, wasFit.size, 500, MUTED, wasFit.text));
    parts.push(`<rect x="${x0 - 4}" y="${t(oldBase - (wasFit.size * cap) / 2 - 2)}" width="${t(wasW + 8)}" height="4" rx="2" fill="${MUTED}" />`);
    let rowBottom = oldBase;
    if (price.saved) {
      const savedSize = 30;
      const sw = measureStoryText(price.saved, savedSize, "SemiBold") + 40;
      const mid = oldCapTop + (oldSize * cap) / 2;
      const sy = mid - 23;
      parts.push(`<rect x="${t(x0 + wasW + 20)}" y="${t(sy)}" width="${t(sw)}" height="46" rx="23" fill="${GREEN_BG}" />`);
      parts.push(text(x0 + wasW + 20 + 20, mid + (savedSize * cap) / 2, savedSize, 600, GREEN, price.saved));
      rowBottom = Math.max(oldBase, sy + 46);
    }
    y = rowBottom;
  }

  // Ряд 4: плитки комнаты / площадь / этаж.
  if (tiles.length > 0) {
    y += 34;
    const gap = 16;
    const tw = (innerW - gap * (tiles.length - 1)) / tiles.length;
    const th = 100;
    tiles.forEach((tile, i) => {
      const tx = x0 + i * (tw + gap);
      const cx = tx + tw / 2;
      const vs = fitStoryText(tile.value, 44, 28, "SemiBold", tw - 24);
      parts.push(`<rect x="${t(tx)}" y="${t(y)}" width="${t(tw)}" height="${th}" rx="24" fill="${TILE_BG}" />`);
      parts.push(text(cx, y + 18 + vs.size * cap, vs.size, 600, INK, vs.text, `text-anchor="middle"`));
      parts.push(text(cx, y + 18 + 44 * cap + 12 + 26 * cap, 26, 500, MUTED, tile.label, `text-anchor="middle"`));
    });
    y += th;
  }

  // Ряд 5: район с синим пином (длинное название сжимается, потом режется).
  if (values.district) {
    y += 28;
    const dsize = 34;
    const fit = fitStoryText(values.district, dsize, 26, "Medium", innerW - 30 - 12);
    const base = y + fit.size * cap;
    parts.push(buildPinSvg(x0, y + (fit.size * cap) / 2, 30));
    parts.push(text(x0 + 30 + 12, base, fit.size, 500, INK, fit.text));
    y = base;
  }

  const cardH = y + CARD_PAD_BOTTOM;
  const cardTop = CARD_BOTTOM_Y - cardH;
  const bottomY = CARD_BOTTOM_Y;
  const topY = LOGO_TOP;

  const svg = `<svg width="${STORY_CARD_WIDTH}" height="${STORY_CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shadeTop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.34" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </linearGradient>
    <linearGradient id="shadeBottom" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.45" />
    </linearGradient>
    <filter id="cardShadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="24" stdDeviation="30" flood-color="#000000" flood-opacity="0.28" />
    </filter>
    <filter id="logoShadow" x="-20%" y="-30%" width="140%" height="190%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000000" flood-opacity="0.18" />
    </filter>
  </defs>
  <rect x="0" y="0" width="${STORY_CARD_WIDTH}" height="${Math.round(STORY_CARD_HEIGHT * 0.22)}" fill="url(#shadeTop)" />
  <rect x="0" y="${Math.round(STORY_CARD_HEIGHT * 0.48)}" width="${STORY_CARD_WIDTH}" height="${STORY_CARD_HEIGHT - Math.round(STORY_CARD_HEIGHT * 0.48)}" fill="url(#shadeBottom)" />
  ${buildLogoSvg()}
  ${soldStamp ? buildSoldStampSvg() : ""}
  <rect x="${CARD_X}" y="${t(cardTop)}" width="${CARD_W}" height="${t(cardH)}" rx="${CARD_RADIUS}" fill="#ffffff" filter="url(#cardShadow)" />
  <g transform="translate(0, ${t(cardTop)})">
    ${parts.join("\n    ")}
  </g>
</svg>`;

  return { svg, layout: { topY, bottomY } };
}

/** Обёртка для тестов: собранный SVG-слой без похода в БД и sharp — растровое сравнение в проекте
 *  не гоняется, поэтому наличие печати, плашек и цены проверяется по слою. */
export function buildStoryCardOverlaySvg(
  values: ReelsCaptionValues,
  number: string,
  options?: { priceWasText?: string | null; soldStamp?: boolean; priceNowTjs?: number | null; priceWasTjs?: number | null }
): string {
  return buildSvgOverlay({ values, number, ...options, soldStamp: options?.soldStamp ?? false }).svg;
}

/** Обёртка для тестов: координаты блока (безопасные поля) без БД и sharp. */
export function computeStoryCardTextLayout(
  values: ReelsCaptionValues,
  number: string,
  priceWasText?: string | null,
  extra?: { priceNowTjs?: number | null; priceWasTjs?: number | null }
): StoryCardTextLayout {
  return buildSvgOverlay({ values, number, priceWasText, ...extra, soldStamp: false }).layout;
}

/** Ставить ли печать: явный флаг вызывающего кода сильнее статуса объекта.
 *  Вынесено отдельно, потому что по готовому JPEG печать никак не проверить —
 *  растровое сравнение картинок в проекте не гоняется. */
export function shouldStampSold(status: string, option?: boolean): boolean {
  return option ?? status === "SOLD";
}

export interface GenerateStoryCardOptions {
  /** Ставить ли печать «ПРОДАНО». По умолчанию (undefined) решается по статусу
   *  самого объекта — так печать появляется и в предпросмотре карточки
   *  (GET /properties/:id/story-card.jpg), без отдельного флага на каждом
   *  вызове. Явное `false` нужно там, где карточка рисуется ДО смены статуса. */
  soldStamp?: boolean;
  /** Старая цена, отформатированная buildPriceDisplay — задать только когда
   *  карточка рисуется для истории «цена снижена» (см. buildSvgOverlay). */
  priceWasText?: string | null;
  /** Старая цена в сомони числом (история «цена снижена»): тогда рисуются «−N» и зачёркнутая «N TJS». */
  priceWasTjs?: number | null;
}

/** Рисует вертикальную карточку 1080x1920 по первому фото объекта. */
export async function generateStoryCard(propertyId: string, options?: GenerateStoryCardOptions): Promise<StoryCardResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { district: true, photos: { orderBy: { order: "asc" }, take: 1 } },
  });
  if (!property || property.deletedAt) {
    return { ok: false, image: null, error: "Объект не найден или удалён" };
  }
  const mainPhoto = property.photos[0];
  if (!mainPhoto) {
    void logSystemError("storage", `Карточка-история объекта ${property.id}: нет ни одной фотографии`, {
      dedupKey: `story-card-no-photo:${property.id}`,
    });
    return { ok: false, image: null, error: "У объекта нет ни одной фотографии — карточку рисовать не из чего" };
  }

  const photoPath = path.join(uploadsDir, path.basename(mainPhoto.url));
  try {
    await fs.access(photoPath);
  } catch {
    void logSystemError("storage", `Карточка-история объекта ${property.id}: файл фото не найден на диске (${photoPath})`, {
      dedupKey: `story-card-missing-file:${property.id}`,
    });
    return { ok: false, image: null, error: "Файл главной фотографии не найден на диске" };
  }

  const money = await loadMoneyContext();
  const values = reelsCaptionValuesFromProperty({
    type: property.type,
    rooms: property.rooms,
    areaSqm: property.areaSqm,
    floor: property.floor,
    totalFloors: property.totalFloors,
    price: property.price,
    currency: property.currency,
    condition: property.condition,
    stage: property.stage ?? null,
    marketType: property.marketType ?? null,
    districtName: property.district?.name ?? "",
    phone: null,
    address: property.address,
    documents: property.documents,
    windowCount: property.windowCount,
    details: property.details,
    money,
  });

  const soldStamp = shouldStampSold(property.status, options?.soldStamp);
  // Цена числом в сомони — курс только из Настроек, без запасного (как у обложек); нет курса — прежний текст цены.
  const usdRate = property.currency === "USD" ? (await loadUsdRateInfo()).rate : null;
  const overlay = buildSvgOverlay({
    values,
    number: propertyNumber(property.shortId),
    priceWasText: options?.priceWasText,
    priceNowTjs: propertyPriceTjs(property.price, property.currency, usdRate),
    priceWasTjs: options?.priceWasTjs,
    soldStamp,
  });

  try {
    const image = await sharp(photoPath)
      .resize({ width: STORY_CARD_WIDTH, height: STORY_CARD_HEIGHT, fit: "cover", position: "centre" })
      .composite([{ input: Buffer.from(overlay.svg), top: 0, left: 0 }])
      .jpeg({ quality: 88 })
      .toBuffer();
    return { ok: true, image, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : "неизвестный сбой";
    void logSystemError("storage", `Карточка-история объекта ${property.id}: отрисовка sharp упала — ${message}`, {
      dedupKey: `story-card-render-fail:${property.id}`,
    });
    return { ok: false, image: null, error: "Не удалось отрисовать карточку" };
  }
}
