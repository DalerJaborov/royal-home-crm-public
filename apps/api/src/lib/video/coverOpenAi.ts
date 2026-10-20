/**
 * ОБЛОЖКИ ОБЪЕКТА ОТ CHATGPT — v2 (25.09.2026, после живого прогона владельца).
 *
 * Что сломалось в v1 и как устроено теперь:
 *  (а) квадрат, вырезанный из вертикали, терял нижний ряд «этаж / район» →
 *      квадрат 1024×1024 и вертикаль 1024×1536 генерируются КАЖДЫЙ по своему
 *      эталону владельца (glass-square.png / glass-story.png). Вертикаль
 *      забракована или упала — собирается из квадрата sharp'ом (квадрат по
 *      центру, сверху и снизу его размытая затемнённая копия): лучше такая,
 *      чем никакой.
 *  (б) модель написала «ДУЖ» вместо «ЭТАЖ», проверка ловила только цифры →
 *      вторая модель читает ВСЕ слова и сверяет с белым списком, и отдельно
 *      отвечает, не изменён ли интерьер относительно исходного фото.
 *  (в) логотип мелкий и в тени → наш PNG крупнее: 14 % ширины, отступ 4 %.
 *  (г) грубее приложения ChatGPT → ПОЛНЫЙ промт владельца без сжатия
 *      (`assets/cover/prompt-glass-style.md`), `input_fidelity: "high"`,
 *      кандидатки за запрос (`n` = `Settings.openaiCandidates`, 1–2) и выбор
 *      лучшей второй моделью.
 *
 * Поток: главное фото + эталон стиля + логотип → images/edits (n=2) → каждая
 * кандидатка: цифры, слова, «фото не изменено» → из прошедших вторая модель
 * выбирает лучшую → нет прошедших — ещё один запрос с усиленным промтом → иначе
 * null. Наш логотип кладётся поверх sharp'ом. Сбой ChatGPT (нет денег, лимит дня,
 * сеть, брак) → с 02.10.2026 запасная обложка нашим шаблоном «Royal Green» без ИИ
 * (`createFallbackTemplateCover`, метка `fallback-template:` в хэше); решение 25.09
 * «наш шаблон запасным путём не служит» отменено владельцем. Нет даже её (выключены,
 * объект удалён, нет фото) → null, публикация без обложки, причина — в журнал ошибок и
 * `Property.socialCoverError`.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type OverlayOptions } from "sharp";
import { prisma } from "../../db.js";
import { propertyCoversDir, uploadsDir } from "../../upload.js";
import { logSystemError } from "../systemError.js";
import { describeError } from "../describeError.js";
import { dushanbeStartOfToday } from "../dushanbeTime.js";
import { loadMoneyContext } from "../money.js";
import { estimateCostUsd } from "../../ai/pricing.js";
import { resyncPhotosIfPublished } from "../siteSync.js";
import {
  OPENAI_CHAT_TIMEOUT_MS,
  OPENAI_IMAGE_TIMEOUT_MS,
  OPENAI_OUT_OF_MONEY_CODE,
  OpenAiError,
  estimateImageCostUsd,
  imageCostFromUsage,
  type ImageUsage,
  type OpenAiImageModel,
  isOpenAiImageModel,
  isOpenAiImageQuality,
  logOpenAiCall,
  openAiPost,
  resolveOpenAiKey,
  type OpenAiImageQuality,
} from "../../ai/openaiClient.js";
import { buildCoverPosterValues, renderCoverPosterImage, type CoverPosterValues } from "./coverPoster.js";
import { listCoverTemplates, pickCoverTemplate } from "./coverRegistry.js";
import { DEFAULT_LOCAL_RETOUCH_LEVEL, retouchCoverPhoto } from "./coverPhotoRetouch.js";
import { redrawCoverPhoto } from "./coverPhotoRedraw.js";
import { COVER_PROVIDERS, DEFAULT_COVER_PROVIDER, DEFAULT_COVER_TEMPLATE_ID, propertyFieldShown, type CoverProvider } from "@royal-home/shared";
import { FIXED_PANELS, originalPhotoBase, overlayCoverText } from "./coverTextLayer.js";

/** Модель картинок по умолчанию (Settings.openaiImageModel): ChatGPT Images 2.5 —
 *  на ней владелец на сайте получил почти идеальную обложку (25.09.2026). */
export const COVER_IMAGE_MODEL: OpenAiImageModel = "gpt-image-2.5-sunburst";
export const COVER_CHECK_MODEL = "gpt-4.1-mini";
/** Журнал ИИ: по этим endpoint считается дневной лимит (картинки, не объекты) и строится «последние обращения». */
export const COVER_IMAGE_ENDPOINT = "cover-openai-image";
/** Отказ «нет денег»: пишется отдельным эндпоинтом, чтобы не съедать дневной лимит картинок. */
export const COVER_IMAGE_NO_MONEY_ENDPOINT = "cover-openai-image-no-money";

/**
 * ПРЕДОХРАНИТЕЛЬ «НЕТ ДЕНЕГ НА OPENAI». Баланс кончился — каждый объект и каждый
 * повтор снова стучался в OpenAI (выбор фото + заказ картинок) и получал тот же
 * отказ. После первого такого ответа два часа в OpenAI не ходим: сразу запасной
 * путь. Живёт в памяти процесса; сбрасывается первым успешным запросом или по сроку.
 */
export const OPENAI_NO_MONEY_BREAKER_MS = 2 * 60 * 60 * 1000;
let noMoneyUntil = 0;
export function tripOpenAiNoMoneyBreaker(now: number = Date.now()): void {
  noMoneyUntil = now + OPENAI_NO_MONEY_BREAKER_MS;
}
export function resetOpenAiNoMoneyBreaker(): void {
  noMoneyUntil = 0;
}
export function isOpenAiNoMoneyBreakerOpen(now: number = Date.now()): boolean {
  return now < noMoneyUntil;
}
function isNoMoneyError(err: unknown): boolean {
  return err instanceof OpenAiError && err.code === OPENAI_OUT_OF_MONEY_CODE;
}
/** Причина — «нет денег» (текст OpenAiError или открытый предохранитель): ключ журнала общий, а не по объекту. */
function isNoMoneyReason(reason: string): boolean {
  return isOpenAiNoMoneyBreakerOpen() || /нет денег|no credits|insufficient|billing|quota|баланс/i.test(reason);
}
export const COVER_CHECK_ENDPOINT = "cover-openai-check";
/** Меняется при значимой правке промта — кэш обложек тогда пересоздаётся. */
export const COVER_PROMPT_VERSION = "2026-10-01-v6-no-before-after";

/**
 * Кто пишет текст на обложке (v3, 25.09.2026). OVERLAY (по умолчанию) — модель
 * рисует пустые панели, текст кладём мы (`coverTextLayer.ts`): gpt-image-1
 * системно искажает кириллицу и длинные числа. MODEL — поведение v2 как было.
 */
export type CoverTextMode = "OVERLAY" | "MODEL";
export function isCoverTextMode(value: unknown): value is CoverTextMode {
  return value === "OVERLAY" || value === "MODEL";
}
/**
 * Откуда фон обложки в OVERLAY (живой прогон 25.09). ORIGINAL (по умолчанию) —
 * настоящее фото объекта без перерисовки; от ChatGPT только объёмная золотая
 * цифра (прозрачный PNG, одна на цифру, кэш на диске). MODEL — фото перерисовывает
 * gpt-image-1 (кинематографичнее, но меняет комнату: пропадала люстра, ракурс).
 */
export type CoverPhotoSource = "ORIGINAL" | "MODEL";
export function isCoverPhotoSource(value: unknown): value is CoverPhotoSource {
  return value === "ORIGINAL" || value === "MODEL";
}

export const DIGIT_PROMPT = (digit: string) =>
  `Одна огромная объёмная цифра «${digit}» из полированного металлического золота: глянцевое 3D, толстый скошенный торец, ` +
  "тёплые блики и мягкие отражения, лёгкий наклон вправо, вид чуть снизу — как роскошная вывеска. Прозрачный фон, " +
  "никаких других символов, теней на фоне, пола, рамок и декора. Цифра целиком в кадре с полями.";

/** Каталог кэша цифр: одна генерация на цифру и версию промта, дальше бесплатно. */
export const DIGIT_CACHE_DIR = path.join(uploadsDir, "cover-digits");

/** Кандидаток по умолчанию: в OVERLAY текст наш — хватает одной; в MODEL выбор из двух. */
export function defaultCandidates(mode: CoverTextMode): 1 | 2 {
  return mode === "OVERLAY" ? 1 : 2;
}

export const COVER_SIZE = 1080;
export const STORY_HEIGHT = 1920;
/** Квадрат по центру вертикали — та же зона, что показывает профиль Reels. */
export const SQUARE_TOP_IN_STORY = (STORY_HEIGHT - COVER_SIZE) / 2; // 420
const STORY_BODY_HEIGHT = 1620; // отдельная вертикаль 1024×1536 → 1080×1620
const STORY_PAD = (STORY_HEIGHT - STORY_BODY_HEIGHT) / 2; // 150
/**
 * Тело вертикали 3:4 (01.10.2026): сетка профиля Instagram показывает у Reels центр
 * кадра 3:4 из обложки 9:16 и режет ~12,5 % сверху и снизу — знак и нижняя строка
 * «РАЙОН» пропадали. Модель рисует сразу 3:4 (1152×1536), мы кладём это тело ровно
 * в центр 1080×1920 (по 240 px сверху и снизу): сетка 3:4 видит его целиком, а в Reels
 * по краям мягкие полосы под интерфейс Instagram.
 */
export const STORY_34_BODY_HEIGHT = (COVER_SIZE * 4) / 3; // 1440
export const STORY_34_TOP = (STORY_HEIGHT - STORY_34_BODY_HEIGHT) / 2; // 240
const PAD_COLOR = "#07130F";
/** Логотип: 14 % ширины кадра, отступ 4 % (владелец, v2). */
export const LOGO_WIDTH = Math.round(COVER_SIZE * 0.14);
export const LOGO_MARGIN = Math.round(COVER_SIZE * 0.04);
/** Логотип в Настройках уже этого — в разделе Настроек предупреждение. */
export const LOGO_MIN_SOURCE_PX = 400;

const ASSETS_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets", "cover");
const REFERENCE_PATHS: Record<"square" | "story", string> = {
  square: path.join(ASSETS_DIR, "reference", "glass-square.png"),
  story: path.join(ASSETS_DIR, "reference", "glass-story.png"),
};
/**
 * Режим MODEL (29.09.2026, владелец: «пусть ChatGPT сам делает всё — и текст, и
 * самую красивую картинку сзади — именно по нашему референсу»): эталон — его макеты
 * «Royal Green» (`docs/cover-sources-29-09/`), знак на них закрашен полосой: логотип
 * модель НЕ рисует, мы кладём настоящий знак владельца сами, без тени, в светлую полосу.
 */
export const MODEL_REFERENCE_PATHS: Record<"square" | "story", string> = {
  square: path.join(ASSETS_DIR, "reference", "royal-green-square.png"),
  story: path.join(ASSETS_DIR, "reference", "royal-green-story.png"),
};
/** Знак владельца (прозрачный PNG), тот же, что у шаблона «Royal Green». */
export const OWNER_LOGO_PATH = path.join(ASSETS_DIR, "royal-green-logo.png");
/** Где стоит знак на макетах: квадрат 1080², вертикаль 1080×1920 (высота знака, px). */
export const MODEL_LOGO_BOX = {
  square: { left: 131, top: 56, height: 206 },
  story: { left: 72, top: 152, height: 250 },
  /**
   * Вертикаль 3:4: та же высота знака, что в квадрате; `top` отсчитан ОТ ВЕРХА ТЕЛА (в кадре
   * 1080×1920 к нему прибавляется STORY_34_TOP = 240). Дизайн квадрата вытянут по высоте в 4/3:
   * 56 × 4/3 ≈ 75. `left` с 01.10.2026 только справочный: реальный размер и место знака берутся из
   * ширины кремовой полосы (`fitLogoToStrip`), иначе знак торчал за её край.
   */
  story34: { left: 131, top: 75, height: 206 },
} as const;
const FALLBACK_LOGO_PATH = path.join(ASSETS_DIR, "logo-fallback.svg");
/** Копия `docs/cover-sources-25-09/prompt-glass-style.md` (образ несёт только assets; тест сторожит, что копии равны). */
export const OWNER_PROMPT_PATH = path.join(ASSETS_DIR, "prompt-glass-style.md");

export type Aspect = "story" | "square";

/** Цифры карточки, которые ОБЯЗАНЫ совпасть с картинкой. */
export interface CoverFacts {
  rooms: number | null;
  /** Цена в TJS, только цифры: «890000». */
  priceDigits: string;
  areaSqm: number;
  floor: number | null;
  district: string | null;
  /** Надписи сцены, разрешённые на обложке сверх подписей («СЕЙЧАС», «МОЖНО ТАК»…). */
  extraWords?: string[];
}

export function factsFromValues(values: CoverPosterValues, floor: number | null): CoverFacts {
  return {
    rooms: values.heroKind === "rooms" && values.roomsNumber != null ? Number(values.roomsNumber) : null,
    priceDigits: values.priceNumber.replace(/\D/g, ""),
    areaSqm: Number(values.areaNumber.replace(",", ".")),
    floor,
    district: values.district,
  };
}

// ───────────────────────── промт ─────────────────────────

/** Подписи на обложке — ровно эти слова (владелец, v2). */
export const COVER_LABELS = ["ХОНАГА", "КВАДРАТ", "СОТИХ", "НАРХ", "TJS", "М²", "МАСОҲАТ", "ОШЁНА", "ЭТАЖ", "ДУШАНБЕ", "РАЙОН:"] as const;

let ownerPromptCache: string | null = null;
/** Текст владельца дословно — всё после разделителя `---` в файле. */
export async function loadOwnerPrompt(): Promise<string> {
  if (ownerPromptCache) return ownerPromptCache;
  const raw = await fs.readFile(OWNER_PROMPT_PATH, "utf8");
  const parts = raw.split(/\r?\n---\r?\n/);
  ownerPromptCache = (parts.length > 1 ? parts.slice(1).join("\n---\n") : raw).trim();
  return ownerPromptCache;
}

/**
 * Промт режима MODEL — дословно тот, что сработал у владельца на сайте ChatGPT
 * (25.09.2026, ChatGPT Images 2.5, фото гостиной): роли трёх картинок, блок
 * ДАННЫЕ ОБЪЕКТА, список слов для проверки орфографии. Картинки идут в порядке
 * «фото, логотип, эталон» — именно так, как в промте.
 */
/**
 * СЦЕНА ФОНА (владелец, 29.09.2026). Объект с отделкой — «журнальный» интерьер.
 * Новостройка без отделки и «требует ремонта» — НЕ выдаём коробку за готовую
 * квартиру: каждый раз случайно один из честных и эффектных вариантов
 * («все нравятся — рандом каждый раз»). Фасад на закате — только если среди фото
 * есть фасад (`chooseCoverPhoto(..., "facade")`), иначе из остальных.
 */
export type CoverScene =
  | "INTERIOR"
  | "FACADE_SUNSET"
  | "WINDOW_VIEW"
  | "LOCATION"
  // Дома, участки, коммерция (владелец 30.09.2026: «такой же журнальный стиль, но без комнат»):
  | "CLEAN_YARD"
  | "LAND_CONTOUR"
  | "LAND_SUNSET"
  | "FUTURE_HOUSE"
  | "EVENING_FACADE"
  | "COMMERCIAL_PLAN";
export const UNFINISHED_SCENES: readonly CoverScene[] = ["FACADE_SUNSET", "WINDOW_VIEW", "LOCATION"];
/** Сцены, которым нужно фото здания снаружи (а не комнаты). */
export const FACADE_SCENES: readonly CoverScene[] = ["FACADE_SUNSET", "CLEAN_YARD", "EVENING_FACADE"];

/**
 * Какие сцены возможны объекту (выбор случайный из набора, «рандом каждый раз»).
 * - Квартира: без отделки — три сцены без выдуманной квартиры (без фасада — две), с отделкой — интерьер.
 * «До и после» и «Сейчас → Потенциал» убраны совсем (владелец 01.10.2026: «не нравится» золотая линия
 * пополам с подписями «СЕЙЧАС»); пул не бывает пустым: WINDOW_VIEW и LOCATION не требуют фасада.
 * - Дом: есть фото снаружи — закат, чистый двор, карта; нет — как квартира.
 * - Участок: контур на карте, закат, «Визуализация застройки».
 * - Коммерция: есть фасад — вечерний фасад, карта, планировка; нет — готовый ремонт → интерьер,
 *   иначе карта и планировка.
 * `hasFacade` — среди фото нашёлся снимок здания снаружи.
 */
export function scenePool(type: string | null | undefined, condition: string | null | undefined, hasFacade: boolean): CoverScene[] {
  const unfinished = isUnfinishedCondition(condition);
  const apartment = (): CoverScene[] =>
    unfinished ? UNFINISHED_SCENES.filter((s) => hasFacade || !FACADE_SCENES.includes(s)) : ["INTERIOR"];
  if (type === "HOUSE") return hasFacade ? ["FACADE_SUNSET", "CLEAN_YARD", "LOCATION"] : apartment();
  if (type === "LAND") return ["LAND_CONTOUR", "LAND_SUNSET", "FUTURE_HOUSE"];
  if (type === "COMMERCIAL") {
    if (hasFacade) return ["EVENING_FACADE", "LOCATION", "COMMERCIAL_PLAN"];
    return unfinished ? ["LOCATION", "COMMERCIAL_PLAN"] : ["INTERIOR"];
  }
  return apartment();
}
/** Тип, у которого «журнальную» перерисовку фото нельзя: выдумала бы комнату вместо дома/участка. */
export function isExteriorType(type: string | null | undefined): boolean {
  return type === "HOUSE" || type === "LAND" || type === "COMMERCIAL";
}
/** Состояния объекта, у которых на фото нет готовой квартиры. */
export function isUnfinishedCondition(condition: string | null | undefined): boolean {
  return condition === "NEW_BUILDING" || condition === "NEEDS_REPAIR";
}
/** Надписи, которые сцена сама кладёт на картинку (белый список проверки). */
export const SCENE_WORDS: Record<CoverScene, string[]> = {
  INTERIOR: [],
  FACADE_SUNSET: [],
  WINDOW_VIEW: [],
  LOCATION: [],
  CLEAN_YARD: [],
  LAND_CONTOUR: ["СХЕМА"],
  LAND_SUNSET: [],
  FUTURE_HOUSE: ["ВИЗУАЛИЗАЦИЯ"],
  EVENING_FACADE: [],
  COMMERCIAL_PLAN: ["ПРИМЕР ПЛАНИРОВКИ"],
};

function sceneBackground(scene: CoverScene, values: CoverPosterValues): string {
  const floor = values.floor ? ` с высоты ${values.floor.replace(/\D/g, "") || "верхнего"} этажа` : " с высоты этажа";
  switch (scene) {
    case "FACADE_SUNSET":
      return "ФОН: картинка 1 — фасад дома. Сохрани само здание как есть (этажность, окна, отделку, кран, если он есть) и сделай кадр эффектным, как у архитектурного фотографа: «золотой час» на закате, тёплое небо с лёгкими облаками, мягкий тёплый свет в части окон, чистый воздух, фотореализм. Меняются только небо, свет и атмосфера; кроме того убери из кадра посторонних людей, бельё, провода и мусор. Износ самого здания (трещины, облупленные стены, ветхая кровля) НЕ исправлять, не красить и не скрывать.";
    case "CLEAN_YARD":
      return "ФОН: картинка 1 — дом и двор снаружи. Сохрани здание и двор как есть, как в журнале о недвижимости: чистый аккуратный кадр в тёплом дневном свете, безоблачное небо, зелень чуть живее. Убери всё лишнее: посторонних людей, бельё, провода, мусор, хлам, машины. Износ самого здания (трещины, облупленные стены, ветхая кровля) НЕ исправлять, не красить и не скрывать.";
    case "LAND_CONTOUR":
      return `ФОН: стильная объёмная иллюстрация-карта района «${values.district ?? values.city}» города ${values.city}, вид сверху под углом, мягкие тёплые тона: кварталы, дороги, зелень. Участок выделен золотым контуром с мягким свечением, рядом маленькие круглые золотые значки без подписей (дорога, школа, магазин). На карте НИКАКИХ названий и надписей, кроме маленькой подписи «СХЕМА» в углу. Картинку 1 можно поставить маленьким кадром в круглой золотой рамке.`;
    case "LAND_SUNSET":
      return "ФОН: картинка 1 — участок. Сохрани рельеф, местность, соседние объекты и ракурс как есть; сделай кадр эффектным: «золотой час», тёплый мягкий свет, красивое небо с лёгкими облаками, фотореализм. Горы на горизонте — только если они есть на фото. Убери из кадра посторонних людей, мусор и провода. Ничего не достраивай.";
    case "FUTURE_HOUSE":
      return "ФОН: картинка 1 — пустой участок. Сохрани участок, окружение и ракурс как есть и поставь на него красивый современный двухэтажный дом в естественном масштабе, ухоженный газон, тёплый свет заката, фотореализм; в углу мелко «ВИЗУАЛИЗАЦИЯ». Кроме этого слова никакого текста на фоне.";
    case "EVENING_FACADE":
      return "ФОН: картинка 1 — вход и фасад помещения. Сохрани здание, вход и окна как есть; вечерний свет: золотой час или ранние сумерки, тёплая подсветка окон и входа, чистая улица без мусора и посторонних людей, фотореализм. Вывески и надписи не придумывать и не менять: есть на фото — оставить как есть, нет — не добавлять.";
    case "COMMERCIAL_PLAN":
      return "ФОН: стильная 3D-схема планировки помещения сверху (изометрия): стены, зоны, условная мебель, светлые тёплые тона, без надписей на плане; в углу мелко «ПРИМЕР ПЛАНИРОВКИ». Картинку 1 можно поставить маленьким кадром в круглой золотой рамке.";
    case "WINDOW_VIEW":
      return `ФОН: главное — вид из окна${floor}: широкая панорама города Душанбе с горами на горизонте, ясный тёплый день или закат, фотореализм. Окно и откосы из картинки 1 можно оставить рамкой кадра; саму комнату не обставлять и не отделывать.`;
    case "LOCATION":
      return `ФОН: стильная объёмная иллюстрация-карта района «${values.district ?? values.city}» города ${values.city}, вид сверху под углом, мягкие тёплые тона: кварталы, зелень парков, дороги; в центре золотая метка-булавка дома. Вокруг метки — небольшие круглые золотые значки без подписей: школа, парк, магазин, транспорт. На карте НИКАКИХ названий улиц и надписей. Картинку 1 можно поставить маленьким кадром в круглой золотой рамке рядом с меткой.`;
    default:
      // 01.10.2026 (владелец: «комната может отличаться, но не так кардинально; не придумывать цветы, подсветку»):
      // раньше модель рисовала по мотивам фото одну и ту же бежевую гостиную с золотым столиком у ВСЕХ объектов,
      // а у пустых и старых квартир выдумывала мебель. Теперь комната — ЭТА, меняются только свет, цвет и чистота.
      return "ФОН: картинка 1 — комната объекта. Сохрани ЭТУ комнату: ракурс, планировку, окна и вид из них, двери, стены, пол, потолок, всю мебель и предметы на тех же местах, тот же цвет и рисунок отделки. Улучши только фото: ровный яркий естественный свет, чистые цвета без жёлтого и серого оттенка, убери мусор, провода, плёнку и посторонних людей. НИЧЕГО не добавляй и не меняй: ни цветов, ни декора, ни мебели, ни штор, ни ковров, ни подсветки; вид из окна и небо не менять. Если положить результат рядом с оригиналом, отличаются только свет, цвет и чистота; интерьер журнальный по качеству света, но НАСТОЯЩИЙ.";
  }
}

export function buildCoverPrompt(params: {
  ownerText?: string;
  values: CoverPosterValues;
  aspect: Aspect;
  strict: boolean;
  /** Эталон загружен владельцем в Настройках: картинки «фото, логотип, эталон», знак ставит модель. */
  customReference?: boolean;
  /** Что на фоне; не задано — «журнальный» интерьер. */
  scene?: CoverScene;
  /** Вертикаль рисуется в 3:4 (gpt-image-2.x, MODEL): безопасная зона сетки Instagram. */
  portrait34?: boolean;
}): string {
  const { values, aspect, strict, customReference } = params;
  const scene = params.scene ?? "INTERIOR";
  const district = values.district?.toUpperCase() ?? null;
  const digit = values.roomsNumber;
  const data = [
    "ДАННЫЕ ОБЪЕКТА (писать только их и ровно так):",
    digit ? `${digit} ${values.roomsWord.toUpperCase()}` : null,
    // В плашке только число и TJS: слово «ЦЕНА» модель раньше дописывала на обложку (30.09, брак).
    `В кремовой плашке: ${values.priceNumber} TJS (только число и TJS — без слова «ЦЕНА» и без других подписей)`,
    `${values.areaNumber} м² / МАСОҲАТ`,
    values.floor ? `${values.floor.toUpperCase()} / ЭТАЖ` : null,
    `${values.city.toUpperCase()}${district ? ` / РАЙОН: ${district}` : ""}`,
  ].filter(Boolean);
  const words = [values.roomsWord.toUpperCase(), "МАСОҲАТ", values.floor ? "ОШЁНА" : null, values.floor ? "ЭТАЖ" : null, values.city.toUpperCase(), district ? "РАЙОН" : null, district, "TJS", ...SCENE_WORDS[scene]].filter(Boolean);
  const lines = [
    customReference
      ? "Картинка 1 — фото объекта недвижимости. Картинка 2 — наш логотип. Картинка 3 — ЭТАЛОН ДИЗАЙНА: повтори его оформление один в один."
      : "Картинка 1 — фото объекта недвижимости. Картинка 2 — ЭТАЛОН ДИЗАЙНА: повтори его оформление один в один.",
    "",
    aspect === "square"
      ? "Сделай готовую рекламную обложку недвижимости, формат 1:1."
      : params.portrait34
        ? `Сделай готовую рекламную обложку недвижимости, вертикаль 3:4. ${
            customReference
              ? "Дизайн как на эталоне; всё содержимое целиком внутри кадра, ничего не обрезано."
              : "Эталон — квадратный: тот же дизайн, формат вытянут по высоте до 3:4 — кремовая полоса слева сверху, диагональная зелёная панель, цифра, подпись под ней, плашка цены, нижний блок с иконками; всё содержимое целиком внутри кадра, ничего не обрезано."
          }`
        : "Сделай готовую рекламную обложку недвижимости, вертикаль 9:16 для Reels: нижние 8 % кадра — только зелёная панель без текста.",
    "",
    sceneBackground(scene, values),
    "",
    customReference
      ? "ДИЗАЙН (как на картинке 3): то же расположение, цвета, шрифты, плашки, иконки и пропорции, что на эталоне; меняются только фон и данные объекта."
      : "ДИЗАЙН (как на картинке 2): слева сверху светлая кремовая вертикальная полоса; тёмно-зелёная панель по диагонали слева-снизу; огромная объёмная золотая серифная цифра (" + (values.heroKind === "rooms" ? "число комнат" : "площадь") + "); под ней слово «" + values.roomsWord.toUpperCase() + "» крупным белым серифом и тонкая золотая линия; кремово-золотая плашка со скруглёнными углами, в ней цена тёмно-зелёными жирными серифными цифрами и «TJS» поменьше; внизу на зелёном три блока с тонкими золотыми линейными иконками и вертикальными разделителями: площадь, этаж, город и район.",
    "",
    ...data,
    "",
    `${customReference ? "ЛОГОТИП: картинку 2 вставить ТОЧНО такой, не перерисовывать, на то место, где логотип стоит на эталоне. Других эмблем и водяных знаков нет." : "ЛОГОТИП НЕ РИСОВАТЬ: верх светлой полосы (как на картинке 2) оставить пустым — туда мы сами поставим наш знак. Никаких эмблем, надписей ROYAL, HOME, TJ, водяных знаков."}${digit ? "" : " Крупную цифру и подпись под ней не рисовать."}${values.floor ? "" : " Этаж не указан — блок этажа не рисовать."} Только TJS, никаких $, USD, сомони. Без слоганов, телефонов и другого текста${SCENE_WORDS[scene].length ? ` (кроме подписей фона: ${SCENE_WORDS[scene].map((w) => `«${w}»`).join(", ")})` : ""}. Все буквы — кириллица, проверь каждое слово: ${words.join(", ")}.`,
  ];
  if (strict) lines.push("", `ВНИМАНИЕ: прошлый вариант забракован — неверные цифры, искажённые слова или логотип не тот. Цифры и слова ТОЧНО как в ДАННЫХ ОБЪЕКТА${customReference ? ", логотип — ровно картинка 2" : ", логотип не рисовать"}.`);
  return lines.join("\n");
}

/**
 * Промт режима OVERLAY: оформление в стиле эталона БЕЗ ЕДИНОЙ БУКВЫ И ЦИФРЫ.
 * Разрешена одна большая цифра комнат (`withDigit`) — её проверяем зрением;
 * вышла криво — следующий заход без цифры, цифру кладём мы.
 */
export function buildOverlayPrompt(params: { ownerText: string; values: CoverPosterValues; aspect: Aspect; withDigit: boolean; strict: boolean }): string {
  const { values, aspect, withDigit, strict } = params;
  const digit = withDigit && values.roomsNumber ? values.roomsNumber : null;
  // Живой прогон 25.09: панели модель рисует не там и не такие (прозрачное стекло
  // вместо золота и чёрного глянца) — панели, текст и иконки теперь наши (SVG).
  // От модели нужны только кинематографичный свет на фото и объёмная цифра.
  // Полный текст владельца здесь не подставляется: он описывает панели и текст,
  // а модель, прочитав его, начинает их рисовать.
  const zone =
    aspect === "square"
      ? "в верхней левой части кадра: верх цифры на 15 % высоты, низ — не ниже 42 %, по ширине от 14 % до 44 %"
      : "в левой части кадра: верх цифры на 28 % высоты, низ — не ниже 47 %, по ширине от 12 % до 50 %";
  const lines = [
    "Сделай премиальную рекламную фотографию недвижимости для ROYAL HOME TJ из картинки 1.",
    "Картинка 1 — настоящее фото объекта. Сохрани ВСЕ предметы, мебель, люстру, окна, двери, ракурс и геометрию комнаты ровно как есть. Цвета и баланс белого сохранить как на фото, не перекрашивать в оранжевый или жёлтый. Можно только: чуть больше контраста, лёгкие тёплые блики от светильников, мягкое затемнение нижней половины кадра.",
    digit
      ? `Добавь одну огромную объёмную металлическую золотую цифру «${digit}» (глянцевое 3D-золото, мягкая тень, блики, как на картинке 2) ${zone}, с наклоном 5–8°. Ровно одна цифра.`
      : "Никаких цифр.",
    "НЕ рисуй: никаких панелей, плашек, рамок, стекла, кнопок, иконок, букв, слов, логотипов, водяных знаков. Нижние 55 % кадра — только фото (туда позже ляжет наш дизайн).",
    "Картинка 2 — эталон стиля: бери из неё только характер света и золота цифры.",
    aspect === "square" ? "Формат 1:1." : "Формат 2:3 вертикальный.",
  ];
  if (strict) lines.push("ВНИМАНИЕ: прошлый вариант забракован (лишние символы или изменено фото). Ни одного символа, кроме цифры; предметы фото не менять.");
  return lines.join("\n");
}

export interface BlankAnalysis {
  /** Все символы, которые модель видит на картинке (буквы, цифры, слова). */
  symbols: string[];
  photoSame: boolean;
  added: string | null;
}

/**
 * Что считать «фото изменено» (01.10.2026). Для сцены INTERIOR это теперь брак, а не замечание,
 * поэтому читалка не должна шуметь на улучшенном свете и убранном мусоре: расхождение — только
 * то, что меняет саму комнату.
 */
const PHOTO_SAME_RULE =
  "photo_same=false ставь ТОЛЬКО если на обложке добавлены предметы, переставлена или убрана мебель и крупные предметы (декор, цветы, шторы, ковры), " +
  "изменён цвет или рисунок стен и пола, другая форма или число окон, другой вид из окна. " +
  "Свет, яркость, цветокоррекцию и чистоту, обрезку кадра, панели, плашки и цифры дизайна расхождением НЕ считай. " +
  // 01.10.2026: проверка бракует обложку за то, что мы сами просим в промте («убери мусор, провода, плёнку»).
  "Убранные мелкие бытовые предметы (бутылки, вещи на диване, мусор, провода, плёнка, посторонние люди) расхождением НЕ считай: именно это мы просим убрать.";

export const ANALYZE_PROMPT =
  "Картинка 1 — оформление рекламной обложки без текста, картинка 2 — исходное фото объекта. " +
  "1) Выпиши ВСЕ символы (буквы, цифры, слова), которые видны на картинке 1; если на ней ровно одна цифра — только её; если ничего — пустой список. " +
  "2) Совпадает ли интерьер/фасад картинки 1 с картинкой 2? " + PHOTO_SAME_RULE.replace("на обложке", "на картинке 1") + " Большую золотую цифру тоже не считай. " +
  'Ответь только JSON: {"symbols": ["..."], "photo_same": true|false, "added": "что добавлено/убрано или пусто"}.';

// ───────────────────────── вызовы OpenAI ─────────────────────────

interface ImagesResponse {
  data?: { b64_json?: string }[];
}

async function toUploadPart(buffer: Buffer, maxSide: number, keepAlpha: boolean): Promise<Blob> {
  const img = sharp(buffer, { density: 300 }).rotate().resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true });
  const out = keepAlpha ? await img.png().toBuffer() : await img.jpeg({ quality: 92 }).toBuffer();
  return new Blob([new Uint8Array(out)], { type: keepAlpha ? "image/png" : "image/jpeg" });
}

/** Один запрос images/edits на `n` кандидаток. В журнал — строка на КАЖДУЮ картинку (лимит считает картинки). */
/** Размер ответа: gpt-image-1 знает только 1024×1536; 2.x — любые кратные 16, берём нативные 9:16. */
export function coverImageSize(model: OpenAiImageModel, aspect: Aspect, portrait34 = false): string {
  if (aspect === "square") return "1024x1024";
  if (model === "gpt-image-1") return "1024x1536";
  // 3:4 (режим MODEL, 01.10.2026) — безопасная зона для сетки Instagram, см. STORY_34_BODY_HEIGHT.
  return portrait34 ? "1152x1536" : "1152x2048";
}

/** Вертикаль для модели рисуется в 3:4 только у gpt-image-2.x в режиме MODEL; gpt-image-1 знает один размер 1024×1536. */
export function usesPortrait34(model: OpenAiImageModel, textMode: CoverTextMode | undefined): boolean {
  return textMode !== "OVERLAY" && model !== "gpt-image-1";
}

async function requestImages(params: {
  apiKey: string;
  model: OpenAiImageModel;
  photo: Buffer;
  reference: Buffer;
  /** null — логотип модели не отдаём (MODEL: знак кладём мы сами). */
  logo: Buffer | null;
  prompt: string;
  aspect: Aspect;
  /** Вертикаль 3:4 вместо 9:16 (см. coverImageSize). */
  portrait34?: boolean;
  quality: OpenAiImageQuality;
  n: number;
  /** Порядок картинок: MODEL — «фото, логотип, эталон» (как в промте сайта); OVERLAY — «фото, эталон, логотип». */
  order?: "photo-logo-reference" | "photo-reference-logo";
  retryDelayMs?: number;
  /** Сюда складывается цена запроса (по usage, иначе по таблице). */
  onCost?: (usd: number) => void;
}): Promise<Buffer[]> {
  const size = coverImageSize(params.model, params.aspect, params.portrait34);
  const form = new FormData();
  form.append("model", params.model);
  form.append("prompt", params.prompt);
  form.append("quality", params.quality);
  form.append("size", size);
  form.append("output_format", "png");
  // input_fidelity есть только у gpt-image-1; 2.x держат входные картинки сами.
  if (params.model === "gpt-image-1") form.append("input_fidelity", "high");
  form.append("n", String(params.n));
  const photo = await toUploadPart(params.photo, 1536, false);
  const reference = await toUploadPart(params.reference, 1024, false);
  const logo = params.logo ? await toUploadPart(params.logo, 512, true) : null;
  form.append("image[]", photo, "photo.jpg");
  if (!logo) {
    form.append("image[]", reference, "style.jpg");
  } else if (params.order === "photo-logo-reference") {
    form.append("image[]", logo, "logo.png");
    form.append("image[]", reference, "style.jpg");
  } else {
    form.append("image[]", reference, "style.jpg");
    form.append("image[]", logo, "logo.png");
  }

  const started = Date.now();
  const tableCost = estimateImageCostUsd(params.quality, size === "1024x1024" ? "1024x1024" : "1024x1536");
  const logEach = async (count: number, ok: boolean, perImage: number | null) => {
    const ms = Date.now() - started;
    for (let i = 0; i < count; i++) {
      await logOpenAiCall({ endpoint: COVER_IMAGE_ENDPOINT, model: params.model, costUsd: ok ? perImage : null, ms, ok });
    }
  };
  try {
    const res = await openAiPost<ImagesResponse & { usage?: ImageUsage }>("/images/edits", {
      body: form,
      timeoutMs: OPENAI_IMAGE_TIMEOUT_MS,
      apiKey: params.apiKey,
      retryDelayMs: params.retryDelayMs,
    });
    const images = (res.data ?? []).map((d) => d.b64_json).filter((b): b is string => !!b).map((b) => Buffer.from(b, "base64"));
    if (images.length === 0) throw new OpenAiError("OpenAI вернул ответ без картинки", null, "empty");
    const total = imageCostFromUsage(res.usage) ?? tableCost * images.length;
    params.onCost?.(total);
    await logEach(images.length, true, total / images.length);
    // Деньги вернулись — предохранитель не нужен.
    resetOpenAiNoMoneyBreaker();
    return images;
  } catch (err) {
    if (isNoMoneyError(err)) {
      // Не засчитываем в дневной лимит картинок: ничего не нарисовано и не оплачено.
      tripOpenAiNoMoneyBreaker();
      await logOpenAiCall({ endpoint: COVER_IMAGE_NO_MONEY_ENDPOINT, model: params.model, costUsd: null, ms: Date.now() - started, ok: false });
      throw err;
    }
    // Неудача тоже в журнале: заказанные картинки учитываются лимитом дня.
    await logEach(params.n, false, null);
    throw err;
  }
}

interface ChatResponse {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function toDataUrl(image: Buffer): Promise<string> {
  const small = await sharp(image).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  return `data:image/jpeg;base64,${small.toString("base64")}`;
}

/** Вызов gpt-4.1-mini с картинками, ответ — JSON. Расход — в журнал ИИ. */
async function askVision<T>(apiKey: string, text: string, images: Buffer[], retryDelayMs?: number): Promise<{ answer: Partial<T>; costUsd: number }> {
  const started = Date.now();
  const content: Record<string, unknown>[] = [{ type: "text", text }];
  for (const img of images) content.push({ type: "image_url", image_url: { url: await toDataUrl(img) } });
  const res = await openAiPost<ChatResponse>("/chat/completions", {
    apiKey,
    timeoutMs: OPENAI_CHAT_TIMEOUT_MS,
    retryDelayMs,
    body: { model: COVER_CHECK_MODEL, response_format: { type: "json_object" }, messages: [{ role: "user", content }] },
  });
  const inputTokens = res.usage?.prompt_tokens ?? 0;
  const outputTokens = res.usage?.completion_tokens ?? 0;
  const costUsd = estimateCostUsd(COVER_CHECK_MODEL, { inputTokens, outputTokens }) ?? 0;
  await logOpenAiCall({ endpoint: COVER_CHECK_ENDPOINT, model: COVER_CHECK_MODEL, costUsd, ms: Date.now() - started, ok: true, inputTokens, outputTokens });
  let answer: Partial<T> = {};
  try {
    answer = JSON.parse(res.choices?.[0]?.message?.content ?? "{}") as Partial<T>;
  } catch {
    answer = {};
  }
  return { answer, costUsd };
}

export interface CoverInspection {
  rooms: number | null;
  price: string | null;
  area: string | null;
  floor: number | null;
  words: string[];
  photoSame: boolean;
  added: string | null;
}

export const INSPECT_PROMPT =
  "Картинка 1 — готовая рекламная обложка, картинка 2 — исходное фото объекта. " +
  "1) Прочитай с обложки число комнат, цену, площадь, этаж. " +
  "2) Выпиши ВСЕ слова, написанные на обложке, ровно как написаны (с опечатками, если они есть), без чисел. " +
  "3) Совпадает ли интерьер/фасад обложки с картинкой 2? " + PHOTO_SAME_RULE + " " +
  'Ответь только JSON: {"rooms": число|null, "price": "цифры как написаны"|null, "area": "число как написано"|null, "floor": число|null, "words": ["..."], "photo_same": true|false, "added": "что добавлено/убрано или пусто"}.';

export const PICK_PROMPT =
  "Это кандидатки рекламной обложки недвижимости (по порядку 1, 2, …) и последней — эталон стиля. " +
  "Выбери лучшую по чек-листу владельца: комнаты, цена и площадь читаются за секунду даже в маленьком превью; " +
  "стиль как на эталоне (стекло, золото, чисто, без перегруза); нижний блок этажа и района компактный; фото реалистичное. " +
  'Ответь только JSON: {"best": номер, "why": "кратко"}.';

function toIntOrNull(value: unknown): number | null {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

async function inspectCover(apiKey: string, candidate: Buffer, photo: Buffer, retryDelayMs?: number): Promise<{ inspection: CoverInspection; costUsd: number }> {
  const { answer, costUsd } = await askVision<Record<string, unknown>>(apiKey, INSPECT_PROMPT, [candidate, photo], retryDelayMs);
  return {
    inspection: {
      rooms: toIntOrNull(answer.rooms),
      price: answer.price != null ? String(answer.price) : null,
      area: answer.area != null ? String(answer.area) : null,
      floor: toIntOrNull(answer.floor),
      words: Array.isArray(answer.words) ? answer.words.map(String) : [],
      photoSame: answer.photo_same === true,
      added: typeof answer.added === "string" && answer.added.trim() ? answer.added.trim() : null,
    },
    costUsd,
  };
}

async function analyzeBlank(apiKey: string, candidate: Buffer, photo: Buffer, retryDelayMs?: number): Promise<{ analysis: BlankAnalysis; costUsd: number }> {
  const { answer, costUsd } = await askVision<Record<string, unknown>>(apiKey, ANALYZE_PROMPT, [candidate, photo], retryDelayMs);
  return {
    analysis: {
      symbols: Array.isArray(answer.symbols) ? answer.symbols.map(String).map((x) => x.trim()).filter(Boolean) : [],
      photoSame: answer.photo_same === true,
      added: typeof answer.added === "string" && answer.added.trim() ? answer.added.trim() : null,
    },
    costUsd,
  };
}

/** Латиница, похожая на кириллицу, и таджикские буквы → русская кириллица: читалка
 *  путает «T» и «Т», «Ӣ» и «И» (живой прогон 25.09 забраковал наш же точный текст). */
const LOOKALIKE: Record<string, string> = {
  A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У",
  Ӣ: "И", Ҳ: "Х", Ӯ: "У", Қ: "К", Ғ: "Г", Ҷ: "Ч",
};

/** Слово к виду для сравнения: верхний регистр, Ё→Е, похожие буквы в одну, без знаков препинания; «М2» → «М²». */
export function normalizeCoverWord(word: string): string {
  return word
    .toUpperCase()
    .replace(/[ABCEHKMOPTXYӢҲӮҚҒҶ]/g, (ch) => LOOKALIKE[ch] ?? ch)
    .replace(/Ё/g, "Е")
    .replace(/[«»"'.,:;|·()!?]/g, "")
    .replace(/^M/, "М")
    .replace(/^М2$/, "М²")
    .trim();
}

/** Белый список слов обложки: подписи, город, район по словам, бренд. */
export function allowedCoverWords(district: string | null, extra: string[] = []): Set<string> {
  const words = [...COVER_LABELS, "ROYAL", "HOME", "TJ", "ROYAL HOME TJ", ...extra.flatMap((w) => [w, ...w.split(/\s+/)])];
  if (district) words.push(district, ...district.split(/[\s-]+/));
  return new Set(words.map(normalizeCoverWord).filter(Boolean));
}

/** Все причины брака кандидатки. Пустой список — годна. */
/** Расстояние Левенштейна — «одна буква не та» у короткого слова. */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

/**
 * Все причины брака кандидатки. Пустой список — годна.
 *
 * `soft` собирает мягкие замечания — не брак (живой прогон v4, 25.09.2026):
 * - таджикские Ҳ→Х и Ӣ→И (сведены нормализацией, пометка остаётся);
 * - слово в одну букву от разрешённого: читалка gpt-4.1-mini сама ошибается
 *   («ОШӮНА», «ФИРДАВСЙ» на верной обложке ChatGPT Images 2.5);
 * - `photoSoft` — «фото изменено» только замечание: у Images 2.5 фото держится,
 *   а читалка находила «пропавшее кресло» на нетронутых кадрах.
 * Цифры (цена, площадь, комнаты, этаж) — всегда строго.
 */
export function coverDefects(facts: CoverFacts, inspection: CoverInspection, opts: { soft?: string[]; photoSoft?: boolean } = {}): string[] {
  const problems: string[] = [];
  const priceRead = (inspection.price ?? "").replace(/\D/g, "");
  if (priceRead !== facts.priceDigits) problems.push(`цена «${inspection.price ?? "нет"}» вместо ${facts.priceDigits}`);
  const areaRead = Number((inspection.area ?? "").replace(",", ".").replace(/[^\d.]/g, ""));
  const half = (n: number) => Math.round(n * 2) / 2;
  if (!inspection.area || !Number.isFinite(areaRead) || half(areaRead) !== half(facts.areaSqm)) {
    problems.push(`площадь «${inspection.area ?? "нет"}» вместо ${facts.areaSqm}`);
  }
  if (facts.rooms != null && inspection.rooms !== facts.rooms) problems.push(`комнат «${inspection.rooms ?? "нет"}» вместо ${facts.rooms}`);
  if (inspection.floor !== facts.floor) problems.push(`этаж «${inspection.floor ?? "нет"}» вместо ${facts.floor ?? "не показывать"}`);

  const allowed = allowedCoverWords(facts.district, facts.extraWords);
  const allowedList = [...allowed];
  const raw = inspection.words.flatMap((w) => w.split(/\s+/)).filter(Boolean);
  const stray: string[] = [];
  for (const word of raw) {
    const n = normalizeCoverWord(word);
    if (!n || /^\d+$/.test(n)) continue;
    if (allowed.has(n)) {
      if (/[ХИ]/.test(word.toUpperCase()) && /[ҲӢ]/.test([...COVER_LABELS, facts.district ?? ""].join(" ").toUpperCase()) && !/[ҲӢ]/.test(word.toUpperCase())) {
        const expected = allowedList.find((a) => a === n);
        if (expected && /МАСОХАТ|ФИРДАВСИ/.test(n)) opts.soft?.push(`мягкое замечание: «${word}» (Ҳ/Ӣ)`);
      }
      continue;
    }
    if (allowedList.some((a) => a.length >= 4 && editDistance(n, a) <= 1)) {
      opts.soft?.push(`мягкое замечание: «${word}» прочитано с одной буквой не той`);
      continue;
    }
    stray.push(n);
  }
  if (stray.length > 0) problems.push(`лишние или искажённые слова: ${[...new Set(stray)].join(", ")}`);
  if (!inspection.photoSame) {
    const note = `фото объекта изменено${inspection.added ? `: ${inspection.added}` : ""}`;
    if (opts.photoSoft) opts.soft?.push(`мягкое замечание: ${note}`);
    else problems.push(note);
  }
  return problems;
}

// ───────────────────────── обработка картинки ─────────────────────────

/**
 * Наш логотип, подогнанный по ширине LOGO_WIDTH. Логотип на сплошном чёрном фоне
 * (без прозрачности; такой лежит у владельца) — чёрное становится прозрачным по
 * яркости, иначе на обложке висит чёрный квадрат (живой прогон 25.09).
 */
export async function prepareLogo(logo: Buffer): Promise<Buffer> {
  const resized = await sharp(logo, { density: 300 }).resize({ width: LOGO_WIDTH, fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = resized;
  const corner = (i: number) => data[i] + data[i + 1] + data[i + 2] < 60 && data[i + 3] > 240;
  const last = (info.width * info.height - 1) * 4;
  if (corner(0) && corner(last)) {
    for (let i = 0; i < data.length; i += 4) {
      // Порог с полкой: всё темнее 40 — полностью прозрачно, 40…110 — плавный край,
      // иначе тёмно-серые пиксели фона получают полупрозрачность и вокруг знака
      // висит размытая «тень» (замечание владельца 26.09).
      const lum = Math.max(data[i], data[i + 1], data[i + 2]);
      const a = lum <= 40 ? 0 : lum >= 110 ? 255 : Math.round(((lum - 40) / 70) * 255);
      data[i + 3] = Math.min(data[i + 3], a);
    }
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

// ───────────────────────── знак внутри кремовой полосы (01.10.2026) ─────────────────────────

/**
 * Владелец 01.10.2026: знак «ROYAL HOME TJ» вылезал за край светлой полосы на фото. Полоса у модели
 * выходит шириной 205–250 px (на эталоне ~230), а знак стоял с x=131 при ширине ~160. Теперь ширину полосы
 * ЧИТАЕМ с пикселей тела на строках знака и вписываем знак внутрь по центру.
 *
 * «Кремовый» пиксель — светлый и малонасыщенный: все каналы выше порогов и разброс max−min небольшой
 * (кремовая плашка эталона ~ (245, 238, 220), спред ~25; золото и зелень панелей, тёмные тени фото сюда
 * не попадают). Порог 215/205/180 оставляет запас под JPEG-шум и лёгкий градиент полосы; спред 60 отсекает
 * жёлтое золото (r высокий, b низкий). Белая стена фото тоже «кремовая», но у полосы справа всегда идёт линия
 * или смена цвета, а край считается по МИНИМУМУ строк, так что единичный выброс не растянет знак.
 */
export const CREAM_MIN_R = 215;
export const CREAM_MIN_G = 205;
export const CREAM_MIN_B = 180;
export const CREAM_MAX_SPREAD = 60;
/** Сколько строк в диапазоне знака читаем. */
const STRIP_SAMPLE_ROWS = 6;
/** Край полосы — первое место, где подряд не кремовых пикселей не меньше этого (одиночный шум не в счёт). */
const STRIP_EDGE_RUN = 3;
/** Полоса уже этого — считаем, что её не нашли; шире половины кадра — это не полоса. */
const STRIP_MIN_WIDTH = 60;
/** Запасная ширина полосы, когда измерить не вышло: ниже минимума реально встречающихся 205 px. */
export const STRIP_FALLBACK_RIGHT = 200;
/** Отступ знака от краёв полосы — 4 % ширины кадра, но не больше трети самой полосы. */
const LOGO_STRIP_PAD_RATIO = 0.04;
/** Меньше этой высоты знак не делаем, пока отступ можно ужать до LOGO_STRIP_MIN_PAD. */
const LOGO_STRIP_MIN_HEIGHT = 110;
const LOGO_STRIP_MIN_PAD = 12;

export function isCreamPixel(r: number, g: number, b: number): boolean {
  return r > CREAM_MIN_R && g > CREAM_MIN_G && b > CREAM_MIN_B && Math.max(r, g, b) - Math.min(r, g, b) <= CREAM_MAX_SPREAD;
}

/**
 * Правый край кремовой полосы по сырым пикселям RGB (3 канала): на каждой строке идём слева, пока кремовый;
 * итог — МИНИМУМ по строкам. null — полосы нет (у левого края не кремовый пиксель, слишком узкая или шире половины кадра).
 */
export function stripRightEdge(raw: Buffer, width: number, rows: number[]): number | null {
  let edge = width;
  for (const y of rows) {
    const cream = (x: number): boolean => {
      const i = (y * width + x) * 3;
      return isCreamPixel(raw[i], raw[i + 1], raw[i + 2]);
    };
    if (!cream(0)) return null;
    let x = 0;
    while (x < width) {
      let run = 0;
      while (run < STRIP_EDGE_RUN && x + run < width && !cream(x + run)) run++;
      if (run === STRIP_EDGE_RUN || x + run >= width) break;
      x++;
    }
    edge = Math.min(edge, x);
  }
  return edge >= STRIP_MIN_WIDTH && edge <= width / 2 ? edge : null;
}

/** Ширина кремовой полосы тела вертикали 3:4 на строках знака (в координатах тела 1080×1440); null — не определилась. */
export async function measureCreamStrip(body: Buffer, box: { top: number; height: number } = MODEL_LOGO_BOX.story34): Promise<number | null> {
  const { data, info } = await sharp(body)
    .resize(COVER_SIZE, STORY_34_BODY_HEIGHT, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rows = Array.from({ length: STRIP_SAMPLE_ROWS }, (_, i) => box.top + Math.round((i * (box.height - 1)) / (STRIP_SAMPLE_ROWS - 1)));
  return stripRightEdge(data, info.width, rows);
}

/**
 * Куда и каким размером поставить знак, чтобы он целиком лёг в [pad, stripRight − pad] и стоял по центру полосы.
 * `stripRight` null — полосу измерить не вышло: прежний бокс, но правый край не дальше STRIP_FALLBACK_RIGHT.
 * Высота не больше `box.height`; слишком узкая полоса — знак мельче, но НЕ за край.
 */
export function fitLogoToStrip(
  logoAspect: number,
  stripRight: number | null,
  box: { height: number } = MODEL_LOGO_BOX.story34,
  frameWidth: number = COVER_SIZE
): { left: number; width: number; height: number } {
  const right = stripRight ?? STRIP_FALLBACK_RIGHT;
  const maxWidth = box.height * logoAspect;
  const fit = (pad: number) => {
    const width = Math.max(1, Math.floor(Math.min(right - 2 * pad, maxWidth)));
    return { width, height: Math.max(1, Math.round(width / logoAspect)) };
  };
  const pad = Math.min(Math.round(frameWidth * LOGO_STRIP_PAD_RATIO), Math.floor(right / 3));
  let res = fit(pad);
  if (res.height < LOGO_STRIP_MIN_HEIGHT) res = fit(Math.min(LOGO_STRIP_MIN_PAD, pad));
  return { left: Math.floor((right - res.width) / 2), width: res.width, height: res.height };
}

/** Знак владельца для вертикали 3:4 в координатах кадра 1080×1920: вписан в измеренную кремовую полосу тела. */
export async function placeLogoInStrip(ownerLogo: Buffer, body: Buffer): Promise<{ input: Buffer; left: number; top: number }> {
  const meta = await sharp(ownerLogo).metadata();
  const aspect = meta.width && meta.height ? meta.width / meta.height : 510 / 642;
  const fit = fitLogoToStrip(aspect, await measureCreamStrip(body));
  return {
    input: await sharp(ownerLogo).resize({ width: fit.width, height: fit.height, fit: "fill" }).png().toBuffer(),
    left: fit.left,
    top: STORY_34_TOP + MODEL_LOGO_BOX.story34.top,
  };
}

/** Квадрат 1080×1080 с нашим логотипом, PNG без потерь (из него же собирается вертикаль). */
export async function toSquareCanvas(image: Buffer, logo: Buffer | { input: Buffer; left: number; top: number } | null): Promise<Buffer> {
  const resized = await sharp(image).resize(COVER_SIZE, COVER_SIZE, { fit: "cover" }).png().toBuffer();
  if (!logo) return resized;
  const layer = Buffer.isBuffer(logo) ? { input: logo, left: LOGO_MARGIN, top: LOGO_MARGIN } : logo;
  return sharp(resized).composite([layer]).png().toBuffer();
}

/**
 * Вертикаль 1080×1920 ИЗ КВАДРАТА: квадрат ровно по центру (пиксели те же),
 * сверху и снизу — его увеличенная копия, blur 40, затемнение до ~35 % яркости и
 * мягкий градиент к границе квадрата, чтобы шов не читался.
 */
export async function storyFromSquare(square: Buffer, format: "jpeg" | "png" = "jpeg"): Promise<Buffer> {
  return storyAroundBody(square, COVER_SIZE, format);
}

/**
 * Общее для вертикалей из квадрата и из тела 3:4: тело ровно по центру 1080×1920
 * (пиксели те же), сверху и снизу — его увеличенная копия, blur 40, затемнение до ~35 %
 * и мягкий градиент к шву. `layers` кладутся поверх всего в координатах кадра 1080×1920.
 */
async function storyAroundBody(body: Buffer, bodyHeight: number, format: "jpeg" | "png", layers: OverlayOptions[] = []): Promise<Buffer> {
  const top = (STORY_HEIGHT - bodyHeight) / 2;
  const background = await sharp(body)
    .resize(COVER_SIZE, STORY_HEIGHT, { fit: "cover" })
    .blur(40)
    .modulate({ brightness: 0.35 })
    .png()
    .toBuffer();
  const fade = 160;
  const seam = Buffer.from(
    `<svg width="${COVER_SIZE}" height="${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient>
        <linearGradient id="b" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.45"/></linearGradient>
      </defs>
      <rect x="0" y="${top - fade}" width="${COVER_SIZE}" height="${fade}" fill="url(#t)"/>
      <rect x="0" y="${top + bodyHeight}" width="${COVER_SIZE}" height="${fade}" fill="url(#b)"/>
    </svg>`
  );
  const bodyPng = await sharp(body).resize(COVER_SIZE, bodyHeight, { fit: "cover" }).png().toBuffer();
  const out = sharp(background).composite([{ input: seam }, { input: bodyPng, left: 0, top }, ...layers]);
  return format === "png" ? out.png().toBuffer() : out.jpeg({ quality: 92 }).toBuffer();
}

// ───────────────────────── достройка 9:16 моделью (01.10.2026) ─────────────────────────

/**
 * Владелец 01.10.2026 забраковал размытые тёмные полосы сверху и снизу вертикали: «непрофессионально». Вместо них
 * тело 3:4 (с нашим знаком) кладём по центру холста 1152×2048, маской просим gpt-image-2.x дорисовать ТОЛЬКО верх и низ
 * (кремовая полоса идёт до самого края кадра, снизу продолжается зелёная панель, справа фото продолжается естественно),
 * а центр возвращаем ИЗ ОРИГИНАЛА пиксель в пиксель, с плавным переходом по шву. Один запрос, ~$0,024 на quality medium.
 * Любой сбой — вызывающий откатывается на размытый вариант `storyAroundBody`: публикация не страдает.
 */
export const OUTPAINT_QUALITY: OpenAiImageQuality = "medium";
const OUTPAINT_W = 1152;
const OUTPAINT_H = 2048;
const OUTPAINT_BODY_H = 1536; // 3:4 при ширине 1152
const OUTPAINT_TOP = (OUTPAINT_H - OUTPAINT_BODY_H) / 2; // 256
/** Перо шва в кадре 1080×1920 (56 px на холсте 1152×2048 × 0,9375). */
const OUTPAINT_FEATHER = 52;
export const OUTPAINT_PROMPT =
  "Дострой рекламную обложку недвижимости до формата 9:16: центр кадра (готовый дизайн) НЕ менять вообще, дорисовать только прозрачные области сверху и снизу. " +
  "СВЕРХУ: светлая кремовая вертикальная полоса слева продолжается вверх до самого края кадра той же ширины и того же цвета (на ней потом будет логотип, ничего на ней не рисовать); " +
  "справа от полосы фото комнаты продолжается естественно (потолок, верх стен, свет) — чёткое, без размытия и без тёмных полос. " +
  "СНИЗУ: тёмно-зелёная панель продолжается вниз до края кадра, гладкая, того же оттенка, без текста, значков и линий. " +
  "Никаких надписей, цифр и логотипов в новых областях.";

/**
 * Достройка тела 3:4 (1080×1440, знак уже на нём) до 1080×1920 одним запросом images/edits с маской.
 * Возвращает PNG 1080×1920; строки 240…1679 внутри пера — байт в байт тело. Бросает при любой ошибке
 * (429, таймаут, пустой ответ) — решение «чем заменить» за вызывающим. Цена идёт в `onCost` и в журнал ИИ.
 */
export async function outpaintStoryBody(params: {
  apiKey: string;
  model: OpenAiImageModel;
  /** Тело 3:4 с нашим знаком, любого размера в пропорции 3:4 (приводится к 1080×1440). */
  body: Buffer;
  quality?: OpenAiImageQuality;
  retryDelayMs?: number;
  onCost?: (usd: number) => void;
}): Promise<Buffer> {
  const quality = params.quality ?? OUTPAINT_QUALITY;
  const original = await sharp(params.body).resize(COVER_SIZE, STORY_34_BODY_HEIGHT, { fit: "cover" }).png().toBuffer();
  const upscaled = await sharp(original).resize(OUTPAINT_W, OUTPAINT_BODY_H, { fit: "fill" }).png().toBuffer();
  const transparent = { create: { width: OUTPAINT_W, height: OUTPAINT_H, channels: 4 as const, background: { r: 0, g: 0, b: 0, alpha: 0 } } };
  const canvas = await sharp(transparent).composite([{ input: upscaled, left: 0, top: OUTPAINT_TOP }]).png().toBuffer();
  // Маска: прозрачное — дорисовать (верх и низ), непрозрачное — сохранить (тело).
  const opaque = await sharp({ create: { width: OUTPAINT_W, height: OUTPAINT_BODY_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } } }).png().toBuffer();
  const mask = await sharp(transparent).composite([{ input: opaque, left: 0, top: OUTPAINT_TOP }]).png().toBuffer();

  const form = new FormData();
  form.append("model", params.model);
  form.append("prompt", OUTPAINT_PROMPT);
  form.append("quality", quality);
  form.append("size", `${OUTPAINT_W}x${OUTPAINT_H}`);
  form.append("output_format", "png");
  form.append("n", "1");
  form.append("image[]", new Blob([new Uint8Array(canvas)], { type: "image/png" }), "canvas.png");
  form.append("mask", new Blob([new Uint8Array(mask)], { type: "image/png" }), "mask.png");

  const started = Date.now();
  let out: Buffer;
  try {
    const res = await openAiPost<ImagesResponse & { usage?: ImageUsage }>("/images/edits", {
      body: form,
      timeoutMs: OPENAI_IMAGE_TIMEOUT_MS,
      apiKey: params.apiKey,
      retryDelayMs: params.retryDelayMs,
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new OpenAiError("OpenAI вернул ответ без картинки достройки", null, "empty");
    out = Buffer.from(b64, "base64");
    const cost = imageCostFromUsage(res.usage) ?? estimateImageCostUsd(quality, "1024x1536");
    params.onCost?.(cost);
    await logOpenAiCall({ endpoint: COVER_IMAGE_ENDPOINT, model: params.model, costUsd: cost, ms: Date.now() - started, ok: true });
  } catch (err) {
    // Неудача тоже в журнале: заказанная картинка учитывается лимитом дня.
    await logOpenAiCall({ endpoint: COVER_IMAGE_ENDPOINT, model: params.model, costUsd: null, ms: Date.now() - started, ok: false });
    throw err;
  }

  // Центр — из оригинала, не из ответа модели: перо только по шву, остальное байт в байт.
  // sharp: resize в цепочке выполняется ДО composite, поэтому композит и ресайз — отдельными вызовами.
  const stripes = await sharp(out).resize(COVER_SIZE, STORY_HEIGHT, { fit: "fill" }).removeAlpha().png().toBuffer();
  const fe = OUTPAINT_FEATHER / STORY_34_BODY_HEIGHT;
  const fade = Buffer.from(
    `<svg width="${COVER_SIZE}" height="${STORY_34_BODY_HEIGHT}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="${fe}" stop-color="#fff" stop-opacity="1"/>` +
      `<stop offset="${1 - fe}" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
      `<rect width="${COVER_SIZE}" height="${STORY_34_BODY_HEIGHT}" fill="url(#g)"/></svg>`
  );
  const softBody = await sharp(original).ensureAlpha().composite([{ input: fade, blend: "dest-in" }]).png().toBuffer();
  return sharp(stripes).composite([{ input: softBody, left: 0, top: STORY_34_TOP }]).png().toBuffer();
}

/** Сгенерированная вертикаль 1024×1536 → 1080×1620 + поля по 150 px = 1080×1920, логотип слева сверху кадра модели. */
export async function storyFromGenerated(
  image: Buffer,
  logo: Buffer | { input: Buffer; left: number; top: number } | null,
  opts: {
    portrait34?: boolean;
    format?: "jpeg" | "png";
    /**
     * Достройка верха и низа моделью (01.10.2026): получает тело 1080×1440 УЖЕ со знаком, возвращает кадр 1080×1920
     * или null. Не задана, вернула null или упала — края собираются из размытой затемнённой копии, как раньше.
     */
    extend?: (bodyWithLogo: Buffer) => Promise<Buffer | null>;
  } = {}
): Promise<Buffer> {
  // Тело 3:4 (gpt-image-2.x, MODEL): ровно по центру, края — достройка моделью или размытая копия; знак — в координатах кадра 1080×1920.
  if (opts.portrait34) {
    const format = opts.format ?? "jpeg";
    const layers: OverlayOptions[] = !logo ? [] : Buffer.isBuffer(logo) ? [{ input: logo, left: LOGO_MARGIN, top: STORY_34_TOP + LOGO_MARGIN }] : [logo];
    if (opts.extend) {
      const bodyPng = await sharp(image).resize(COVER_SIZE, STORY_34_BODY_HEIGHT, { fit: "cover" }).png().toBuffer();
      const bodyWithLogo = await sharp(bodyPng)
        .composite(layers.map((l) => ({ ...l, top: (l.top ?? 0) - STORY_34_TOP })))
        .png()
        .toBuffer();
      let extended: Buffer | null = null;
      try {
        extended = await opts.extend(bodyWithLogo);
      } catch {
        extended = null; // причину пишет сама достройка; обложка не должна страдать
      }
      if (extended) {
        const full = sharp(extended).resize(COVER_SIZE, STORY_HEIGHT, { fit: "fill" });
        return format === "png" ? full.png().toBuffer() : full.jpeg({ quality: 92 }).toBuffer();
      }
    }
    return storyAroundBody(image, STORY_34_BODY_HEIGHT, format, layers);
  }
  // Буфер — прежний логотип в углу; объект — место задано (знак «Royal Green» в координатах кадра 1080×1920).
  const layerAt = (padTop: number): OverlayOptions[] =>
    !logo ? [] : Buffer.isBuffer(logo) ? [{ input: logo, left: LOGO_MARGIN, top: padTop + LOGO_MARGIN }] : [logo];
  // Уже целая вертикаль 1080×1920 (фон — настоящее фото): полей не нужно.
  // Уже вертикаль 9:16 (настоящее фото или ChatGPT Images 2.x, 1152×2048): полей не нужно.
  const meta = await sharp(image).metadata();
  if (meta.width && meta.height && Math.abs(meta.width / meta.height - COVER_SIZE / STORY_HEIGHT) < 0.01) {
    const full = await sharp(image).resize(COVER_SIZE, STORY_HEIGHT).png().toBuffer();
    return sharp(full).composite(layerAt(STORY_PAD)).jpeg({ quality: 92 }).toBuffer();
  }
  const body = await sharp(image).resize(COVER_SIZE, STORY_BODY_HEIGHT, { fit: "cover" }).toBuffer();
  const extended = await sharp(body).extend({ top: STORY_PAD, bottom: STORY_PAD, left: 0, right: 0, background: PAD_COLOR }).png().toBuffer();
  return sharp(extended).composite(layerAt(STORY_PAD)).jpeg({ quality: 92 }).toBuffer();
}

// ───────────────────────── генерация без БД ─────────────────────────

export type CoverGeneration =
  | { ok: true; story: Buffer; square: Buffer; storyNote: string | null; softNotes: string[]; costUsd: number; images: number }
  | { ok: false; reason: string; costUsd: number; images: number };

/**
 * Одна обложка: до двух запросов по две кандидатки → проверка каждой → выбор
 * лучшей → sharp. Не бросает: любой сбой — `ok:false` с причиной для людей.
 */
export async function generateOpenAiCovers(input: {
  apiKey: string;
  photo: Buffer;
  /** Наш логотип (PNG/SVG); null — запасной `logo-fallback.svg`. */
  logo: Buffer | null;
  /** Свои эталоны из Настроек (MODEL); нет — встроенные «Royal Green». Нет вертикали — квадрат и для неё. */
  references?: { square: Buffer | null; story: Buffer | null };
  /** Сцена фона (MODEL); одна на оба формата. */
  scene?: CoverScene;
  values: CoverPosterValues;
  facts: CoverFacts;
  quality: OpenAiImageQuality;
  /** Кандидаток на картинку (1–2). */
  candidates: number;
  /** Кто пишет текст (v3); не задан — MODEL, как v2. */
  textMode?: CoverTextMode;
  /** Промежуточные шаги (сырой ответ, разбор, итог) — для живого прогона
   *  `scripts/cover-live-test.mts`; в продовом пути не задаётся. */
  /** Модель картинок; не задана — COVER_IMAGE_MODEL. */
  imageModel?: OpenAiImageModel;
  /** Фон в OVERLAY; не задан — ORIGINAL. */
  photoSource?: CoverPhotoSource;
  /** Каталог кэша цифр (тесты и живой прогон подменяют). */
  digitCacheDir?: string;
  /** Только квадрат, вертикаль — из него (живой прогон экономит бюджет). */
  skipStory?: boolean;
  trace?: (event: { aspect: Aspect; kind: "raw" | "analysis" | "composed" | "inspection"; index: number; data: Buffer | unknown }) => void;
  /** Сколько картинок ещё можно заказать сегодня. */
  imagesLeft: number;
  retryDelayMs?: number;
}): Promise<CoverGeneration> {
  let costUsd = 0;
  let images = 0;
  try {
    const ownerText = await loadOwnerPrompt();
    const model: OpenAiImageModel = input.imageModel ?? COVER_IMAGE_MODEL;
    const softNotes: string[] = [];
    const logoSource = input.logo ?? (await fs.readFile(FALLBACK_LOGO_PATH));
    // MODEL (29.09.2026): модель логотип не рисует — кладём знак владельца сами,
    // без тени, в светлую полосу, где он стоит на макетах. OVERLAY — как раньше.
    const modelMode = input.textMode !== "OVERLAY";
    const overlay = modelMode ? null : await prepareLogo(logoSource);
    const ownerLogo = modelMode ? await fs.readFile(OWNER_LOGO_PATH) : null;
    const story34 = usesPortrait34(model, input.textMode);
    const customReference = (aspect: Aspect): Buffer | null =>
      aspect === "story" ? (input.references?.story ?? input.references?.square ?? null) : (input.references?.square ?? null);
    /** `body` — готовая картинка вертикали: у 3:4 по ней измеряем кремовую полосу, чтобы знак не вылез за её края. */
    const placeLogo = async (aspect: Aspect, body?: Buffer): Promise<{ input: Buffer; left: number; top: number } | null> => {
      if (!ownerLogo) return overlay ? { input: overlay, left: LOGO_MARGIN, top: LOGO_MARGIN } : null;
      // Свой эталон: знак на нём стоит где угодно — ставит его модель, мы поверх не кладём.
      if (customReference(aspect)) return null;
      if (aspect === "story" && story34 && body) return placeLogoInStrip(ownerLogo, body);
      const box = aspect === "story" && story34 ? { ...MODEL_LOGO_BOX.story34, top: STORY_34_TOP + MODEL_LOGO_BOX.story34.top } : MODEL_LOGO_BOX[aspect];
      return { input: await sharp(ownerLogo).resize({ height: box.height }).png().toBuffer(), left: box.left, top: box.top };
    };

    const takeImages = (): number => {
      const n = Math.min(input.candidates, input.imagesLeft - images);
      if (n < 1) throw new OpenAiError("Достигнут дневной лимит картинок ChatGPT (Настройки → Обложки)", null, "daily_limit");
      images += n;
      return n;
    };
    const pickBest = async (passed: Buffer[], reference: Buffer): Promise<Buffer> => {
      if (passed.length === 1) return passed[0];
      const { answer, costUsd: c } = await askVision<{ best: unknown }>(input.apiKey, PICK_PROMPT, [...passed, reference], input.retryDelayMs);
      costUsd += c;
      const best = toIntOrNull(answer.best);
      return passed[best != null && best >= 1 && best <= passed.length ? best - 1 : 0];
    };

    /**
     * OVERLAY: модель рисует пустые панели → зрением: символы, фото, рамки панелей →
     * наш текст в рамки → финальная проверка как у MODEL (цифры, слова, фото).
     * Первая попытка — с золотой цифрой комнат от модели (если она есть); цифра
     * вышла криво или лишние символы — вторая без цифры, цифру кладём мы. Рамки
     * невалидны — на второй попытке раскладка эталона `FIXED_PANELS`.
     */
    const bestOfOverlay = async (aspect: Aspect): Promise<Buffer> => {
      const reference = await fs.readFile(REFERENCE_PATHS[aspect]);
      const [W, H] = aspect === "square" ? [COVER_SIZE, COVER_SIZE] : [COVER_SIZE, STORY_BODY_HEIGHT];
      // Двузначное число (10+ комнат) и площадь модели не доверяем — крупную цифру кладёт наш слой.
      let withDigit = !!input.values.roomsNumber && input.values.roomsNumber.length === 1;
      let lastProblems: string[] = [];
      for (const attempt of [0, 1]) {
        const n = takeImages();
        const candidates = await requestImages({
          apiKey: input.apiKey,
          model,
          photo: input.photo,
          reference,
          logo: logoSource,
          prompt: buildOverlayPrompt({ ownerText, values: input.values, aspect, withDigit, strict: attempt > 0 }),
          aspect,
          quality: input.quality,
          n,
          retryDelayMs: input.retryDelayMs,
          onCost: (usd) => (costUsd += usd),
        });

        const passed: Buffer[] = [];
        let digitFailed = false;
        for (const [index, candidate] of candidates.entries()) {
          input.trace?.({ aspect, kind: "raw", index, data: candidate });
          const { analysis, costUsd: c } = await analyzeBlank(input.apiKey, candidate, input.photo, input.retryDelayMs);
          costUsd += c;
          input.trace?.({ aspect, kind: "analysis", index, data: analysis });
          if (!analysis.photoSame) {
            lastProblems = [`фото объекта изменено${analysis.added ? `: ${analysis.added}` : ""}`];
            continue;
          }
          const symbols = analysis.symbols.map(normalizeCoverWord).filter(Boolean);
          let drawDigit: boolean;
          if (symbols.length === 0) drawDigit = true;
          else if (withDigit && symbols.length === 1 && symbols[0] === input.values.roomsNumber) drawDigit = false;
          else {
            if (withDigit) digitFailed = true;
            lastProblems = [`модель нарисовала лишние символы: ${analysis.symbols.join(", ")}`];
            continue;
          }
          const composed = await overlayCoverText(candidate, W, H, input.values, FIXED_PANELS[aspect], drawDigit, aspect);
          input.trace?.({ aspect, kind: "composed", index, data: composed });
          const { inspection, costUsd: c2 } = await inspectCover(input.apiKey, composed, input.photo, input.retryDelayMs);
          costUsd += c2;
          input.trace?.({ aspect, kind: "inspection", index, data: inspection });
          const problems = coverDefects(input.facts, inspection);
          if (problems.length === 0) passed.push(composed);
          else lastProblems = [`после наложения текста: ${problems.join("; ")}`];
        }
        if (passed.length > 0) return pickBest(passed, reference);
        if (digitFailed) withDigit = false;
      }
      throw new OpenAiError(`ChatGPT сделал брак: ${lastProblems.join("; ")}`, null, "defect");
    };

    const bestOfModel = async (aspect: Aspect): Promise<Buffer> => {
      const custom = customReference(aspect);
      // 3:4 — эталон квадратный (тот же дизайн, вытянутый по высоте); 9:16-эталон только у старого пути.
      const portrait34 = aspect === "story" && story34;
      const reference = custom ?? (await fs.readFile(MODEL_REFERENCE_PATHS[portrait34 ? "square" : aspect]));
      let lastProblems: string[] = [];
      for (const strict of [false, true]) {
        const n = takeImages();
        const candidates = await requestImages({
          apiKey: input.apiKey,
          model,
          photo: input.photo,
          reference,
          logo: custom ? ownerLogo : null,
          prompt: buildCoverPrompt({ values: input.values, aspect, strict, customReference: !!custom, scene: input.scene, portrait34 }),
          aspect,
          portrait34,
          quality: input.quality,
          n,
          order: "photo-logo-reference",
          retryDelayMs: input.retryDelayMs,
          onCost: (usd) => (costUsd += usd),
        });

        const passed: Buffer[] = [];
        for (const [index, candidate] of candidates.entries()) {
          input.trace?.({ aspect, kind: "raw", index, data: candidate });
          const { inspection, costUsd: c } = await inspectCover(input.apiKey, candidate, input.photo, input.retryDelayMs);
          costUsd += c;
          input.trace?.({ aspect, kind: "inspection", index, data: inspection });
          const soft: string[] = [];
          // Фото модель перерисовывает намеренно (владелец 29.09) — «изменено» лишь замечание. Кроме
          // сцены INTERIOR (01.10.2026): там комната должна остаться ТОЙ ЖЕ, «изменено» — брак, и
          // срабатывает обычный перебор кандидаток и усиленный повтор. В остальных сценах свет и фон
          // меняются намеренно (закат, карта, «Сейчас → Можно так»).
          const problems = coverDefects(input.facts, inspection, { soft, photoSoft: (input.scene ?? "INTERIOR") !== "INTERIOR" });
          // Знак кладём мы: нарисованный моделью логотип дал бы второй, кривой.
          const brand = inspection.words.flatMap((w) => w.split(/\s+/)).map(normalizeCoverWord);
          if (!custom && brand.some((w) => w === normalizeCoverWord("ROYAL") || w === normalizeCoverWord("HOME"))) problems.push("модель нарисовала свой логотип");
          input.trace?.({ aspect, kind: "inspection", index: 100 + index, data: { problems, soft } });
          softNotes.push(...soft);
          if (problems.length === 0) passed.push(candidate);
          else lastProblems = problems;
        }
        if (passed.length > 0) return pickBest(passed, reference);
      }
      throw new OpenAiError(`ChatGPT сделал брак: ${lastProblems.join("; ")}`, null, "defect");
    };

    /** Объёмная цифра от ChatGPT: из кэша или одной генерацией на прозрачном фоне. null — не вышло, цифру рисуем мы. */
    let digitSprite: Buffer | null | undefined;
    const loadDigit = async (): Promise<Buffer | null> => {
      if (digitSprite !== undefined) return digitSprite;
      const digit = input.values.roomsNumber;
      if (!digit || digit.length > 1) return (digitSprite = null);
      const dir = input.digitCacheDir ?? DIGIT_CACHE_DIR;
      const file = path.join(dir, `${digit}-${COVER_PROMPT_VERSION}.png`);
      const cached = await fs.readFile(file).catch(() => null);
      if (cached) return (digitSprite = cached);
      if (images >= input.imagesLeft) return (digitSprite = null);
      images++;
      const started = Date.now();
      try {
        const res = await openAiPost<ImagesResponse>("/images/generations", {
          apiKey: input.apiKey,
          timeoutMs: OPENAI_IMAGE_TIMEOUT_MS,
          retryDelayMs: input.retryDelayMs,
          body: { model, prompt: DIGIT_PROMPT(digit), size: "1024x1024", quality: input.quality, background: "transparent", output_format: "png", n: 1 },
        });
        const b64 = res.data?.[0]?.b64_json;
        if (!b64) throw new OpenAiError("OpenAI вернул ответ без картинки цифры", null, "empty");
        const cost = imageCostFromUsage((res as { usage?: ImageUsage }).usage) ?? estimateImageCostUsd(input.quality, "1024x1024");
        costUsd += cost;
        await logOpenAiCall({ endpoint: COVER_IMAGE_ENDPOINT, model, costUsd: cost, ms: Date.now() - started, ok: true });
        const sprite = Buffer.from(b64, "base64");
        // Проверка зрением: ровно одна цифра N.
        const { answer, costUsd: c } = await askVision<{ symbols: unknown }>(
          input.apiKey,
          'Выпиши все символы на картинке. Ответь только JSON: {"symbols": ["..."]}.',
          [await sharp(sprite).flatten({ background: "#1a1a1a" }).png().toBuffer()],
          input.retryDelayMs
        );
        costUsd += c;
        const symbols = Array.isArray(answer.symbols) ? answer.symbols.map(String).map((x) => x.trim()).filter(Boolean) : [];
        input.trace?.({ aspect: "square", kind: "raw", index: 99, data: sprite });
        if (symbols.length !== 1 || symbols[0] !== digit) return (digitSprite = null);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(file, sprite);
        return (digitSprite = sprite);
      } catch (err) {
        await logOpenAiCall({ endpoint: COVER_IMAGE_ENDPOINT, model, costUsd: null, ms: Date.now() - started, ok: false });
        void logSystemError("ai", `Цифра обложки «${digit}» от ChatGPT не вышла — рисуем свою: ${err instanceof Error ? err.message : String(err)}`, {
          dedupKey: `cover-digit-fail:${digit}`,
        });
        return (digitSprite = null);
      }
    };

    /** OVERLAY + настоящее фото: фото не трогаем, цифра — ChatGPT (кэш), панели и текст — наши. */
    const bestOfOriginal = async (aspect: Aspect): Promise<Buffer> => {
      const [W, H] = aspect === "square" ? [COVER_SIZE, COVER_SIZE] : [COVER_SIZE, STORY_HEIGHT];
      const layout = aspect === "square" ? "square" : "storyFull";
      const digit = await loadDigit();
      const base = await originalPhotoBase(input.photo, W, H, digit, layout);
      const composed = await overlayCoverText(base, W, H, input.values, FIXED_PANELS[layout], !digit, layout);
      input.trace?.({ aspect, kind: "composed", index: 0, data: composed });
      const { inspection, costUsd: c } = await inspectCover(input.apiKey, composed, input.photo, input.retryDelayMs);
      costUsd += c;
      input.trace?.({ aspect, kind: "inspection", index: 0, data: inspection });
      // Фото наше и не менялось — проверяем только читаемость цифр и слов.
      const problems = coverDefects(input.facts, { ...inspection, photoSame: true });
      if (problems.length > 0) throw new OpenAiError(`после наложения текста: ${problems.join("; ")}`, null, "defect");
      return composed;
    };

    const bestOf =
      input.textMode === "OVERLAY" ? ((input.photoSource ?? "ORIGINAL") === "ORIGINAL" ? bestOfOriginal : bestOfOverlay) : bestOfModel;
    const square = await toSquareCanvas(await bestOf("square"), await placeLogo("square"));
    let story: Buffer;
    let storyNote: string | null = null;
    try {
      if (input.skipStory) throw new OpenAiError("вертикаль не заказана (skipStory)", null, "skipped");
      const storyBody = await bestOf("story");
      /**
       * Достройка верха и низа моделью (01.10.2026, только 3:4 у gpt-image-2.x): одна картинка в дневной лимит и в цену.
       * Лимит исчерпан, 429, таймаут, пустой ответ — null: вертикаль соберётся из размытой копии, публикация идёт.
       */
      const extend = story34
        ? async (bodyWithLogo: Buffer): Promise<Buffer | null> => {
            if (images >= input.imagesLeft) {
              softNotes.push("достройка вертикали моделью пропущена (дневной лимит картинок), края — размытая копия");
              return null;
            }
            images++;
            try {
              return await outpaintStoryBody({ apiKey: input.apiKey, model, body: bodyWithLogo, retryDelayMs: input.retryDelayMs, onCost: (usd) => (costUsd += usd) });
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              softNotes.push(`достройка вертикали моделью не вышла, края — размытая копия: ${reason}`);
              void logSystemError("ai", `Достройка вертикали обложки до 9:16 не вышла — края размытой копией: ${reason}`, { dedupKey: "cover-outpaint-fail" });
              return null;
            }
          }
        : undefined;
      story = await storyFromGenerated(storyBody, await placeLogo("story", storyBody), { portrait34: story34, extend });
    } catch (err) {
      // Вертикаль не вышла — собираем из готового квадрата: лучше такая, чем никакой.
      storyNote = err instanceof OpenAiError ? err.message : describeError(err);
      story = await storyFromSquare(square);
    }
    return { ok: true, square: await sharp(square).jpeg({ quality: 92 }).toBuffer(), story, storyNote, softNotes: [...new Set(softNotes)], costUsd, images };
  } catch (err) {
    const reason = err instanceof OpenAiError ? err.message : `обработка картинки упала: ${describeError(err)}`;
    return { ok: false, reason, costUsd, images };
  }
}

// ───────────────────────── объект целиком ─────────────────────────

export interface PropertyCoverAttempt {
  ok: boolean;
  /** Причина отказа для людей; null при успехе. */
  reason: string | null;
  cached: boolean;
  squareUrl: string | null;
  storyUrl: string | null;
  story: Buffer | null;
  square: Buffer | null;
  costUsd: number;
  ms: number;
  /** Обложка собрана запасным путём — нашим шаблоном, ChatGPT не вышел (02.10.2026). */
  fallback?: boolean;
}

export interface CoverRuntimeSettings {
  coverGenerationEnabled: boolean;
  /** Кто рисует (28.09.2026): TEMPLATE — наш шаблон, OPENAI — ChatGPT. */
  coverProvider: CoverProvider;
  /** Фото под наш шаблон перерисовывает ChatGPT «как для журнала» (29.09.2026). */
  coverPhotoRedraw: boolean;
  /** Свои эталоны ChatGPT из Настроек (29.09.2026); null — встроенные. */
  coverReferenceSquareUrl: string | null;
  coverReferenceStoryUrl: string | null;
  openaiImageQuality: OpenAiImageQuality;
  openaiCoverDailyLimit: number;
  openaiCandidates: number;
  openaiTextMode: CoverTextMode;
  openaiPhotoSource: CoverPhotoSource;
  openaiImageModel: OpenAiImageModel;
  companyLogoUrl: string | null;
}

export async function loadCoverRuntimeSettings(): Promise<CoverRuntimeSettings> {
  const s = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { coverGenerationEnabled: true, coverProvider: true, coverPhotoRedraw: true, coverReferenceSquareUrl: true, coverReferenceStoryUrl: true, openaiImageQuality: true, openaiCoverDailyLimit: true, openaiCandidates: true, openaiTextMode: true, openaiPhotoSource: true, openaiImageModel: true, companyLogoUrl: true },
  });
  const textMode: CoverTextMode = isCoverTextMode(s?.openaiTextMode) ? s.openaiTextMode : "MODEL";
  return {
    coverGenerationEnabled: s?.coverGenerationEnabled ?? true,
    coverPhotoRedraw: s?.coverPhotoRedraw ?? true,
    coverReferenceSquareUrl: s?.coverReferenceSquareUrl ?? null,
    coverReferenceStoryUrl: s?.coverReferenceStoryUrl ?? null,
    coverProvider: (COVER_PROVIDERS as readonly string[]).includes(s?.coverProvider ?? "") ? (s!.coverProvider as CoverProvider) : DEFAULT_COVER_PROVIDER,
    openaiImageQuality: isOpenAiImageQuality(s?.openaiImageQuality) ? s.openaiImageQuality : "high",
    openaiCoverDailyLimit: s?.openaiCoverDailyLimit ?? 60,
    // Пусто — по режиму: OVERLAY 1, MODEL 2 (владелец, v3).
    openaiCandidates: s?.openaiCandidates === 1 || s?.openaiCandidates === 2 ? s.openaiCandidates : defaultCandidates(textMode),
    openaiTextMode: textMode,
    openaiPhotoSource: isCoverPhotoSource(s?.openaiPhotoSource) ? s.openaiPhotoSource : "ORIGINAL",
    openaiImageModel: isOpenAiImageModel(s?.openaiImageModel) ? s.openaiImageModel : COVER_IMAGE_MODEL,
    companyLogoUrl: s?.companyLogoUrl ?? null,
  };
}

/** Картинок ChatGPT заказано сегодня (по Душанбе), включая неудачные. */
export async function coverImagesUsedToday(): Promise<number> {
  return prisma.aiLog.count({ where: { endpoint: COVER_IMAGE_ENDPOINT, createdAt: { gte: dushanbeStartOfToday() } } });
}

/** Ширина логотипа из Настроек в пикселях; null — логотипа нет или не читается. */
export async function companyLogoWidth(companyLogoUrl: string | null): Promise<number | null> {
  if (!companyLogoUrl) return null;
  try {
    const meta = await sharp(path.join(uploadsDir, path.basename(companyLogoUrl))).metadata();
    return meta.width ?? null;
  } catch {
    return null;
  }
}

function inputHash(parts: Record<string, unknown>): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export const COVERS_DISABLED_REASON = "Обложки выключены в Настройках";

function fail(reason: string, started: number, costUsd = 0): PropertyCoverAttempt {
  return { ok: false, reason, cached: false, squareUrl: null, storyUrl: null, story: null, square: null, costUsd, ms: Date.now() - started };
}

/**
 * Обложка объекта от ChatGPT с кэшем, лимитом и записью в базу.
 * `dryRun` (пробная обложка в Настройках) — без кэша и без записи в объект;
 * `force` («Перерисовать обложку») — мимо кэша. Не бросает.
 */
export async function createPropertyCover(
  propertyId: string,
  options: { force?: boolean; dryRun?: boolean; retryDelayMs?: number; provider?: CoverProvider } = {}
): Promise<PropertyCoverAttempt> {
  const started = Date.now();
  const settings = await loadCoverRuntimeSettings();
  if (!settings.coverGenerationEnabled && !options.dryRun) return fail(COVERS_DISABLED_REASON, started);

  const property = await loadCoverProperty(propertyId);
  if (!property || property.deletedAt) return fail("Объект не найден или удалён", started);
  // Обложку поставили руками в карточке (29.09.2026) — публикация и добор её не
  // перерисовывают; заменить можно только кнопкой «Перерисовать» (force).
  if (
    !options.dryRun &&
    !options.force &&
    property.socialCoverInputHash?.startsWith(MANUAL_COVER_HASH_PREFIX) &&
    property.socialCoverSquareUrl &&
    property.socialCoverStoryUrl
  ) {
    return { ok: true, reason: null, cached: true, squareUrl: property.socialCoverSquareUrl, storyUrl: property.socialCoverStoryUrl, story: null, square: null, costUsd: 0, ms: Date.now() - started };
  }

  // Подложка — ТОЛЬКО главное фото карточки (первое по порядку галереи).
  const mainPhoto = property.photos[0];
  if (!mainPhoto) return fail("Нет фото в карточке объекта", started);

  const values = buildCoverPosterValues(
    {
      // Этаж и комнаты на обложке — только там, где они есть у типа
      // (propertyTypeFields.ts): у дома нет этажа, у участка — комнат.
      rooms: propertyFieldShown(property.type, "rooms") ? property.rooms : null,
      areaSqm: property.areaSqm,
      landAreaSotka: property.landAreaSotka,
      floor: propertyFieldShown(property.type, "floor") ? property.floor : null,
      price: property.price,
      currency: property.currency,
      districtName: property.district?.name ?? null,
      address: property.address,
    },
    await loadMoneyContext()
  );
  const provider = options.provider ?? settings.coverProvider;
  if (provider === "TEMPLATE") return createTemplateCover(property, property.photos, values, settings, options, started);

  let attempt: PropertyCoverAttempt;
  try {
    attempt = await createChatGptCover(property, values, settings, options, started);
  } catch (err) {
    attempt = fail(`непредвиденный сбой: ${describeError(err)}`, started);
  }
  // ChatGPT не вышел (нет денег, лимит дня, сбой, брак) — не оставляем публикацию без
  // обложки: строим её нашим шаблоном без единого вызова ИИ (владелец 02.10.2026).
  // Пробная обложка из Настроек проверяет именно ChatGPT — ей запасной путь не нужен.
  if (attempt.ok || options.dryRun) return attempt;
  return createFallbackTemplateCover(property, values, settings, started, attempt);
}

/** Объект для обложки: первые фото галереи (шаблон выбирает лучшее из них, ChatGPT-режим тоже). */
async function loadCoverProperty(propertyId: string) {
  return prisma.property.findUnique({
    where: { id: propertyId },
    // Для нашего шаблона обложке выбирается лучшее из первых фото (29.09.2026), ChatGPT-режим берёт первое.
    include: { district: true, photos: { orderBy: { order: "asc" }, take: COVER_PHOTO_PICK_LIMIT } },
  });
}
type CoverProperty = NonNullable<Awaited<ReturnType<typeof loadCoverProperty>>>;

/** Путь ChatGPT целиком: фото → картинки → проверка → запись. Отказ — `fail(...)`, не исключение. */
async function createChatGptCover(
  property: CoverProperty,
  values: CoverPosterValues,
  settings: CoverRuntimeSettings,
  options: { force?: boolean; dryRun?: boolean; retryDelayMs?: number },
  started: number
): Promise<PropertyCoverAttempt> {
  // Фото для ChatGPT — лучшее из первых фото объекта, не обязательно первое
  // (владелец 29.09: «чтобы не брал фото кухни»). Выбор помнится по набору фото.
  const pickKey = await resolveOpenAiKey();
  if (pickKey && isOpenAiNoMoneyBreakerOpen()) {
    return fail("OpenAI: нет денег на счёте — до пополнения обложки собираются запасным шаблоном", started);
  }
  const picked = await chooseCoverPhoto(pickKey?.key ?? null, property.photos, options.retryDelayMs);
  const chosen = picked.photo;
  const chosenPath = path.join(uploadsDir, path.basename(chosen.url));

  const facts = factsFromValues(values, propertyFieldShown(property.type, "floor") ? property.floor : null);
  const unfinished = isUnfinishedCondition(property.condition);
  const hash = inputHash({
    v: COVER_PROMPT_VERSION,
    values,
    // Без отделки — свои сцены (сама сцена случайна и в хэш не входит: иначе
    // кэш не срабатывал бы никогда и каждая публикация рисовала бы заново).
    unfinished,
    type: property.type,
    // Агент сменил главное фото — обложка перерисовывается.
    photo: `${chosen.id}:${chosen.url}`,
    quality: settings.openaiImageQuality,
    candidates: settings.openaiCandidates,
    textMode: settings.openaiTextMode,
    // Фон и логотип из Настроек нужны только OVERLAY: в MODEL их смена не должна
    // перерисовывать (и оплачивать) все обложки заново (аудит 29.09.2026).
    photoSource: settings.openaiTextMode === "OVERLAY" ? settings.openaiPhotoSource : null,
    imageModel: settings.openaiImageModel,
    logo: settings.openaiTextMode === "OVERLAY" ? settings.companyLogoUrl : null,
    references: [settings.coverReferenceSquareUrl, settings.coverReferenceStoryUrl],
  });

  if (!options.dryRun && !options.force && property.socialCoverInputHash === hash && property.socialCoverSquareUrl && property.socialCoverStoryUrl) {
    return {
      ok: true,
      reason: null,
      cached: true,
      squareUrl: property.socialCoverSquareUrl,
      storyUrl: property.socialCoverStoryUrl,
      story: null,
      square: null,
      costUsd: 0,
      ms: Date.now() - started,
    };
  }

  const key = await resolveOpenAiKey();
  if (!key) return fail("Ключ OpenAI не задан — вставьте его в Настройках → Обложки для соцсетей", started);

  const used = await coverImagesUsedToday();
  const imagesLeft = settings.openaiCoverDailyLimit - used;
  if (imagesLeft < 1) return fail(`Достигнут дневной лимит картинок ChatGPT: ${used} из ${settings.openaiCoverDailyLimit}`, started);

  // Сцена фона (владелец 29–30.09.2026): квартира с отделкой — «журнальный» интерьер;
  // без отделки, дом, участок, коммерция — случайная честная сцена без выдуманных комнат.
  // Снимок здания снаружи ищем, когда он нужен сценам (дом, коммерция, объект без отделки).
  let scene: CoverScene = "INTERIOR";
  let scenePath = chosenPath;
  let sceneCost = 0;
  const wantExterior = property.type === "HOUSE" || property.type === "COMMERCIAL" || unfinished;
  const facade = wantExterior ? await chooseCoverPhoto(key.key, property.photos, options.retryDelayMs, "facade") : null;
  sceneCost = facade?.costUsd ?? 0;
  const pool = scenePool(property.type, property.condition, Boolean(facade?.found));
  scene = pool[Math.floor(Math.random() * pool.length)] ?? "INTERIOR";
  if (FACADE_SCENES.includes(scene) && facade?.found) scenePath = path.join(uploadsDir, path.basename(facade.photo.url));
  facts.extraWords = SCENE_WORDS[scene];

  let photo: Buffer;
  try {
    photo = await fs.readFile(scenePath);
  } catch {
    return fail(`Файл фото не найден на диске (${path.basename(scenePath)})`, started);
  }
  const logo = settings.companyLogoUrl
    ? await fs.readFile(path.join(uploadsDir, path.basename(settings.companyLogoUrl))).catch(() => null)
    : null;

  const readReference = (url: string | null) =>
    url ? fs.readFile(path.join(uploadsDir, "cover-references", path.basename(url))).catch(() => null) : Promise.resolve(null);
  const [refSquare, refStory] = await Promise.all([readReference(settings.coverReferenceSquareUrl), readReference(settings.coverReferenceStoryUrl)]);

  const generated = await generateOpenAiCovers({
    apiKey: key.key,
    photo,
    logo,
    references: { square: refSquare, story: refStory },
    values,
    facts,
    quality: settings.openaiImageQuality,
    candidates: settings.openaiCandidates,
    textMode: settings.openaiTextMode,
    photoSource: settings.openaiPhotoSource,
    imageModel: settings.openaiImageModel,
    imagesLeft,
    retryDelayMs: options.retryDelayMs,
    scene,
  });
  if (!generated.ok) return fail(generated.reason, started, generated.costUsd + sceneCost);
  if (generated.softNotes.length > 0) console.info(`[cover-openai] объект ${property.id}: ${generated.softNotes.join("; ")}`);
  if (generated.storyNote && !options.dryRun) {
    void logSystemError("ai", `Обложка объекта ${property.id}: вертикаль ChatGPT не вышла (${generated.storyNote}) — собрана из квадрата`, {
      dedupKey: `cover-openai-story-fallback:${property.id}`,
    });
  }

  if (options.dryRun) {
    return { ok: true, reason: null, cached: false, squareUrl: null, storyUrl: null, story: generated.story, square: generated.square, costUsd: generated.costUsd, ms: Date.now() - started };
  }

  return storeCovers(property.id, generated.square, generated.story, hash, generated.costUsd + picked.costUsd + sceneCost, started, { guardManual: !options.force });
}

/** Запись пары обложек на диск и в объект — общая для ChatGPT и шаблона. */
/** Метка обложки, поставленной руками в карточке: кэш её держит, пока не нажмут «Перерисовать». */
export const MANUAL_COVER_HASH_PREFIX = "manual:";

/**
 * СВОЯ ОБЛОЖКА ИЗ КАРТОЧКИ ОБЪЕКТА (владелец, 29.09.2026: «видеть и заменять если
 * что»). Можно прислать квадрат, вертикаль или обе: недостающая собирается из
 * присланной (вертикаль — квадрат по центру на размытом фоне, квадрат — центр вертикали).
 * Сайт получает новую первую картинку сразу; соцсети — со следующей публикации.
 */
export async function storeManualCover(propertyId: string, input: { square: Buffer | null; story: Buffer | null }): Promise<MadePropertyCover> {
  if (!input.square && !input.story) throw new Error("Нужна хотя бы одна картинка");
  const square = input.square
    ? await sharp(input.square).rotate().resize(COVER_SIZE, COVER_SIZE, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer()
    : await sharp(input.story!).rotate().resize(COVER_SIZE, COVER_SIZE, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer();
  const story = input.story
    ? await sharp(input.story).rotate().resize(COVER_SIZE, STORY_HEIGHT, { fit: "cover" }).jpeg({ quality: 92 }).toBuffer()
    : await storyFromSquare(square);
  const stored = await storeCovers(propertyId, square, story, `${MANUAL_COVER_HASH_PREFIX}${Date.now()}`, 0, Date.now());
  if (!stored.ok || !stored.squareUrl || !stored.storyUrl) throw new Error(stored.reason ?? "обложка не записалась");
  void resyncPhotosIfPublished(propertyId, "обложка заменена вручную");
  return { squareUrl: stored.squareUrl, storyUrl: stored.storyUrl, cached: false };
}

/**
 * `guardManual` — запись АВТОМАТИЧЕСКОЙ обложки (аудит 04.10.2026, PUB13): проверка «обложка
 * поставлена руками» делается один раз по снимку карточки в начале, а между ней и записью
 * проходят минуты ожидания ChatGPT — ручная обложка, поставленная за это время, затиралась.
 * Поэтому запись условная: только если в карточке сейчас нет метки `manual:`. Не прошло —
 * файлы этой попытки убираются и возвращается ручная обложка как «из кэша». «Перерисовать»
 * (force) и сама ручная запись идут без защиты: они заменяют обложку намеренно.
 */
async function storeCovers(
  propertyId: string,
  square: Buffer,
  story: Buffer,
  hash: string,
  costUsd: number,
  started: number,
  options: { guardManual?: boolean } = {}
): Promise<PropertyCoverAttempt> {
  // Имя от объекта и времени: сайт кэширует картинку по адресу, старый файл не подменяется.
  const stamp = Date.now().toString(36);
  try {
    await fs.mkdir(propertyCoversDir, { recursive: true });
    const squareName = `${propertyId}-${stamp}-square.jpg`;
    const storyName = `${propertyId}-${stamp}-story.jpg`;
    await fs.writeFile(path.join(propertyCoversDir, squareName), square);
    await fs.writeFile(path.join(propertyCoversDir, storyName), story);
    const squareUrl = `/uploads/covers/${squareName}`;
    const storyUrl = `/uploads/covers/${storyName}`;
    const data = { socialCoverSquareUrl: squareUrl, socialCoverStoryUrl: storyUrl, socialCoverInputHash: hash, socialCoverError: null };
    if (options.guardManual) {
      // Условие через OR с null: «NOT startsWith» на пустом хэше в SQL даёт NULL и не пропустил бы
      // объект, у которого обложки ещё не было.
      const written = await prisma.property.updateMany({
        where: { id: propertyId, OR: [{ socialCoverInputHash: null }, { NOT: { socialCoverInputHash: { startsWith: MANUAL_COVER_HASH_PREFIX } } }] },
        data,
      });
      if (written.count === 0) {
        await Promise.all([fs.rm(path.join(propertyCoversDir, squareName), { force: true }), fs.rm(path.join(propertyCoversDir, storyName), { force: true })]);
        const current = await prisma.property.findUnique({ where: { id: propertyId }, select: { socialCoverSquareUrl: true, socialCoverStoryUrl: true } });
        if (!current?.socialCoverSquareUrl || !current.socialCoverStoryUrl) return fail("объект удалён или обложка пропала, пока рисовалась новая", started, costUsd);
        return { ok: true, reason: null, cached: true, squareUrl: current.socialCoverSquareUrl, storyUrl: current.socialCoverStoryUrl, story: null, square: null, costUsd, ms: Date.now() - started };
      }
    } else {
      await prisma.property.update({ where: { id: propertyId }, data });
    }
    return { ok: true, reason: null, cached: false, squareUrl, storyUrl, story, square, costUsd, ms: Date.now() - started };
  } catch (err) {
    return fail(`обложка не записалась на диск: ${describeError(err)}`, started, costUsd);
  }
}

/** Версия шаблонной обложки в хэше: поменяли шаблон/ретушь — кэш объектов сбрасывается. */
const TEMPLATE_COVER_VERSION = "royal-green-1";

/** Сколько первых фото объекта смотрит выбор обложки: дальше обычно детали и санузлы. */
export const COVER_PHOTO_PICK_LIMIT = 8;

export const COVER_FACADE_PICK_PROMPT =
  "Перед тобой фото одного объекта недвижимости, пронумерованы по порядку начиная с 1. " +
  "Найди ОДНО фото, где дом снят СНАРУЖИ целиком или большей частью (фасад здания, жилой комплекс). " +
  "Если такого фото нет — ответь 0. " +
  'Ответь только JSON: {"best": номер фото или 0}.';

export const COVER_PHOTO_PICK_PROMPT =
  "Перед тобой фото одного объекта недвижимости, пронумерованы по порядку начиная с 1. " +
  "Выбери ОДНО фото для рекламной обложки — то, что лучше всего продаёт объект: гостиная или самая просторная жилая " +
  "комната общим планом, светлая, с окном; для дома или участка может подойти фасад или двор. " +
  "НЕ выбирай: санузел, туалет, ванную, коридор, прихожую, кухню крупным планом, кладовку, подъезд, лестницу, " +
  "документы, планировки, скриншоты, тёмные и размытые снимки. " +
  'Ответь только JSON: {"best": номер фото}.';

/**
 * ВЫБОР ФОТО ДЛЯ ОБЛОЖКИ (владелец, 29.09.2026: «чтобы не брал фото кухни»).
 * Первое фото галереи агент ставит как придётся, поэтому дешёвая модель смотрит
 * первые `COVER_PHOTO_PICK_LIMIT` фото и выбирает общий план жилой комнаты.
 * Ответ помнится файлом по набору фото (`uploads/covers/pick/`) — повторная
 * обложка и добор второй раз не спрашивают. Нет ключа, одно фото, сбой или
 * ответ не по делу — первое фото, как раньше.
 */
export async function chooseCoverPhoto(
  apiKey: string | null,
  photos: { id: string; url: string }[],
  retryDelayMs?: number,
  /** facade — нужен именно фасад (сцена «закат»); нет его — `found: false`. */
  want: "room" | "facade" = "room"
): Promise<{ photo: { id: string; url: string }; costUsd: number; found: boolean }> {
  const first = { photo: photos[0], costUsd: 0, found: want === "room" };
  if (!apiKey || (want === "room" && photos.length < 2)) return first;
  const key = crypto.createHash("sha256").update(`${want}|` + photos.map((p) => `${p.id}:${p.url}`).join("|")).digest("hex");
  const memo = path.join(propertyCoversDir, "pick", `${key}.json`);
  try {
    const saved = JSON.parse(await fs.readFile(memo, "utf8")) as { id?: string | null };
    if (saved.id === null) return { ...first, found: false };
    const hit = photos.find((p) => p.id === saved.id);
    if (hit) return { photo: hit, costUsd: 0, found: true };
  } catch {
    // ещё не выбирали
  }
  const readable: { photo: { id: string; url: string }; image: Buffer }[] = [];
  for (const photo of photos) {
    const image = await fs.readFile(path.join(uploadsDir, path.basename(photo.url))).catch(() => null);
    if (image) readable.push({ photo, image });
  }
  if (readable.length < (want === "room" ? 2 : 1)) return first;
  // Нет денег на OpenAI — модель не спрашиваем (память выбора не пишем: выбор не состоялся).
  if (isOpenAiNoMoneyBreakerOpen()) return first;
  try {
    const prompt = want === "facade" ? COVER_FACADE_PICK_PROMPT : COVER_PHOTO_PICK_PROMPT;
    const { answer, costUsd } = await askVision<{ best: number }>(apiKey, prompt, readable.map((r) => r.image), retryDelayMs);
    const best = Number(answer.best);
    await fs.mkdir(path.dirname(memo), { recursive: true });
    if (!Number.isInteger(best) || best < 1 || best > readable.length) {
      // Фасада нет — запоминаем и это, чтобы не спрашивать снова.
      if (want === "facade") await fs.writeFile(memo, JSON.stringify({ id: null })).catch(() => undefined);
      return { photo: photos[0], costUsd, found: want === "room" };
    }
    const photo = readable[best - 1].photo;
    await fs.writeFile(memo, JSON.stringify({ id: photo.id })).catch(() => undefined);
    return { photo, costUsd, found: true };
  } catch (err) {
    if (isNoMoneyError(err)) tripOpenAiNoMoneyBreaker();
    void logSystemError("ai", `Обложка: выбор фото не удался (${describeError(err)}) — берём первое`, { dedupKey: "cover-photo-pick-fail" });
    return first;
  }
}

/**
 * Провайдер TEMPLATE (владелец, 28.09.2026): главное фото → светлая ретушь
 * (`coverPhotoRetouch.ts`, Gemini с кэшем по фото, без ключа — локально) →
 * наш SVG-шаблон из Настроек (по умолчанию «Royal Green»). Денег за объект не
 * стоит (кроме одной ретуши фото), лимит ChatGPT не расходует.
 */
async function createTemplateCover(
  property: { id: string; condition?: string | null; type?: string | null; socialCoverInputHash: string | null; socialCoverSquareUrl: string | null; socialCoverStoryUrl: string | null },
  photos: { id: string; url: string }[],
  values: CoverPosterValues,
  settings: CoverRuntimeSettings,
  options: { force?: boolean; dryRun?: boolean; retryDelayMs?: number },
  started: number
): Promise<PropertyCoverAttempt> {
  const [templates, tplSettings] = await Promise.all([
    listCoverTemplates(),
    prisma.settings.findUnique({ where: { id: "singleton" }, select: { coverTemplateMode: true, coverTemplateId: true, coverTemplateEnabledIds: true } }),
  ]);
  const template = pickCoverTemplate(templates, tplSettings ?? { coverTemplateMode: "FIXED", coverTemplateId: null, coverTemplateEnabledIds: [] });
  const key = await resolveOpenAiKey();
  const picked = await chooseCoverPhoto(key?.key ?? null, photos, options.retryDelayMs);
  const mainPhoto = picked.photo;
  const photoPath = path.join(uploadsDir, path.basename(mainPhoto.url));
  let costUsd = picked.costUsd;
  // Без отделки «журнальная» перерисовка выдала бы коробку за готовую квартиру —
  // таким объектам только честная ретушь света (владелец 29.09.2026).
  const redraw = settings.coverPhotoRedraw && !isUnfinishedCondition(property.condition) && !isExteriorType(property.type)
    ? { model: settings.openaiImageModel, quality: settings.openaiImageQuality }
    : null;
  const hash = inputHash({ v: TEMPLATE_COVER_VERSION, provider: "TEMPLATE", template: template.id, values, photo: `${mainPhoto.id}:${mainPhoto.url}`, logo: settings.companyLogoUrl, redraw });
  if (!options.dryRun && !options.force && property.socialCoverInputHash === hash && property.socialCoverSquareUrl && property.socialCoverStoryUrl) {
    return { ok: true, reason: null, cached: true, squareUrl: property.socialCoverSquareUrl, storyUrl: property.socialCoverStoryUrl, story: null, square: null, costUsd: 0, ms: Date.now() - started };
  }
  let photo: Buffer | null = null;
  // Перерисовка не вышла — обложка из обычной ретуши, а в кэш уходит хэш с пометкой,
  // который со следующим расчётом не совпадёт: завтра (лимит, ключ) попробуем снова.
  let storedHash = hash;
  if (redraw) {
    const imagesLeft = settings.openaiCoverDailyLimit - (await coverImagesUsedToday());
    const res = await redrawCoverPhoto(photoPath, {
      apiKey: key?.key ?? null,
      ...redraw,
      imagesLeft,
      endpoint: COVER_IMAGE_ENDPOINT,
      retryDelayMs: options.retryDelayMs,
    });
    costUsd += res.costUsd;
    if (res.ok) {
      photo = res.image;
    } else {
      storedHash = `${hash}:no-redraw`;
      if (!options.dryRun) {
        void logSystemError("ai", `Обложка объекта ${property.id}: фото не перерисовано ChatGPT (${res.reason}) — взята обычная ретушь`, {
          dedupKey: `cover-redraw-fail:${res.reason.slice(0, 60)}`,
        });
      }
    }
  }
  if (!photo) {
    try {
      photo = (await retouchCoverPhoto(photoPath)).image;
    } catch {
      return fail(`Файл фото не найден на диске (${path.basename(photoPath)})`, started, costUsd);
    }
  }
  const logoPath = settings.companyLogoUrl ? path.join(uploadsDir, path.basename(settings.companyLogoUrl)) : null;
  const [square, story] = await Promise.all([
    renderCoverPosterImage(photo, values, "square", logoPath, true, template),
    renderCoverPosterImage(photo, values, "story", logoPath, true, template),
  ]);
  if (options.dryRun) return { ok: true, reason: null, cached: false, squareUrl: null, storyUrl: null, story, square, costUsd, ms: Date.now() - started };
  return storeCovers(property.id, square, story, storedHash, costUsd, started, { guardManual: !options.force });
}

export interface MadePropertyCover {
  squareUrl: string;
  storyUrl: string;
  cached: boolean;
  /** Запасная обложка нашего шаблона вместо ChatGPT: добор `--only-fallback` её потом заменит. */
  fallback?: boolean;
}

/**
 * Метка запасной обложки в `socialCoverInputHash` (02.10.2026). Хэш ChatGPT никогда не
 * равен такой строке, поэтому со следующим вызовом, когда ChatGPT снова доступен, кэш
 * её не принимает и обложка перерисовывается. По метке же добор находит объекты на замену.
 */
export const FALLBACK_COVER_HASH_PREFIX = "fallback-template:";

/**
 * ЗАПАСНАЯ ОБЛОЖКА (владелец, 02.10.2026). ChatGPT не смог (кончились деньги, дневной
 * лимит, нет ключа, сбой, брак) — публикация не должна уходить без обложки. Строим её
 * нашим шаблоном «Royal Green»: настоящее фото первым кадром галереи + сильная
 * локальная ретушь уровня 2 (`strongRetouch`), НИ ОДНОГО вызова ИИ (ни выбор фото, ни перерисовка, ни Gemini).
 * Отменяет решение 25.09 «наш шаблон запасным путём не служит».
 *
 * Не вызывается, когда обложку руками поставили в карточке — «Перерисовать» её не
 * стирает и тут. Остальные отказы (выключены, объект удалён, нет фото) до сюда не доходят.
 */
async function createFallbackTemplateCover(
  property: CoverProperty,
  values: CoverPosterValues,
  settings: CoverRuntimeSettings,
  started: number,
  chatGpt: PropertyCoverAttempt
): Promise<PropertyCoverAttempt> {
  const reason = chatGpt.reason ?? "неизвестная причина";
  if (property.socialCoverInputHash?.startsWith(MANUAL_COVER_HASH_PREFIX)) return chatGpt;
  const failBoth = (why: string) => fail(`${reason}; запасная обложка шаблоном тоже не вышла: ${why}`, started, chatGpt.costUsd);

  let template: Awaited<ReturnType<typeof listCoverTemplates>>[number];
  try {
    // Всегда «Royal Green», а не шаблон из Настроек: запасная обложка должна быть узнаваемой.
    template = pickCoverTemplate(await listCoverTemplates(), { coverTemplateMode: "FIXED", coverTemplateId: DEFAULT_COVER_TEMPLATE_ID, coverTemplateEnabledIds: [] });
  } catch (err) {
    return failBoth(describeError(err));
  }
  // Фото без ИИ: первое фото галереи (`chooseCoverPhoto` без ключа не спрашивает модель).
  const mainPhoto = (await chooseCoverPhoto(null, property.photos)).photo;
  const photoPath = path.join(uploadsDir, path.basename(mainPhoto.url));
  const hash =
    FALLBACK_COVER_HASH_PREFIX +
    inputHash({ v: TEMPLATE_COVER_VERSION, provider: "FALLBACK", template: template.id, values, photo: `${mainPhoto.id}:${mainPhoto.url}`, logo: settings.companyLogoUrl, retouch: DEFAULT_LOCAL_RETOUCH_LEVEL });

  void logSystemError("ai", `Обложка объекта ${property.id}: ChatGPT не справился (${reason}) — собрана запасная обложка нашим шаблоном`, {
    dedupKey: `cover-fallback-template:${reason.slice(0, 60)}`,
  });
  // Шаблон детерминирован: те же входы — тот же результат, поэтому и при `force` не
  // перерисовываем и не досылаем сайту ту же картинку (иначе добор при мёртвом ChatGPT
  // каждый раз переписывал бы файлы).
  if (property.socialCoverInputHash === hash && property.socialCoverSquareUrl && property.socialCoverStoryUrl) {
    return { ok: true, reason: null, cached: true, squareUrl: property.socialCoverSquareUrl, storyUrl: property.socialCoverStoryUrl, story: null, square: null, costUsd: chatGpt.costUsd, ms: Date.now() - started, fallback: true };
  }
  let photo: Buffer;
  try {
    photo = (await retouchCoverPhoto(photoPath, { localOnly: true })).image;
  } catch {
    return failBoth(`файл фото не найден на диске (${path.basename(photoPath)})`);
  }
  try {
    const logoPath = settings.companyLogoUrl ? path.join(uploadsDir, path.basename(settings.companyLogoUrl)) : null;
    const [square, story] = await Promise.all([
      renderCoverPosterImage(photo, values, "square", logoPath, true, template),
      renderCoverPosterImage(photo, values, "story", logoPath, true, template),
    ]);
    // Всегда с защитой: запасная обложка ручную не заменяет и при force (см. проверку выше).
    const stored = await storeCovers(property.id, square, story, hash, chatGpt.costUsd, started, { guardManual: true });
    return stored.ok ? { ...stored, fallback: true } : failBoth(stored.reason ?? "не записалась");
  } catch (err) {
    return failBoth(describeError(err));
  }
}

function coverFailDedupKey(propertyId: string, reason: string): string {
  return isNoMoneyReason(reason) ? "cover-openai-fail:no-money" : `cover-openai-fail:${propertyId}`;
}

/**
 * Единая точка для конвейера публикации, добора и кнопки «Перерисовать»:
 * обложка от ChatGPT или `null`. `null` = публикуем без обложки; причина уже в
 * журнале ошибок и в `Property.socialCoverError`. Старая обложка с устаревшими
 * цифрами при этом снимается — чужая цена на сайте хуже, чем никакой картинки.
 */
export async function makePropertyCover(
  propertyId: string,
  options: { force?: boolean; retryDelayMs?: number; provider?: CoverProvider } = {}
): Promise<MadePropertyCover | null> {
  let attempt: PropertyCoverAttempt;
  try {
    attempt = await createPropertyCover(propertyId, options);
  } catch (err) {
    attempt = fail(`непредвиденный сбой: ${describeError(err)}`, Date.now());
  }
  if (attempt.ok && attempt.squareUrl && attempt.storyUrl) {
    // Б7 (25.09.2026): объект мог уже быть publishedOnSite ДО этой обложки —
    // ресинк первым делом отправлял только новый выход в EDITING/публикацию,
    // а «Перерисовать обложку» у уже AVAILABLE объекта картинку на сайте не
    // трогала вовсе. Кэш (attempt.cached) ничего на диске не поменял — сайту
    // нечего досылать.
    if (!attempt.cached) void resyncPhotosIfPublished(propertyId, "новая обложка объекта");
    return { squareUrl: attempt.squareUrl, storyUrl: attempt.storyUrl, cached: attempt.cached, ...(attempt.fallback ? { fallback: true } : {}) };
  }
  const reason = attempt.reason ?? "неизвестная причина";
  if (reason === COVERS_DISABLED_REASON) return null;
  // Обложку поставили руками — неудачная «Перерисовать» её не стирает (аудит 29.09.2026):
  // цифры на ней человек проверил сам; причину отказа всё равно пишем.
  const current = await prisma.property.findUnique({ where: { id: propertyId }, select: { socialCoverInputHash: true } }).catch(() => null);
  if (current?.socialCoverInputHash?.startsWith(MANUAL_COVER_HASH_PREFIX)) {
    void logSystemError("ai", `Обложка объекта ${propertyId} не перерисована: ${reason} — оставлена поставленная вручную`, { dedupKey: coverFailDedupKey(propertyId, reason) });
    await prisma.property.update({ where: { id: propertyId }, data: { socialCoverError: reason } }).catch(() => undefined);
    return null;
  }
  void logSystemError("ai", `Обложка объекта ${propertyId} не создана: ${reason}`, { dedupKey: coverFailDedupKey(propertyId, reason) });
  await prisma.property
    .update({
      where: { id: propertyId },
      data: { socialCoverError: reason, socialCoverSquareUrl: null, socialCoverStoryUrl: null, socialCoverInputHash: null },
    })
    .catch((err: unknown) => {
      console.error("[cover-openai] не записал причину отказа:", describeError(err));
    });
  // Обложки на сайте больше нет (обнулили выше) — если объект уже опубликован,
  // сайт иначе держит старую картинку с устаревшими цифрами до следующего
  // случайного повода досослаться.
  void resyncPhotosIfPublished(propertyId, "обложка объекта снята");
  return null;
}

/** Обложки объекта для площадок: вертикаль (Reels, сторис, Telegram) и квадрат (лента, Facebook, YouTube, сайт, первый слайд карусели). */
export function coverUrlsFor(property: { socialCoverStoryUrl: string | null; socialCoverSquareUrl: string | null }): {
  story: string | null;
  square: string | null;
} {
  return { story: property.socialCoverStoryUrl, square: property.socialCoverSquareUrl };
}
