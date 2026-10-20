import { z } from "zod";

/**
 * ШАБЛОНЫ ОБЛОЖЕК ДЛЯ СОЦСЕТЕЙ (владелец, 23.09.2026).
 *
 * Обложка объекта рисуется по ПАРЕ: геометрия (SVG-слой) + числа (`spec.json`) —
 * ровно в том виде, в каком владелец приносил исходники «Royal Gold». Встроенный
 * шаблон живёт кодом (`apps/api/src/lib/video/coverTemplate.ts`), свои шаблоны
 * владелец загружает в Настройках файлами и они лежат в базе.
 *
 * Схема ниже — граница: всё, что приходит файлом `spec.json`, проверяется ею до
 * первого использования. Лишние ключи исходника (`analysis.json`, заметки о
 * достоверности и прочее) намеренно разрешены и игнорируются: файлы владельца
 * их содержат, и падать из-за них нельзя.
 */

/** Размер холста. Поддерживаем ровно два: лента 1:1 и вертикаль 9:16. */
export const COVER_FORMATS = ["square", "story"] as const;
export type CoverFormat = (typeof COVER_FORMATS)[number];

export const COVER_SQUARE = { width: 1080, height: 1080 } as const;
export const COVER_STORY = { width: 1080, height: 1920 } as const;

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{3,8}$/, "Цвет пишется как #RRGGBB");

const gradientStop = z.object({
  offset: z.number().min(0).max(1),
  color: hexColor,
  opacity: z.number().min(0).max(1).optional(),
});

const gradient = z.object({
  type: z.literal("linearGradient").optional(),
  angle_deg: z.number().optional(),
  stops: z.array(gradientStop).min(2).max(8),
});

/**
 * `spec.json` шаблона. Обязателен только холст: остальное шаблон может не
 * задавать (тогда берутся значения встроенного «Royal Gold»), а вот холст
 * определяет, в каких форматах шаблон вообще участвует.
 */
export const coverTemplateSpecSchema = z
  .object({
    version: z.string().max(20).optional(),
    canvas: z
      .object({
        width: z.number().int().positive().max(4096).optional(),
        height: z.number().int().positive().max(4096).optional(),
        square: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
        reels: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
      })
      .optional(),
    colors: z.record(z.string(), hexColor).optional(),
    gradients: z.record(z.string(), gradient).optional(),
    dark_overlay: gradient.extend({ color: hexColor.optional(), opacity: z.union([z.number(), z.string()]).optional() }).optional(),
    photo_adjustment: z
      .object({
        brightness: z.number().min(-1).max(1).optional(),
        contrast: z.number().min(-1).max(1).optional(),
        saturation: z.number().min(-1).max(1).optional(),
      })
      .passthrough()
      .optional(),
    fonts: z.record(z.string(), z.unknown()).optional(),
    font_system: z.record(z.string(), z.unknown()).optional(),
    elements: z.record(z.string(), z.unknown()).optional(),
    platforms: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type CoverTemplateSpec = z.infer<typeof coverTemplateSpecSchema>;

/** Какие форматы шаблон умеет — считается по холстам из `spec.json`. */
export function coverFormatsFromSpec(spec: CoverTemplateSpec): CoverFormat[] {
  const formats = new Set<CoverFormat>();
  const canvas = spec.canvas;
  const add = (w?: number, h?: number): void => {
    if (!w || !h) return;
    const ratio = h / w;
    if (Math.abs(ratio - 1) < 0.05) formats.add("square");
    else if (ratio > 1.2) formats.add("story");
  };
  add(canvas?.width, canvas?.height);
  add(canvas?.square?.[0], canvas?.square?.[1]);
  add(canvas?.reels?.[0], canvas?.reels?.[1]);
  // Холста нет вовсе — считаем, что шаблон рисует оба формата: это поведение
  // встроенного «Royal Gold», и оно же безопаснее для выбора при публикации
  // (пустой список форматов означал бы «шаблон никогда не подходит»).
  if (formats.size === 0) return ["square", "story"];
  return [...formats];
}

/** Как выбирается шаблон на публикацию. */
export const COVER_SELECTION_MODES = ["FIXED", "RANDOM"] as const;
export type CoverSelectionMode = (typeof COVER_SELECTION_MODES)[number];

/** Идентификатор встроенного шаблона — он есть всегда и не удаляется. */
export const BUILTIN_COVER_TEMPLATE_ID = "royal-gold";

/** Шаблон по умолчанию, когда в Настройках ничего не выбрано (владелец, 28.09.2026):
 *  «Royal Green» — точная копия его эталона. «Royal Gold» остаётся запасным на сбой. */
export const DEFAULT_COVER_TEMPLATE_ID = "royal-green";

/** Кто рисует обложку объекта (28.09.2026): наш шаблон или ChatGPT. */
export const COVER_PROVIDERS = ["TEMPLATE", "OPENAI"] as const;
export type CoverProvider = (typeof COVER_PROVIDERS)[number];
export const DEFAULT_COVER_PROVIDER: CoverProvider = "TEMPLATE";

/** Что показывает список шаблонов в Настройках и чем пользуется публикация. */
export interface CoverTemplateSummary {
  id: string;
  name: string;
  /** Встроенный нельзя удалить и нельзя выключить последним. */
  builtin: boolean;
  formats: CoverFormat[];
  /** Картинка-превью для списка (URL роута предпросмотра). */
  previewUrl: string;
  /** Участвует ли в случайном выборе. */
  enabled: boolean;
  createdAt?: string;
}

export const coverTemplateUploadSchema = z.object({
  name: z.string().trim().min(2, "Слишком короткое название").max(60),
});
