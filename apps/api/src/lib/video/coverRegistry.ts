/**
 * РЕЕСТР ШАБЛОНОВ ОБЛОЖКИ (владелец, 23.09.2026).
 *
 * Шаблон = пара «геометрия + числа», ровно как исходники владельца:
 *  • ВСТРОЕННЫЙ «Royal Gold» — геометрия кодом (`coverTemplate.ts`), числа
 *    оттуда же (перенесены из `spec.json` владельца). Не удаляется, участвует
 *    в выборе всегда, когда включён.
 *  • СВОЙ шаблон — строка `CoverTemplate` в базе: очищенный SVG-слой с
 *    подстановками (`{{rooms}}`, `{{price}}`, …) и разобранный `spec.json`.
 *    Подстановки, а не собственный движок раскладки: владелец правит свой
 *    SVG в редакторе, а CRM только подставляет значения объекта — иначе
 *    пришлось бы заводить второй движок рисования (тот же довод, по которому
 *    текст не рисует ИИ, см. докстринг `coverPoster.ts`).
 *
 * ВЫБОР НА ПУБЛИКАЦИЮ: `pickCoverTemplate()` — «Один и тот же» (FIXED) или
 * «Случайный» (RANDOM) среди отмеченных. Одна публикация = один шаблон на все
 * сети: выбирается ОДИН раз в `publishHandoffResult` и передаётся дальше.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_COVER_TEMPLATE_ID,
  DEFAULT_COVER_TEMPLATE_ID,
  COVER_SQUARE,
  COVER_STORY,
  coverFormatsFromSpec,
  coverTemplateSpecSchema,
  type CoverFormat,
  type CoverSelectionMode,
  type CoverTemplateSpec,
  type CoverTemplateSummary,
} from "@royal-home/shared";
import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { COVER_SLOGAN, measureCoverText } from "./coverTemplate.js";
import type { CoverMetricsWeight } from "./coverMetrics.js";

export interface CoverTemplateRecord {
  id: string;
  name: string;
  builtin: boolean;
  formats: CoverFormat[];
  /** Только у своего шаблона: путь к очищенному SVG и его spec. */
  svgUrl?: string;
  spec?: CoverTemplateSpec;
  leavesUrl?: string | null;
  logoUrl?: string | null;
  createdAt?: Date;
  /** Встроенный SVG-шаблон (живёт в `assets/cover/templates`): свой файл на
   *  каждый формат — у квадрата и вертикали разная раскладка, не растяжение. */
  svgFiles?: Partial<Record<CoverFormat, string>>;
  /** Встроенный SVG-шаблон: слой листьев на формат (те же файлы, что у «Royal Gold»). */
  leavesFiles?: Partial<Record<CoverFormat, string>>;
  /** Куда ставится настоящий логотип из Настроек; нет логотипа — шаблон
   *  рисует свой векторный знак (блок `data-if="vectorLogo"`). */
  logoBoxes?: Partial<Record<CoverFormat, { left: number; top: number; size: number }>>;
  /** Листья поверх SVG-слоя, а не под ним: у «Royal Green» размытые листья
   *  лежат ПЕРЕД панелью и лентой, как на эталоне. */
  leavesOnTop?: boolean;
}

/** Ассеты встроенных шаблонов — путь от скомпилированного файла, как в `coverPoster.ts`. */
const COVER_ASSETS_DIR = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "assets", "cover");

export const BUILTIN_COVER_TEMPLATE: CoverTemplateRecord = {
  id: BUILTIN_COVER_TEMPLATE_ID,
  name: "Royal Gold",
  builtin: true,
  formats: ["square", "story"],
};

/**
 * Второй встроенный — «Royal Gold · ChatGPT» (владелец, 24.09.2026): пакет,
 * который владелец получил у ChatGPT по нашему ТЗ (`docs/cover-sources-23-09/template/`).
 * Стиль пакета сохранён (векторный знак, золотой градиент плашки, разделитель,
 * блок этажа справа), а раскладка перенесена внутрь безопасной зоны кропов —
 * исходник клал цену/площадь/адрес ниже неё (квадрат до y=1051 при зоне до 865),
 * см. `docs/handoff-2026-09-24-cover-template-chatgpt.md`. Геометрия — файлами SVG,
 * как у своих шаблонов, чтобы не заводить второй движок раскладки кодом.
 */
export const CHATGPT_COVER_TEMPLATE_ID = "royal-gold-chatgpt";
export const CHATGPT_COVER_TEMPLATE: CoverTemplateRecord = {
  id: CHATGPT_COVER_TEMPLATE_ID,
  name: "Royal Gold · ChatGPT",
  builtin: true,
  formats: ["square", "story"],
  svgFiles: {
    square: path.join(COVER_ASSETS_DIR, "templates", "royal-gold-chatgpt-square.svg"),
    story: path.join(COVER_ASSETS_DIR, "templates", "royal-gold-chatgpt-story.svg"),
  },
  leavesFiles: {
    square: path.join(COVER_ASSETS_DIR, "leaves-square.png"),
    story: path.join(COVER_ASSETS_DIR, "leaves-story.png"),
  },
  logoBoxes: {
    square: { left: 474, top: 222, size: 132 },
    story: { left: 450, top: 468, size: 180 },
  },
};

/**
 * «Royal Green» (владелец, 29.09.2026 — вторая версия по его макетам
 * `docs/cover-sources-29-09/reference-{square,story}.webp`): светлая полоса слева
 * сверху со знаком «ROYAL HOME TJ», тёмно-зелёная панель по диагонали, серифная
 * золотая цифра, кремовая плашка цены, три блока внизу. Шаблон ПО УМОЛЧАНИЮ.
 * Логотип — знак владельца, вшит в SVG (`royal-green-logo.png`): логотип из
 * Настроек (160 px) здесь не берётся, поэтому `logoBoxes` нет. Листьев нет.
 * SVG собирает `assets/cover/templates/royal-green.build.mjs`, у квадрата и
 * вертикали своя раскладка — как на макетах.
 */
export const GREEN_COVER_TEMPLATE_ID = DEFAULT_COVER_TEMPLATE_ID;
export const GREEN_COVER_TEMPLATE: CoverTemplateRecord = {
  id: GREEN_COVER_TEMPLATE_ID,
  name: "Royal Green",
  builtin: true,
  formats: ["square", "story"],
  svgFiles: {
    square: path.join(COVER_ASSETS_DIR, "templates", "royal-green-square.svg"),
    story: path.join(COVER_ASSETS_DIR, "templates", "royal-green-story.svg"),
  },
};

/** Шаблон рисуется SVG-файлом (свой или встроенный SVG), а не кодом «Royal Gold». */
export function isSvgCoverTemplate(template: CoverTemplateRecord): boolean {
  return template.id !== BUILTIN_COVER_TEMPLATE_ID && Boolean(template.svgFiles || template.svgUrl);
}

export function coverFormatSize(format: CoverFormat): { width: number; height: number } {
  return format === "square" ? { ...COVER_SQUARE } : { ...COVER_STORY };
}

/** Все шаблоны: встроенный плюс загруженные владельцем. */
export async function listCoverTemplates(): Promise<CoverTemplateRecord[]> {
  const custom = await prisma.coverTemplate.findMany({ orderBy: { createdAt: "asc" }, take: 50 });
  const parsed: CoverTemplateRecord[] = [];
  for (const row of custom) {
    const spec = coverTemplateSpecSchema.safeParse(row.spec);
    if (!spec.success) {
      // Шаблон в базе перестал проходить проверку (правили руками, менялась
      // схема) — он просто не участвует в выборе, публикация не встаёт.
      void logSystemError("storage", `Шаблон обложки ${row.id}: spec.json не проходит проверку — шаблон пропущен`, {
        dedupKey: `cover-template-bad-spec:${row.id}`,
      });
      continue;
    }
    parsed.push({
      id: row.id,
      name: row.name,
      builtin: false,
      formats: coverFormatsFromSpec(spec.data),
      svgUrl: row.svgUrl,
      spec: spec.data,
      leavesUrl: row.leavesUrl,
      logoUrl: row.logoUrl,
      createdAt: row.createdAt,
    });
  }
  return [GREEN_COVER_TEMPLATE, BUILTIN_COVER_TEMPLATE, CHATGPT_COVER_TEMPLATE, ...parsed];
}

export interface CoverTemplateSettings {
  coverTemplateMode: string;
  coverTemplateId: string | null;
  coverTemplateEnabledIds: string[];
}

/** Отмечен ли шаблон «участвует в выборе». По умолчанию отмечен «Royal Green». */
export function isCoverTemplateEnabled(id: string, settings: CoverTemplateSettings): boolean {
  if (settings.coverTemplateEnabledIds.length === 0) return id === DEFAULT_COVER_TEMPLATE_ID;
  return settings.coverTemplateEnabledIds.includes(id);
}

export function toCoverTemplateSummary(record: CoverTemplateRecord, settings: CoverTemplateSettings): CoverTemplateSummary {
  return {
    id: record.id,
    name: record.name,
    builtin: record.builtin,
    formats: record.formats,
    previewUrl: `/api/v1/settings/cover-templates/${record.id}/preview.jpg`,
    enabled: isCoverTemplateEnabled(record.id, settings),
    createdAt: record.createdAt?.toISOString(),
  };
}

/**
 * Какой шаблон рисовать этой публикацией.
 *
 * FIXED — заданный в Настройках (нет такого — встроенный). RANDOM — случайный
 * из отмеченных; не отмечено ничего или отмеченных не осталось (владелец удалил
 * свои шаблоны) — снова встроенный, а не отказ: обложка нужнее выбора.
 */
export function pickCoverTemplate(
  templates: CoverTemplateRecord[],
  settings: CoverTemplateSettings,
  random: () => number = Math.random
): CoverTemplateRecord {
  // По id, а не по признаку builtin: встроенных три. Ничего не выбрано — «Royal Green»
  // (владелец, 28.09.2026); его нет в списке (тесты с урезанным списком) — «Royal Gold».
  const builtin =
    templates.find((t) => t.id === DEFAULT_COVER_TEMPLATE_ID) ??
    templates.find((t) => t.id === BUILTIN_COVER_TEMPLATE_ID) ??
    BUILTIN_COVER_TEMPLATE;
  const mode = (settings.coverTemplateMode as CoverSelectionMode) ?? "FIXED";
  if (mode === "RANDOM") {
    const pool = templates.filter((t) => isCoverTemplateEnabled(t.id, settings));
    if (pool.length === 0) return builtin;
    return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
  }
  const fixed = settings.coverTemplateId ? templates.find((t) => t.id === settings.coverTemplateId) : undefined;
  return fixed ?? builtin;
}

/**
 * Очистка загруженного SVG: наружу не должно уходить ничего исполняемого и
 * ничего, что тянет внешний файл (шаблон рисуется на сервере, любой внешний
 * адрес — это и утечка, и зависимость от чужого сайта прямо в публикации).
 */
export function sanitizeTemplateSvg(svg: string): { ok: true; svg: string } | { ok: false; error: string } {
  if (!/<svg[\s>]/i.test(svg)) return { ok: false, error: "Это не SVG-файл" };
  if (svg.length > 2_000_000) return { ok: false, error: "SVG больше 2 МБ" };
  // DOCTYPE/ENTITY — это XXE и «миллиард смешков»: в шаблоне обложки им делать нечего.
  if (/<!DOCTYPE|<!ENTITY/i.test(svg)) return { ok: false, error: "В SVG есть DOCTYPE/ENTITY — их нельзя" };
  const clean = svg
    .replace(/<script[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "")
    .replace(/\son[a-z]+\s*=\s*[^\s>"']+/gi, "");
  // Незакрытый <script>/<foreignObject> пережил вырезку выше — такой файл не берём.
  if (/<(script|foreignObject)\b/i.test(clean)) return { ok: false, error: "В SVG есть скрипт — его нельзя" };
  if (/<(iframe|object|embed)\b/i.test(clean)) return { ok: false, error: "В SVG есть встраиваемые объекты — их нельзя" };
  // Ссылки: разрешены только внутренние (#id) и растровые data:image. Всё прочее —
  // внешний адрес (SSRF при рендере на сервере), путь к локальному файлу
  // (librsvg читает относительные пути с диска) или javascript:. Проверяется
  // значение каждого атрибута, а не начало строки: `&#104;ttp`, пробелы и
  // регистр раньше проходили мимо проверки.
  // Относительный путь (`href="leaves.png"` — так пишут исходники из редактора)
  // вырезается, а не валит загрузку: слои листьев/фото CRM подставляет сама.
  let bad = false;
  const clean2 = clean.replace(/\s(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, (all, dq?: string, sq?: string, bare?: string) => {
    const value = (dq ?? sq ?? bare ?? "").trim();
    if (/^#[\w.:-]+$/.test(value)) return all;
    if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(value)) return all;
    if (value.includes("&") || value.includes(":") || value.startsWith("//") || value.startsWith("\\")) bad = true;
    return "";
  });
  if (bad) return { ok: false, error: "В SVG есть внешние ссылки — их нельзя" };
  // url(...) в стилях и атрибутах (fill="url(...)", @import) — тоже только #id.
  if (/url\(\s*['"]?\s*(?!#)[^)]*\)/i.test(clean2) || /@import/i.test(clean2)) {
    return { ok: false, error: "В SVG есть внешние url() — их нельзя" };
  }
  return { ok: true, svg: clean2 };
}

/** Значения объекта, которые шаблон подставляет в свой SVG. */
export interface CoverTemplateValues {
  rooms: string;
  roomsWord: string;
  price: string;
  priceNumber: string;
  currency: string;
  area: string;
  areaNumber: string;
  /** Синоним `areaNumber` — имя поля объекта, так его пишут в своих шаблонах. */
  areaSqm?: string;
  floor: string;
  city: string;
  district: string;
  landmark: string;
  slogan?: string;
  /** «1», когда логотипа в Настройках нет и шаблон рисует свой векторный знак. */
  vectorLogo?: string;
}

const PLACEHOLDER = /\{\{\s*([\p{L}0-9_]+)\s*(?:\|\s*(upper)\s*)?\}\}/gu;

/** Экранирование для текста И значения атрибута: подстановка в
 *  `aria-label="{{landmark}}"` с кавычкой в ориентире иначе ломает разметку. */
export function escapeTemplateValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Условные блоки `data-if="поле"`: нет значения — элемент вырезается целиком
 * вместе с подписью и плашкой (правило брифа: нет данных — нет строки, а не
 * пустая плашка «ЭТАЖ» без числа). Есть значение — снимается только атрибут.
 */
export function applyTemplateConditions(svg: string, map: Record<string, string | undefined>): string {
  const open = /<([a-zA-Z][\w:-]*)\b([^>]*?)\sdata-if\s*=\s*["']([\p{L}0-9_]+)["']([^>]*?)(\/?)>/u;
  let out = svg;
  for (let guard = 0; guard < 500; guard++) {
    const m = open.exec(out);
    if (!m) break;
    const [whole, tag, before, key, after, selfClose] = m;
    const start = m.index;
    const openEnd = start + whole.length;
    if (map[key]?.trim()) {
      out = out.slice(0, start) + `<${tag}${before}${after}${selfClose}>` + out.slice(openEnd);
      continue;
    }
    let end = openEnd;
    if (!selfClose) {
      // Парный закрывающий тег с учётом вложенных одноимённых.
      const re = new RegExp(`<${tag}\\b[^>]*?(/?)>|</${tag}\\s*>`, "g");
      re.lastIndex = openEnd;
      let depth = 1;
      let t: RegExpExecArray | null;
      while (depth > 0 && (t = re.exec(out))) {
        if (t[0].startsWith("</")) depth--;
        else if (!t[1]) depth++;
        end = re.lastIndex;
      }
      if (depth > 0) end = out.length;
    }
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

const unescapeXml = (s: string): string =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const numAttr = (attrs: string, name: string): number | undefined => {
  const raw = new RegExp(`\\s${name}\\s*=\\s*["']\\s*(-?[\\d.]+)(?:px)?\\s*["']`).exec(attrs)?.[1];
  return raw === undefined ? undefined : Number(raw);
};

/**
 * `data-fit="ширина"` на `<text>`: строка шире — кегль (и `dx`/`letter-spacing`)
 * уменьшается пропорционально, а не вылезает за плашку и безопасную зону
 * (цена 128 500 000, ориентир на 40 символов). Ширина считается теми же
 * метриками TT Norms Pro, что у «Royal Gold» (`coverMetrics.ts`).
 */
export function applyTemplateFit(svg: string): string {
  return svg.replace(
    /<text\b([^>]*?)\sdata-fit\s*=\s*["'](\d+(?:\.\d+)?)["']([^>]*)>([\s\S]*?)<\/text>/g,
    (_all, a1: string, maxRaw: string, a2: string, body: string) => {
      const attrs = `${a1}${a2}`;
      const max = Number(maxRaw);
      const rootSize = numAttr(attrs, "font-size") ?? 16;
      const rootWeight = numAttr(attrs, "font-weight") ?? 400;
      const ls = numAttr(attrs, "letter-spacing") ?? 0;
      // Серифный «RH Playfair Lining» (royal-green) меряется своей таблицей: он
      // заметно уже TT Norms, и подгонка по гротеску ужимала бы цену зря.
      const serif = /Playfair/i.test(/\sfont-family\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "");
      const weight = (w: number): CoverMetricsWeight => (serif ? "SerifBold" : w >= 700 ? "ExtraBold" : "Medium");
      let width = 0;
      const rest = body.replace(/<tspan\b([^>]*)>([^<]*)<\/tspan>/g, (_t, ta: string, text: string) => {
        const size = numAttr(ta, "font-size") ?? rootSize;
        // Своё сжатие букв у куска (цифры цены «Royal Green» идут вплотную, TJS — нет).
        const spacing = numAttr(ta, "letter-spacing") ?? ls;
        width += measureCoverText(unescapeXml(text), size, spacing, weight(numAttr(ta, "font-weight") ?? rootWeight)) + (numAttr(ta, "dx") ?? 0);
        return "";
      });
      if (rest.trim()) width += measureCoverText(unescapeXml(rest.trim()), rootSize, ls, weight(rootWeight));
      const cleanAttrs = attrs.replace(/\sdata-fit-min\s*=\s*["'][^"']*["']/, "");
      if (width <= max) return `<text${cleanAttrs}>${body}</text>`;
      const k = max / width;
      // `data-fit-min="кегль"`: ужатая строка мельче этого не читается — не рисуем её вовсе
      // (длинный ориентир в ленте «Royal Green»), а не печатаем микрошрифтом.
      const min = numAttr(attrs, "data-fit-min");
      if (min !== undefined && rootSize * k < min) return "";
      const scale = (s: string): string =>
        s.replace(
          /(\s(?:font-size|dx|letter-spacing)\s*=\s*["']\s*)(-?[\d.]+)(?:px)?(\s*["'])/g,
          (_m, pre: string, n: string, q: string) => `${pre}${(Number(n) * k).toFixed(2)}${q}`
        );
      return `<text${scale(cleanAttrs)}>${scale(body)}</text>`;
    }
  );
}

/** Подстановка значений в SVG шаблона. Неизвестный ключ — пустая строка
 *  (правило брифа: нет данных — нет строки, а не «undefined» на обложке).
 *  Порядок: условные блоки → подстановка с экранированием → подгонка кегля. */
export function applyTemplateValues(svg: string, values: CoverTemplateValues): string {
  const map: Record<string, string | undefined> = {
    areaSqm: values.areaNumber,
    slogan: COVER_SLOGAN,
    ...(values as unknown as Record<string, string | undefined>),
  };
  const withConditions = applyTemplateConditions(svg, map);
  const substituted = withConditions.replace(PLACEHOLDER, (_all, key: string, modifier?: string) => {
    const value = map[key];
    if (value === undefined || value === null) return "";
    const text = modifier === "upper" ? String(value).toLocaleUpperCase("ru-RU") : String(value);
    return escapeTemplateValue(text);
  });
  return applyTemplateFit(substituted);
}

/** Имя файла шаблона в uploads — без пользовательской части, только uuid. */
export function coverTemplateFilename(ext: string): string {
  return `cover-template-${randomUUID()}.${ext}`;
}
