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
import { reelsCaptionValuesFromProperty, CONTACT_NUMBERS, type ReelsCaptionValues } from "../reelsCaptionTemplate.js";
import { loadMoneyContext } from "../money.js";
import { escapeXml, textWidth, wrapText, fitFontSize } from "./svgText.js";

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

/** Факты карточки — строки, которых нет для пустых полей просто не будет,
 *  тот же принцип, что и в шаблонах подписи Reels (fillReelsCaptionTemplate):
 *  дыры вида «Этаж: » на картинке быть не должно. */
function buildFactLines(values: ReelsCaptionValues): string[] {
  const lines: string[] = [];
  if (values.district) lines.push(values.district);
  const roomsArea = [
    values.rooms ? `${values.rooms}-комн.` : null,
    values.areaSqm ? `${values.areaSqm} м²` : null,
  ].filter(Boolean);
  if (roomsArea.length) lines.push(roomsArea.join(" · "));
  if (values.floor && values.totalFloors) lines.push(`Этаж ${values.floor} из ${values.totalFloors}`);
  return lines;
}

/**
 * `priceWasText` — старая цена (21.09.2026, история «цена снижена»,
 * lib/publishedListingSync.ts + lib/instagramStories.ts::publishPropertyPriceDropStory),
 * отформатированная ТЕМ ЖЕ способом, что и `values.price` (buildPriceDisplay —
 * см. вызывающий код, второй форматтер цены здесь заводить незачем). Когда
 * задана, над ценой рисуется плашка «Цена снижена» и сама старая цена —
 * приглушённым цветом и зачёркнутой (line-through не поддерживается pango в
 * этой сборке librsvg предсказуемо, поэтому черта — отдельная линия <line>,
 * а не text-decoration).
 */
/** Координаты текстового блока для теста «не выходит за безопасные поля» —
 *  без него тест был бы вынужден парсить сгенерированный SVG. */
export interface StoryCardTextLayout {
  /** Y самой верхней отрисованной строки (с учётом ascent) — должна быть
   *  не выше SAFE_TOP_PX. */
  topY: number;
  /** Y базовой линии самой нижней строки — должна быть не ниже
   *  STORY_CARD_HEIGHT - SAFE_BOTTOM_PX. */
  bottomY: number;
}

/**
 * ПЕЧАТЬ «ПРОДАНО» (21.09.2026, владелец: «типа печать поставить типа продано,
 * как в других компаниях делают»).
 *
 * Рисуется поверх фото и НЕЗАВИСИМО от текстового блока: у текста координаты
 * плавают (блок прижимается к нижней безопасной границе и растёт вверх от числа
 * строк), а печать всегда в одном месте — иначе на объекте с длинным названием
 * района она наезжала бы на цену. Центр выбран в верхней трети под верхней
 * безопасной зоной: ниже аватара и индикаторов Instagram, выше любой возможной
 * высоты текстового блока.
 *
 * Наклон и двойная рамка — чтобы читалось именно как оттиск, а не как элемент
 * интерфейса. Полупрозрачная тёмная подложка внутри рамки: без неё красный
 * контур терялся на кирпичных и закатных фото (та же беда, из-за которой под
 * текстом усилили градиент).
 */
export const SOLD_STAMP_TEXT = "ПРОДАНО";
const SOLD_STAMP_CENTER_Y = 700;
const SOLD_STAMP_ANGLE_DEG = -11;

function buildSoldStampSvg(): string {
  const fontSize = 96;
  const letterSpacing = 8;
  const textW = textWidth(SOLD_STAMP_TEXT, fontSize, true) + letterSpacing * (SOLD_STAMP_TEXT.length - 1);
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
    <text x="${STORY_CARD_WIDTH / 2}" y="${SOLD_STAMP_CENTER_Y + fontSize * 0.35}" text-anchor="middle"
      font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="${letterSpacing}"
      fill="#ff3b30">${SOLD_STAMP_TEXT}</text>
  </g>`;
}

function buildSvgOverlay(
  values: ReelsCaptionValues,
  number: string,
  priceWasText?: string | null,
  soldStamp = false
): { svg: string; layout: StoryCardTextLayout } {
  const maxWidth = STORY_CARD_WIDTH - SIDE_MARGIN_PX * 2;

  // --- Факты (район / комнаты+площадь / этаж) — с переносом длинных строк.
  const factFontSize = 42;
  const factLineHeight = 56;
  const rawFacts = buildFactLines(values);
  const factLines = rawFacts.flatMap((line) => wrapText(line, factFontSize, true, maxWidth));

  const factsSvg = factLines
    .map(
      (line, i) =>
        `<text x="${SIDE_MARGIN_PX}" y="${i * factLineHeight}" font-family="DejaVu Sans, sans-serif" font-size="${factFontSize}" ` +
        `font-weight="700" fill="#ffffff">${escapeXml(line)}</text>`
    )
    .join("\n");

  // cursor — локальная система координат (0 = базовая линия первой строки
  // фактов); в канвасные координаты весь блок переводится один раз, сдвигом
  // offset ниже, так чтобы последняя строка легла на безопасную границу.
  let cursor = factLines.length * factLineHeight + 90;

  let priceDropSvg = "";
  if (priceWasText) {
    const badgeFontSize = 30;
    const wasFontSize = fitFontSize(priceWasText, 38, 24, false, maxWidth);
    const badgeY = cursor - 46;
    const wasY = cursor;
    const wasWidth = textWidth(priceWasText, wasFontSize, false);
    priceDropSvg = `
  <text x="${SIDE_MARGIN_PX}" y="${badgeY}" font-family="DejaVu Sans, sans-serif" font-size="${badgeFontSize}" font-weight="700"
    fill="#ff5a5f">ЦЕНА СНИЖЕНА</text>
  <text x="${SIDE_MARGIN_PX}" y="${wasY}" font-family="DejaVu Sans, sans-serif" font-size="${wasFontSize}" font-weight="400"
    fill="#b3b3b3">${escapeXml(priceWasText)}</text>
  <line x1="${SIDE_MARGIN_PX - 4}" y1="${wasY - 13}" x2="${SIDE_MARGIN_PX + wasWidth}" y2="${wasY - 13}" stroke="#b3b3b3" stroke-width="3" />`;
    cursor += 66;
  }

  // --- Цена: сначала уменьшением кегля (76 -> 46) пробуем влезть в одну
  // строку, и только если совсем не влезает (обе валюты сразу) — переносим.
  const priceMaxFont = 76;
  const priceMinFont = 46;
  const priceFontSize = fitFontSize(values.price, priceMaxFont, priceMinFont, true, maxWidth);
  const priceLines =
    textWidth(values.price, priceFontSize, true) > maxWidth
      ? wrapText(values.price, priceFontSize, true, maxWidth)
      : [values.price];
  const priceLineHeight = Math.round(priceFontSize * 1.1);

  const priceSvg = priceLines
    .map((line, i) => {
      const y = cursor + i * priceLineHeight;
      return `<text x="${SIDE_MARGIN_PX}" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="${priceFontSize}" font-weight="700"
    fill="#ffffff">${escapeXml(line)}</text>`;
    })
    .join("\n");
  const priceBottomY = cursor + (priceLines.length - 1) * priceLineHeight;

  // --- Номер объекта + телефон(ы) — тоже может не влезть в одну строку.
  const numberText = `${number} · ${CONTACT_NUMBERS}`;
  const numberMaxFont = 34;
  const numberMinFont = 24;
  const numberFontSize = fitFontSize(numberText, numberMaxFont, numberMinFont, false, maxWidth);
  const numberLines =
    textWidth(numberText, numberFontSize, false) > maxWidth
      ? wrapText(numberText, numberFontSize, false, maxWidth)
      : [numberText];
  const numberLineHeight = Math.round(numberFontSize * 1.2);
  const numberStartY = priceBottomY + 70;
  const numberSvg = numberLines
    .map((line, i) => {
      const y = numberStartY + i * numberLineHeight;
      return `<text x="${SIDE_MARGIN_PX}" y="${y}" font-family="DejaVu Sans, sans-serif" font-size="${numberFontSize}" font-weight="400"
    fill="#e5e5e5">${escapeXml(line)}</text>`;
    })
    .join("\n");
  const numberBottomY = numberStartY + (numberLines.length - 1) * numberLineHeight;

  // --- Сдвигаем весь локальный блок так, чтобы последняя строка (номер
  // объекта/телефон) легла ровно на нижнюю границу безопасной зоны.
  // -18: y текста — это БАЗОВАЯ ЛИНИЯ, а не нижний край чернил; у некоторых
  // глифов (скобки, засечки) чернила уходят на несколько px ниже неё. Без
  // запаса самая нижняя строка формально проходила бы проверку безопасной
  // зоны, но на глаз чуть задевала бы границу.
  const safeBottomY = STORY_CARD_HEIGHT - SAFE_BOTTOM_PX - 18;
  const offset = safeBottomY - numberBottomY;
  const topY = offset - factFontSize; // запас на восходящую часть первой буквы (ascent)
  const bottomY = numberBottomY + offset;

  // Подложка под текстом — усиленный градиент (было 0→0.82 линейно от
  // фиксированной высоты 640px; теперь темнее у самого низа и начинается от
  // реальной высоты текстового блока, а не магического числа) — на светлых
  // фото текст раньше терялся, решение владельца 21.09.2026.
  const shadeTop = Math.max(SAFE_TOP_PX, topY - 120);
  const shadeHeight = STORY_CARD_HEIGHT - shadeTop;

  const svg = `<svg width="${STORY_CARD_WIDTH}" height="${STORY_CARD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0.1" />
      <stop offset="35%" stop-color="#000000" stop-opacity="0.55" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0.9" />
    </linearGradient>
  </defs>
  <rect x="0" y="${shadeTop}" width="${STORY_CARD_WIDTH}" height="${shadeHeight}" fill="url(#shade)" />
  ${soldStamp ? buildSoldStampSvg() : ""}
  <g transform="translate(0, ${offset})">
    ${factsSvg}
    ${priceDropSvg}
    ${priceSvg}
    ${numberSvg}
  </g>
</svg>`;

  return { svg, layout: { topY, bottomY } };
}

/** Обёртка для тестов: собранный SVG-слой без похода в БД и sharp — растровое
 *  сравнение картинок в проекте никто не гоняет, поэтому наличие печати
 *  проверяется по слою. */
export function buildStoryCardOverlaySvg(
  values: ReelsCaptionValues,
  number: string,
  options?: { priceWasText?: string | null; soldStamp?: boolean }
): string {
  return buildSvgOverlay(values, number, options?.priceWasText, options?.soldStamp ?? false).svg;
}

/** Обёртка для тестов: считает координаты текстового блока (безопасные поля)
 *  без похода в БД/sharp — сам SVG для этой цели не нужен, только layout. */
export function computeStoryCardTextLayout(
  values: ReelsCaptionValues,
  number: string,
  priceWasText?: string | null
): StoryCardTextLayout {
  return buildSvgOverlay(values, number, priceWasText).layout;
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
  const overlay = buildSvgOverlay(values, propertyNumber(property.shortId), options?.priceWasText, soldStamp);

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
