/**
 * ОБЛОЖКА ОБЪЕКТА ДЛЯ СОЦСЕТЕЙ (решение владельца 21.09.2026, «AI ART DIRECTOR»
 * бриф в треде обложек) — премиальный постер Royal Home TJ: логотип сверху,
 * крупное число комнат, золотая плашка цены, площадь, этаж, район/ориентир,
 * слоган. Отличается от карточки-истории (`storyCard.ts`) назначением и
 * языком: та рисует подпись поверх фото для истории «Продано»/снижения
 * цены и говорит по-русски (тот же регистр, что подписи Reels), эта —
 * афиша для сетки/обложки Reels/Facebook/Telegram/сайта и говорит на
 * современном таджикском, строго по брифу владельца (раздел 6 брифа:
 * «2 хонага», «890 000 TJS», «90 м²», «15 ошёна» — никаких «сомонӣ»/«$»).
 * Рендерит тем же способом (`sharp` + SVG-оверлей поверх фото, вынесенные
 * помощники текста — `svgText.ts`), чтобы не заводить третий движок рисования
 * картинок в проекте (первый — `ai/coverImage.ts`, Gemini для обложек статей
 * блога; такое сравнение уже делалось при выборе подхода для этой задачи).
 *
 * ТЕКСТ И ЛОГОТИП — ВСЕГДА ДЕТЕРМИНИРОВАННЫЙ SVG-СЛОЙ, НЕ ИИ. Генерация
 * картинки моделью КАЖДЫЙ раз рисует заново — другая толщина букв, другой
 * оттенок золота, другой логотип (см. сравнение в треде обложек,
 * logo-compare.png: даже логотип Gemini перерисовала, хотя бриф это прямо
 * запрещает). Поэтому цифры/цена/подписи/логотип всегда кладутся этим SVG-
 * слоем поверх фото — независимо от того, обработано ли само фото ниже.
 *
 * ФОТО (не текст) МОЖЕТ БЫТЬ ОБРАБОТАНО GEMINI — решение владельца от
 * 21.09.2026 вечером, после того как он увидел первую версию (плоское фото
 * без обработки) и попросил стиль как у его референса. `generateCoverPoster`
 * принимает `style: "gemini"`: тогда перед тем, как наложить SVG, исходное
 * фото прогоняется через `ai/coverPosterStyle.ts` (световая обработка —
 * золотой час, глубина цвета; той же строгой дисциплиной промта, что
 * `ai/photoEnhance.ts`: планировку, предметы и ракурс менять запрещено
 * прямым текстом, а текст/логотип модели рисовать не просят вовсе — это
 * работа SVG-слоя). Стилизация недоступна или упала — тихий откат на
 * необработанное фото, а не отказ всей обложки (`styleApplied` в результате
 * говорит, что фактически произошло). Своя цветокоррекция (`grade`) после
 * Gemini берётся мягкой: модель уже подняла яркость, цвет и тепло по промту,
 * и полный набор поверх неё пересвечивает кадр.
 *
 * ШРИФТ — TT Norms Pro (Medium/Bold/ExtraBold), тот же, что в эталоне
 * владельца; файлы положил владелец, лицензия на серверное встраивание — на
 * нём (см. `assets/fonts/cover/README.md`). Таджикская кириллица (Ғ ғ Ӣ ӣ Қ қ
 * Ӯ ӯ Ҳ ҳ Ҷ ҷ Ё ё) и «²» в файлах есть — проверено по cmap 22.09.2026.
 * Раскладка, цвета, иконки и затемнение — `coverTemplate.ts` (снято замером
 * с эталона), листья — фикс-слой `assets/cover/leaves-*.png`.
 *
 * ЛОГОТИП — берём НАСТОЯЩИЙ загруженный файл (`Settings.companyLogoUrl`,
 * Настройки → Агентство), а не перерисовываем: он уже используется в шапке
 * и на странице входа (`web/src/components/Sidebar.tsx`,
 * `web/src/pages/Login.tsx`). Логотип не задан — постер рисуется без него,
 * а не с картинкой-заглушкой.
 *
 * ГОРОД — везде «Душанбе»: агентство работает только в Душанбе (весь бот и
 * подбор адресов привязаны к городу, отдельного поля City у объекта нет),
 * значит и на обложке город — не поле формы, а константа.
 *
 * ОРИЕНТИР — берём `property.address`: отдельного поля LANDMARK в схеме нет,
 * а `address` в этом проекте и есть ориентир по смыслу («В Душанбе место
 * называют ориентиром» — `ai/cardFill.ts`, `ai/propertyDraft.ts`), заводить
 * второе поле под то же значение незачем.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { propertyFieldShown } from "@royal-home/shared";
import sharp, { type OverlayOptions, type Sharp } from "sharp";
import { prisma } from "../../db.js";
import { uploadsDir } from "../../upload.js";
import { logSystemError } from "../systemError.js";
import { toTjs, loadMoneyContext, type MoneyContext } from "../money.js";
import { buildCoverTemplate, type CoverInkBox, type CoverSafeZone, type CoverTemplateData } from "./coverTemplate.js";
import { applyTemplateValues, isSvgCoverTemplate, type CoverTemplateRecord } from "./coverRegistry.js";
import { stylizeCoverPhotoWithGemini } from "../../ai/coverPosterStyle.js";

export { COVER_FONT_FAMILY } from "./coverTemplate.js";

export const COVER_SQUARE_SIZE = 1080;
export const COVER_STORY_WIDTH = 1080;
export const COVER_STORY_HEIGHT = 1920;

/** Фикс-оверлей листьев по краям кадра — часть стиля шаблона, не генерация
 *  на каждый объект (слой один раз сделан Gemini и «приручён» в узкую полосу
 *  у кромки). Путь от скомпилированного файла, как у `liveVoiceBridge.ts`. */
const COVER_ASSETS_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets", "cover");

/** Квадрат из вертикального фото берём со сдвигом вниз на 10 % — меньше
 *  потолка, больше комнаты (просьба владельца при сверке с эталоном). */
const SQUARE_CROP_SHIFT_DOWN = 0.1;

const CITY_LABEL = "Душанбе";

/** Крупная цифра обложки. Комнаты — любое целое от 1 до 99 (раньше потолок был 9 «по одной цифре
 *  в макете», и у дома с 10 комнатами панель оставалась пустой — владелец 05.10.2026); двузначное
 *  число рисует наш текстовый слой. Нет комнат (участок, коммерция, null, 0) — вместо них крупно
 *  площадь: сотки с подписью «СОТИХ», если они заполнены, иначе квадраты с подписью «КВАДРАТ»
 *  (владелец 05.10.2026: «где нет комнат — квадрат или соток»). */
const ROOMS_WORD = "хонага";
const AREA_WORD = "квадрат";
/** У участка и дома без комнат площадь в Таджикистане называют в сотках (поле карточки `landAreaSotka`). */
const SOTKA_WORD = "сотих";
const MIN_ROOMS_DIGIT = 1;
const MAX_ROOMS_DIGIT = 99;

function hasRoomsDigit(rooms: number | null): rooms is number {
  return rooms != null && Number.isInteger(rooms) && rooms >= MIN_ROOMS_DIGIT && rooms <= MAX_ROOMS_DIGIT;
}

export interface CoverPosterValues {
  /** Крупная цифра обложки: число комнат (heroKind «rooms») или площадь без «м²» (heroKind «area»,
   *  у объекта без комнат). Имя поля историческое — его читают шаблон, слой текста и промты. */
  roomsNumber: string | null;
  /** Подпись под цифрой: «хонага» или «квадрат». */
  roomsWord: string;
  /** Что в крупной цифре: настоящее число комнат или площадь. Проверки «комнат столько-то» — только для «rooms». */
  heroKind: "rooms" | "area";
  /** «890 000 TJS» — полная строка цены (для подписей и проверок брифа). */
  price: string;
  /** Только число цены обычными пробелами — шаблон рисует «TJS» отдельно и мельче. */
  priceNumber: string;
  area: string;
  /** Только число площади — «м²» шаблон рисует отдельно. */
  areaNumber: string;
  floor: string | null;
  city: string;
  district: string | null;
  landmark: string | null;
}

/** Цена — ТОЛЬКО «NNN NNN TJS» (брифа раздел 5: «НЕ используй сомонӣ, сомон,
 *  $, USD, 890K»). Объект в долларах — переводим в сомони по курсу Настроек,
 *  тем же `toTjs`, что уже переводит суммы в отчётах (`lib/money.ts`);
 *  второго курса/форматтера цены заводить незачем. Второй валюты в скобках
 *  на постере, в отличие от подписи Reels (`buildPriceDisplay`), нет —
 *  постер должен читаться за одну секунду, а не нести полную бухгалтерию. */
function priceTjsAmount(price: number | string | { toString(): string }, currency: string, money: MoneyContext): number {
  return Math.round(toTjs(price, currency, money));
}

export function buildCoverPosterValues(property: {
  rooms: number | null;
  areaSqm: number | string | { toString(): string };
  /** Площадь участка в сотках — у участка без комнат вместо квадратов крупно пишем её. */
  landAreaSotka?: number | string | { toString(): string } | null;
  floor: number | null;
  price: number | string | { toString(): string };
  currency: string;
  districtName: string | null;
  address: string | null;
}, money: MoneyContext): CoverPosterValues {
  const withRooms = hasRoomsDigit(property.rooms);
  const amount = priceTjsAmount(property.price, property.currency, money);
  // Дробная площадь — с запятой, как пишут в Таджикистане: «112,5 м²».
  const areaNumber = property.areaSqm.toString().replace(".", ",");
  const areaRounded = Math.round(Number(property.areaSqm.toString()));
  const sotka = property.landAreaSotka != null ? Number(property.landAreaSotka.toString()) : NaN;
  // Сотки: целые как есть, дробные с запятой («6,5»); без комнат это важнее квадратов.
  const heroSotka = !withRooms && Number.isFinite(sotka) && sotka > 0 ? String(Math.round(sotka * 10) / 10).replace(".", ",") : null;
  const heroArea = !withRooms && Number.isFinite(areaRounded) && areaRounded > 0 ? String(areaRounded) : null;
  return {
    roomsNumber: withRooms ? String(property.rooms) : (heroSotka ?? heroArea),
    roomsWord: withRooms ? ROOMS_WORD : heroSotka ? SOTKA_WORD : AREA_WORD,
    heroKind: withRooms ? "rooms" : "area",
    price: `${amount.toLocaleString("ru-RU")} TJS`,
    priceNumber: String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, " "),
    area: `${areaNumber} м²`,
    areaNumber,
    floor: property.floor != null ? `${property.floor} ошёна` : null,
    city: CITY_LABEL,
    district: property.districtName || null,
    landmark: property.address || null,
  };
}
export interface CoverPosterResult {
  ok: boolean;
  image: Buffer | null;
  error: string | null;
  /** Прошло ли фото через световую обработку Gemini (`style: "gemini"` был
   *  запрошен И вызов реально удался) — false и когда стиль не просили, и
   *  когда просили, но Gemini отказал (обложка при этом всё равно рисуется,
   *  просто необработанным фото — см. докстринг модуля). Вызывающий решает,
   *  показывать ли по этому признаку предупреждение. */
  styleApplied: boolean;
}

export type CoverPosterAspect = "square" | "story";
/** "gemini" — прогнать фото через световую обработку перед SVG-слоем
 *  (`ai/coverPosterStyle.ts`); не задано — то же необработанное фото, что и
 *  раньше. Решение владельца 21.09.2026, см. докстринг модуля. */
export type CoverPosterStyle = "gemini";

function aspectSize(aspect: CoverPosterAspect): { width: number; height: number } {
  return aspect === "square"
    ? { width: COVER_SQUARE_SIZE, height: COVER_SQUARE_SIZE }
    : { width: COVER_STORY_WIDTH, height: COVER_STORY_HEIGHT };
}

/**
 * Рисует премиальный постер объекта.
 *
 * `sourceImagePath` — абсолютный путь на диске к фото/кадру-источнику
 * (первая фотография карточки объекта или ffmpeg-кадр из ролика монтажёра,
 * выбор источника — забота вызывающего кода: `videoHandoff.ts` передаёт
 * кадр ролика, предпросмотр из карточки объекта — главное фото). Не задан —
 * берём первое фото объекта тем же способом, что и `storyCard.ts`.
 *
 * `style: "gemini"` — перед наложением SVG прогнать фото через
 * `ai/coverPosterStyle.ts` (см. докстринг модуля выше). Необязательный и
 * необязывающий: Gemini недоступен или ответил отказом — обложка всё равно
 * рисуется, просто на необработанном фото (`result.styleApplied === false`
 * покажет вызывающему, что стилизация не применилась).
 */
export async function generateCoverPoster(
  propertyId: string,
  aspect: CoverPosterAspect,
  sourceImagePath?: string,
  style?: CoverPosterStyle,
  /** Шаблон из реестра (`coverRegistry.ts`). Не задан — встроенный «Royal Gold». */
  template?: CoverTemplateRecord
): Promise<CoverPosterResult> {
  const property = await prisma.property.findUnique({
    where: { id: propertyId },
    include: { district: true, photos: { orderBy: { order: "asc" }, take: 1 } },
  });
  if (!property || property.deletedAt) {
    return { ok: false, image: null, error: "Объект не найден или удалён", styleApplied: false };
  }

  let photoPath = sourceImagePath ?? null;
  if (!photoPath) {
    const mainPhoto = property.photos[0];
    if (!mainPhoto) {
      void logSystemError("storage", `Обложка объекта ${property.id}: нет ни одной фотографии`, {
        dedupKey: `cover-poster-no-photo:${property.id}`,
      });
      return {
        ok: false,
        image: null,
        error: "У объекта нет ни одной фотографии — обложку рисовать не из чего",
        styleApplied: false,
      };
    }
    photoPath = path.join(uploadsDir, path.basename(mainPhoto.url));
  }
  try {
    await fs.access(photoPath);
  } catch {
    void logSystemError("storage", `Обложка объекта ${property.id}: файл-источник не найден на диске (${photoPath})`, {
      dedupKey: `cover-poster-missing-file:${property.id}`,
    });
    return { ok: false, image: null, error: "Файл-источник не найден на диске", styleApplied: false };
  }

  // Световая обработка ДО чтения логотипа/данных объекта намеренно: это
  // самый медленный шаг (~20с, см. ai/coverPosterStyle.ts) и единственный,
  // который может честно не получиться — остальной код ниже не должен ждать
  // его результата дольше, чем нужно, и откат на исходный путь/буфер должен
  // остаться простым — один вариант переменной, а не два места сборки sharp.
  let photoInput: string | Buffer = photoPath;
  let styleApplied = false;
  if (style === "gemini") {
    try {
      const sourceBuffer = await fs.readFile(photoPath);
      const styled = await stylizeCoverPhotoWithGemini(sourceBuffer, photoPath);
      if (styled.ok && styled.image) {
        photoInput = styled.image;
        styleApplied = true;
      }
      // Отказ Gemini НЕ логируется здесь повторно — stylizeCoverPhotoWithGemini
      // уже написал причину в журнал своим logSystemError.
    } catch (err) {
      const message = err instanceof Error ? err.message : "неизвестный сбой";
      void logSystemError("storage", `Обложка объекта ${property.id}: не удалось прочитать фото для Gemini — ${message}`, {
        dedupKey: `cover-poster-style-read-fail:${property.id}`,
      });
      // photoInput остаётся исходным путём — обложка рисуется без стилизации.
    }
  }


  const settings = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { companyLogoUrl: true } });
  const money = await loadMoneyContext();
  const values = buildCoverPosterValues(
    {
      // Этаж на обложке — только у квартиры и коммерции; у дома и участка его нет
      // (propertyTypeFields.ts, владелец 08.10.2026).
      rooms: propertyFieldShown(property.type, "rooms") ? property.rooms : null,
      areaSqm: property.areaSqm,
      landAreaSotka: property.landAreaSotka,
      floor: propertyFieldShown(property.type, "floor") ? property.floor : null,
      price: property.price,
      currency: property.currency,
      districtName: property.district?.name ?? null,
      address: property.address,
    },
    money
  );

  const logoPath = settings?.companyLogoUrl ? path.join(uploadsDir, path.basename(settings.companyLogoUrl)) : null;
  try {
    const image = await renderCoverPosterImage(photoInput, values, aspect, logoPath, styleApplied, template);
    return { ok: true, image, error: null, styleApplied };
  } catch (err) {
    const message = err instanceof Error ? err.message : "неизвестный сбой";
    void logSystemError("storage", `Обложка объекта ${property.id}: отрисовка sharp упала — ${message}`, {
      dedupKey: `cover-poster-render-fail:${property.id}`,
    });
    return { ok: false, image: null, error: "Не удалось отрисовать обложку", styleApplied: false };
  }
}

/**
 * Чистая отрисовка без БД: фото (путь или буфер) + значения → JPEG.
 * Слои снизу вверх: фото → затемнение → листья → текст → настоящий логотип.
 * Бросает исключение при сбое sharp — вызывающий решает, как отказать.
 */
export async function renderCoverPosterImage(
  photoInput: string | Buffer,
  values: CoverPosterValues,
  aspect: CoverPosterAspect,
  logoPath: string | null,
  /** Фото уже прошло световую обработку Gemini — тогда своя цветокоррекция
   *  берётся мягкой, чтобы не класть одно и то же дважды (см. `grade`). */
  styled = false,
  /** Свой шаблон владельца вместо встроенного (`coverRegistry.ts`). */
  template?: CoverTemplateRecord
): Promise<Buffer> {
  const { width, height } = aspectSize(aspect);
  if (template && isSvgCoverTemplate(template)) {
    return renderCustomTemplate(template, photoInput, values, width, height, aspect, styled, logoPath);
  }
  const tpl = buildCoverTemplate(toTemplateData(values), width, height);

  let logoBuffer: Buffer | null = null;
  if (logoPath) {
    try {
      logoBuffer = await sharp(logoPath)
        .resize({ width: tpl.logo.size, height: tpl.logo.size, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
    } catch {
      // Логотип не загрузился — постер рисуется без него, это не отказ
      // всей обложки: см. докстринг модуля («не задан — без картинки-заглушки»).
      logoBuffer = null;
    }
  }

  const photo = await cropPhoto(photoInput, width, height, aspect, styled);
  const leaves = await loadLeaves(aspect, width, height);
  const layers: OverlayOptions[] = [{ input: Buffer.from(tpl.shadeSvg), top: 0, left: 0 }];
  if (leaves) layers.push({ input: leaves, top: 0, left: 0 });
  layers.push({ input: Buffer.from(tpl.textSvg), top: 0, left: 0 });
  if (logoBuffer) layers.push({ input: logoBuffer, top: tpl.logo.top, left: tpl.logo.left });
  return sharp(photo).composite(layers).jpeg({ quality: 92 }).toBuffer();
}

function toTemplateData(values: CoverPosterValues): CoverTemplateData {
  return {
    rooms: values.roomsNumber,
    roomsWord: values.roomsWord,
    priceNumber: values.priceNumber,
    currency: "TJS",
    areaNumber: values.areaNumber,
    floor: values.floor,
    city: values.city,
    district: values.district,
    landmark: values.landmark,
  };
}

/** Геометрия без БД и sharp — для тестов раскладки. */
export interface CoverPosterLayout {
  contentTopY: number;
  contentBottomY: number;
  logoBottomY: number;
  /** Зона, которую не срезает ни один кроп показа (`coverSafeZone`). */
  safeZone: CoverSafeZone;
  /** Коробки всех надписей и плашек в пикселях кадра. */
  inkBoxes: CoverInkBox[];
}
export function computeCoverPosterLayout(width: number, height: number, values: CoverPosterValues): CoverPosterLayout {
  const { contentTopY, contentBottomY, logoBottomY, safeZone, inkBoxes } = buildCoverTemplate(toTemplateData(values), width, height);
  return { contentTopY, contentBottomY, logoBottomY, safeZone, inkBoxes };
}

/** SVG-слои для отладки/сверки с эталоном (скрипты вне репозитория). */
export function buildCoverPosterSvg(width: number, height: number, values: CoverPosterValues): { shadeSvg: string; textSvg: string } {
  const { shadeSvg, textSvg } = buildCoverTemplate(toTemplateData(values), width, height);
  return { shadeSvg, textSvg };
}

/**
 * Цветокоррекция фото под обложку — владелец 22.09: «тускло, мало цвета»
 * рядом с эталоном. Эталон — яркое тёплое фото: светлее, сочнее, контрастнее.
 * Детерминированно (sharp), работает и без Gemini.
 *
 * ПОСЛЕ GEMINI — ВТОРОЙ, МЯГКИЙ НАБОР. Промт `ai/coverPosterStyle.ts` просит у
 * модели ровно то же самое («ЯРКОЙ, СОЧНОЙ и ТЁПЛОЙ», золотой час, поднятый
 * контраст), и модель это уже сделала. Тот же полный набор поверх её ответа
 * кладётся вторым слоем: насыщенность 1,55 на уже насыщенной картинке даёт
 * кислотный цвет, яркость 1,1 добивает светлые участки в белое (солнечные
 * пятна на полу, которые промт и просил, выбиваются первыми), а тёплая
 * `recomb` поверх уже подогретой сцены уводит стены в жёлтый. Поэтому после
 * стилизации берём мягкий набор: цвет и контраст только подправляются, тепло
 * не добавляется вовсе, а резкость остаётся — ответ рисующей модели обычно
 * мягче исходной фотографии.
 */
const GRADE = { brightness: 1.08, saturation: 1.4, contrast: 1.12, warmR: 1.05, warmB: 0.93 };
const GRADE_AFTER_STYLE = { brightness: 1, saturation: 1.12, contrast: 1.04, warmR: 1, warmB: 1 };

function grade(img: Sharp, styled: boolean): Sharp {
  const g = styled ? GRADE_AFTER_STYLE : GRADE;
  return img
    .modulate({ brightness: g.brightness, saturation: g.saturation })
    .linear(g.contrast, -(128 * g.contrast - 128))
    .recomb([
      [g.warmR, 0, 0],
      [0, 1, 0],
      [0, 0, g.warmB],
    ])
    .sharpen({ sigma: 0.8 });
}

async function cropPhoto(
  input: string | Buffer,
  width: number,
  height: number,
  aspect: CoverPosterAspect,
  styled: boolean
): Promise<Buffer> {
  const src = sharp(input).rotate();
  const meta = await src.metadata();
  const srcW = meta.autoOrient?.width ?? meta.width ?? width;
  const srcH = meta.autoOrient?.height ?? meta.height ?? height;
  const targetAr = width / height;
  if (aspect === "square" && srcW / srcH < targetAr) {
    const cropH = Math.round(srcW / targetAr);
    const free = srcH - cropH;
    const top = Math.max(0, Math.min(free, Math.round(free * (0.5 + SQUARE_CROP_SHIFT_DOWN))));
    return sharp(await src.toBuffer())
      .extract({ left: 0, top, width: srcW, height: cropH })
      .resize({ width, height, fit: "cover" })
      .toBuffer()
      .then((b) => grade(sharp(b), styled).toBuffer());
  }
  return grade(sharp(await src.resize({ width, height, fit: "cover", position: "centre" }).toBuffer()), styled).toBuffer();
}

async function loadLeaves(aspect: CoverPosterAspect, width: number, height: number): Promise<Buffer | null> {
  const file = path.join(COVER_ASSETS_DIR, aspect === "square" ? "leaves-square.png" : "leaves-story.png");
  try {
    return await sharp(file).resize({ width, height, fit: "fill" }).png().toBuffer();
  } catch {
    // Нет файла (кто-то не подтянул assets/) — обложка без листьев, не отказ.
    void logSystemError("storage", `Обложка объекта: слой листьев не найден (${file})`, { dedupKey: "cover-poster-leaves-missing" });
    return null;
  }
}

/** Где лежит SVG шаблона для этого формата: встроенный SVG — в assets,
 *  свой — в `uploads/cover-templates/` (туда его пишет загрузка). */
function templateSvgPath(template: CoverTemplateRecord, aspect: CoverPosterAspect): string | null {
  if (template.svgFiles) return template.svgFiles[aspect] ?? null;
  if (template.svgUrl) return path.join(uploadsDir, "cover-templates", path.basename(template.svgUrl));
  return null;
}

/**
 * SVG-слой шаблона с подставленными значениями — без фото и sharp (для
 * рендера и стражей безопасной зоны). `hasLogo`: настоящий логотип из
 * Настроек будет наложен поверх, векторный знак шаблона тогда не рисуется.
 */
export async function buildTemplateSvgLayer(
  template: CoverTemplateRecord,
  aspect: CoverPosterAspect,
  values: CoverPosterValues,
  hasLogo: boolean
): Promise<string> {
  const svgPath = templateSvgPath(template, aspect);
  if (!svgPath) throw new Error(`шаблон не рисует формат ${aspect}`);
  const raw = await fs.readFile(svgPath, "utf8");
  return applyTemplateValues(raw, {
    rooms: values.roomsNumber ?? "",
    roomsWord: values.roomsWord.toUpperCase(),
    price: values.price,
    priceNumber: values.priceNumber,
    currency: "TJS",
    area: values.area,
    areaNumber: values.areaNumber,
    floor: values.floor ?? "",
    city: values.city,
    district: values.district ?? "",
    landmark: values.landmark ?? "",
    vectorLogo: hasLogo && template.logoBoxes?.[aspect] ? "" : "1",
  });
}

/**
 * SVG-шаблон (свой владельца или встроенный «Royal Gold · ChatGPT»): фото →
 * листья шаблона → его SVG-слой с подставленными значениями → логотип.
 * Геометрию задаёт сам файл, а не код. Шаблон не рисует этот формат или сбой
 * любого слоя — рисуем встроенным «Royal Gold» (обложка нужнее выбора шаблона).
 */
async function renderCustomTemplate(
  template: CoverTemplateRecord,
  photoInput: string | Buffer,
  values: CoverPosterValues,
  width: number,
  height: number,
  aspect: CoverPosterAspect,
  styled: boolean,
  logoPath: string | null
): Promise<Buffer> {
  // Шаблон только под квадрат на вертикали: раньше его SVG 1080×1080 ложился
  // в верх кадра 1080×1920 (или ронял composite), теперь честно берём встроенный.
  if (!template.formats.includes(aspect)) return renderCoverPosterImage(photoInput, values, aspect, logoPath, styled);
  try {
    const logoBox = template.logoBoxes?.[aspect];
    let logoBuffer: Buffer | null = null;
    if (logoPath && logoBox) {
      logoBuffer = await sharp(logoPath)
        .resize({ width: logoBox.size, height: logoBox.size, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer()
        .catch(() => null);
    }
    const svg = await buildTemplateSvgLayer(template, aspect, values, Boolean(logoBuffer));
    const photo = await cropPhoto(photoInput, width, height, aspect, styled);
    const layers: OverlayOptions[] = [];
    const leavesPath = template.leavesFiles?.[aspect]
      ?? (template.leavesUrl ? path.join(uploadsDir, "cover-templates", path.basename(template.leavesUrl)) : null);
    let leaves: OverlayOptions | null = null;
    if (leavesPath) {
      try {
        leaves = { input: await sharp(leavesPath).resize({ width, height, fit: "fill" }).png().toBuffer(), top: 0, left: 0 };
      } catch {
        // Слой листьев шаблона не открылся — рисуем без него.
      }
    }
    if (leaves && !template.leavesOnTop) layers.push(leaves);
    // Размер слоя — строго холст: SVG другого размера иначе роняет composite.
    const layer = await sharp(Buffer.from(svg)).resize({ width, height, fit: "fill" }).png().toBuffer();
    layers.push({ input: layer, top: 0, left: 0 });
    if (leaves && template.leavesOnTop) layers.push(leaves);
    if (logoBuffer && logoBox) layers.push({ input: logoBuffer, top: logoBox.top, left: logoBox.left });
    return await sharp(photo).composite(layers).jpeg({ quality: 92 }).toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : "неизвестный сбой";
    void logSystemError("storage", `Обложка: шаблон ${template.id} не отрисовался (${message}) — рисуем встроенным`, {
      dedupKey: `cover-template-render-fail:${template.id}`,
    });
    return renderCoverPosterImage(photoInput, values, aspect, logoPath, styled);
  }
}
