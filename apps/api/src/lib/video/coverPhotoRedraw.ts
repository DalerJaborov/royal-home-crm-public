/**
 * ПЕРЕРИСОВКА ФОТО ДЛЯ ОБЛОЖКИ «КАК В ЖУРНАЛЕ» (владелец, 29.09.2026: «наши снимки
 * тёмные и некрасивые — пусть ChatGPT перерисовывает их яркими, фотореализм,
 * убрать всё лишнее из комнат, как для журнала; ничего страшного, если комната
 * будет не совсем такой»).
 *
 * Шаг стоит ПЕРЕД нашим шаблоном: главное фото → images/edits (одна картинка,
 * вертикаль 9:16 — из неё режутся и вертикаль, и квадрат) → шаблон с точными
 * цифрами поверх. Перерисованное фото идёт ТОЛЬКО на обложку; галерея объявления
 * остаётся настоящей.
 *
 * Кэш — по sha256 байтов фото + версии промта + модели + качества в
 * `uploads/covers/redraw/`: одно фото перерисовывается ОДИН раз, повторная
 * обложка и добор за него не платят. Отказ OpenAI, нет ключа, исчерпан дневной
 * лимит — `ok: false` с причиной; обложка тогда собирается из обычной ретуши.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { propertyCoversDir } from "../../upload.js";
import {
  OPENAI_IMAGE_TIMEOUT_MS,
  OpenAiError,
  estimateImageCostUsd,
  imageCostFromUsage,
  logOpenAiCall,
  openAiPost,
  type ImageUsage,
  type OpenAiImageModel,
  type OpenAiImageQuality,
} from "../../ai/openaiClient.js";

/** Меняется промт — меняется версия, и кэш перерисовок честно устаревает. */
export const REDRAW_PROMPT_VERSION = "redraw-v1-29-09";

export const REDRAW_PROMPT = [
  "Transform this real-estate photo into a bright, premium interior-design magazine photograph.",
  "Keep the same kind of room and roughly the same layout: walls, windows and doors stay where they are.",
  "Remove all clutter: personal items, bags, boxes, cables, laundry, trash, tools, dirt, stains and marks.",
  "Make it clean, tidy and beautifully styled: neutral warm palette, a few tasteful plants, soft textiles, elegant modern furniture where the room is empty or shabby.",
  "Lighting: bright warm natural daylight, soft golden sun through the windows, balanced exposure, no dark corners, no gloomy shadows.",
  "Photorealistic, ultra detailed, professional architectural photography, full-frame camera, wide-angle lens, straight vertical lines.",
  "Vertical 9:16 composition with the main part of the room in the centre.",
  "No text, no letters, no numbers, no watermark, no logo, no people.",
].join(" ");

export type RedrawResult =
  | { ok: true; image: Buffer; cached: boolean; costUsd: number }
  | { ok: false; reason: string; costUsd: number };

const redrawDir = (): string => path.join(propertyCoversDir, "redraw");

/** Размер ответа: gpt-image-1 знает только 1024×1536; 2.x — нативные 9:16. */
function redrawSize(model: OpenAiImageModel): string {
  return model === "gpt-image-1" ? "1024x1536" : "1152x2048";
}

export async function redrawCoverPhoto(
  photoPath: string,
  params: {
    apiKey: string | null;
    model: OpenAiImageModel;
    quality: OpenAiImageQuality;
    /** Сколько картинок ещё можно заказать сегодня (общий лимит обложек). */
    imagesLeft: number;
    /** Строка журнала ИИ — та же, что у обложек ChatGPT, чтобы лимит дня считал и перерисовки. */
    endpoint: string;
    retryDelayMs?: number;
  }
): Promise<RedrawResult> {
  let original: Buffer;
  try {
    original = await fs.readFile(photoPath);
  } catch {
    return { ok: false, reason: `файл фото не найден (${path.basename(photoPath)})`, costUsd: 0 };
  }
  const hash = crypto
    .createHash("sha256")
    .update(original)
    .update(`${REDRAW_PROMPT_VERSION}|${params.model}|${params.quality}`)
    .digest("hex");
  const cachedPath = path.join(redrawDir(), `${hash}.jpg`);
  try {
    return { ok: true, image: await fs.readFile(cachedPath), cached: true, costUsd: 0 };
  } catch {
    // нет в кэше — перерисовываем
  }
  if (!params.apiKey) return { ok: false, reason: "ключ OpenAI не задан", costUsd: 0 };
  if (params.imagesLeft < 1) return { ok: false, reason: "исчерпан дневной лимит картинок ChatGPT", costUsd: 0 };

  const size = redrawSize(params.model);
  const form = new FormData();
  form.append("model", params.model);
  form.append("prompt", REDRAW_PROMPT);
  form.append("quality", params.quality);
  form.append("size", size);
  form.append("output_format", "png");
  if (params.model === "gpt-image-1") form.append("input_fidelity", "high");
  form.append("n", "1");
  const upload = await sharp(original).rotate().resize(1536, 1536, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
  form.append("image[]", new Blob([new Uint8Array(upload)], { type: "image/jpeg" }), "photo.jpg");

  const started = Date.now();
  try {
    const res = await openAiPost<{ data?: { b64_json?: string }[]; usage?: ImageUsage }>("/images/edits", {
      body: form,
      timeoutMs: OPENAI_IMAGE_TIMEOUT_MS,
      apiKey: params.apiKey,
      retryDelayMs: params.retryDelayMs,
    });
    const b64 = res.data?.[0]?.b64_json;
    if (!b64) throw new OpenAiError("OpenAI вернул ответ без картинки", null, "empty");
    const costUsd = imageCostFromUsage(res.usage) ?? estimateImageCostUsd(params.quality, "1024x1536");
    await logOpenAiCall({ endpoint: params.endpoint, model: params.model, costUsd, ms: Date.now() - started, ok: true });
    const image = await sharp(Buffer.from(b64, "base64")).jpeg({ quality: 94 }).toBuffer();
    await fs.mkdir(redrawDir(), { recursive: true });
    // Кэш не записался — перерисовка всё равно годится для этой обложки.
    await fs.writeFile(cachedPath, image).catch(() => undefined);
    return { ok: true, image, cached: false, costUsd };
  } catch (err) {
    await logOpenAiCall({ endpoint: params.endpoint, model: params.model, costUsd: null, ms: Date.now() - started, ok: false });
    return { ok: false, reason: err instanceof Error ? err.message : "неизвестный сбой", costUsd: 0 };
  }
}
