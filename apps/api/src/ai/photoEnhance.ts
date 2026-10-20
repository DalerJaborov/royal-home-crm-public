import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { PropertyPhoto } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { uploadsDir, thumbsDir } from "../upload.js";
import { geminiGenerateUrlFor, geminiProxyHeaders } from "./geminiTransport.js";
import { resolveGeminiRuntime } from "./geminiSettings.js";
import { explainFailure } from "./coverImage.js";
import { logSystemError } from "../lib/systemError.js";
import { describeError } from "../lib/describeError.js";
import { emptyUsage, logAiCall } from "./shared.js";

/**
 * УЛУЧШЕНИЕ ФОТО ОБЪЕКТА ИИ — пункт 7 очереди, 23.08.2026.
 *
 * ⚠️ ПОЧЕМУ ЗДЕСЬ ТРИ ЖЁСТКИХ ГРАНИЦЫ, А НЕ ПРОСТО «ВЫЗОВ РИСОВАНИЯ».
 *
 * Живой тест в день добавления функции: тот же промт «улучши как для каталога,
 * планировку не меняй» на реальном фото из /app/uploads заставил модель убрать
 * с пола строительный мусор и арматуру и заметно изменить пропорции комнаты.
 * Промт запрещал это прямым текстом — и всё равно не удержал модель. Отсюда
 * правило этого файла: ПРОМТ — ПРОСЬБА, А НЕ ГАРАНТИЯ. Барьер должен стоять в
 * коде, а не в тексте, который модель может (и будет) нарушать:
 *
 *  1. Эта функция НИКОГДА не трогает PropertyPhoto.url/thumbUrl — только
 *     enhancedUrl/enhancedThumbUrl. Оригинал недостижим для случайной подмены
 *     уже на уровне того, какие колонки эта функция вообще пишет.
 *  2. Результат сохраняется НОВЫМ файлом на диске, не поверх оригинала —
 *     физическая копия, которую нельзя стереть перезаписью.
 *  3. Решение «одобрить/отклонить» (routes/properties.ts, .../enhance/approve
 *     и .../reject) — отдельный шаг, требующий отдельного действия человека;
 *     эта функция его не принимает и не имеет к этому отношения.
 *
 * Рубильник Settings.propertyPhotoEnhanceEnabled проверяется ВЫЗЫВАЮЩИМ
 * (routes/properties.ts), а не здесь — тот же приём, что и у ИИ-ассистента
 * (routes/ai.ts): рубильник это вопрос доступа к маршруту, а не деталь самого
 * вызова рисования.
 */

/** Та же логика ожидания, что и у обложек статей (ai/coverImage.ts) — рисование
 *  с входным фото не быстрее генерации с нуля, скорее наоборот. */
const ENHANCE_TIMEOUT_MS = 60_000;

/**
 * Промт редактирования. КАЖДЫЙ ЗАПРЕТ — ПРЯМЫМ ТЕКСТОМ, а не подразумевается:
 * 22.08.2026 модель нарушила расплывчатое «планировку не меняй», поэтому здесь
 * перечислено то же самое явно и по пунктам, плюс требование именно РЕДАКТИРОВАТЬ
 * присланное фото, а не рисовать похожее заново.
 *
 * Разрешённый список — тоже явный: свет, баланс белого, резкость, шумоподавление,
 * лёгкая цветокоррекция. Ничего сверх этого модель делать не просят.
 */
export function buildEnhancePrompt(): string {
  return (
    "Отредактируй это фото объекта недвижимости для каталога агентства. " +
    "РАЗРЕШЕНО ТОЛЬКО: коррекция освещения, баланс белого, резкость, шумоподавление, " +
    "лёгкая цветокоррекция. " +
    "СТРОГО ЗАПРЕЩЕНО, даже если кажется уместным для каталога: " +
    "удалять, добавлять или перемещать любые предметы, мебель, вещи, строительный мусор " +
    "или что-либо ещё, видимое на фото; " +
    "менять планировку, пропорции, форму или размеры помещения; " +
    "двигать, добавлять или убирать стены, окна, двери, потолок или пол; " +
    "менять ракурс, ширину кадра или композицию. " +
    "Результат обязан показывать РОВНО ТО ЖЕ помещение с РОВНО ТЕМИ ЖЕ предметами " +
    "в тех же местах, что и на исходном фото — редактируй присланное изображение, " +
    "а не рисуй новое похожее. Единственная цель — чтобы то же самое помещение " +
    "выглядело на фото так, как оно выглядит вживую при хорошем освещении."
  );
}

export interface PhotoEnhanceResult {
  ok: boolean;
  /** Обновлённая запись (с заполненными enhanced-полями) при успехе. */
  photo: PropertyPhoto | null;
  error: string | null;
  status: number | null;
}

/** MIME по расширению файла на диске — фото объекта всегда сохраняются как .webp
 *  (см. routes/properties.ts, POST /:id/photos), но проверяем по факту, а не
 *  считаем это гарантией: если формат когда-то изменится, вызов не должен
 *  молча слать Google неверный mimeType. Экспортирована — тем же способом
 *  определяет MIME `ai/coverPosterStyle.ts` (источник там — не только фото
 *  объекта, ещё и ffmpeg-кадр .jpg), заводить вторую копию незачем. */
export function mimeForExt(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  return "image/webp";
}

/**
 * Запускает улучшение ОДНОГО фото. Читает исходник с диска, шлёт Gemini как
 * image-to-image (входное фото — inlineData-часть рядом с текстовым промтом,
 * тот же generateContent, что и у обложек статей — see ai/coverImage.ts),
 * сохраняет результат НОВЫМ файлом и пишет только enhanced*-поля.
 *
 * НЕ бросает при отказе рисования — отказ ИИ-вызова это ожидаемый исход
 * (перегрузка, отказ модели, нет ключа), а не повод падать пятисотой ошибкой;
 * вызывающий маршрут решает, как показать это агенту.
 */
export async function enhancePropertyPhoto(photoId: string, requestedBy: string): Promise<PhotoEnhanceResult> {
  const started = Date.now();
  const photo = await prisma.propertyPhoto.findUnique({ where: { id: photoId } });
  if (!photo) return { ok: false, photo: null, error: "Фото не найдено", status: null };

  const sourcePath = path.join(uploadsDir, path.basename(photo.url));
  let sourceBuffer: Buffer;
  try {
    sourceBuffer = await fs.readFile(sourcePath);
  } catch (err) {
    return { ok: false, photo: null, error: `Файл фото не найден на диске: ${describeError(err)}`, status: null };
  }

  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) {
    return { ok: false, photo: null, error: "Ключ Gemini не настроен", status: null };
  }

  const model = runtime.imageModel;
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          { text: buildEnhancePrompt() },
          { inlineData: { mimeType: mimeForExt(photo.url), data: sourceBuffer.toString("base64") } },
        ],
      },
    ],
    generationConfig: { responseModalities: ["IMAGE"] },
  });

  let last: PhotoEnhanceResult = { ok: false, photo: null, error: "не с чем пробовать", status: null };

  // Тот же перебор ключей, что и у обложек (ai/coverImage.ts): 401/403 — беда
  // конкретного ключа, следующий может ответить; остальные коды к ключу не относятся.
  for (const apiKey of runtime.keys) {
    try {
      const res = await fetch(geminiGenerateUrlFor(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        body,
        signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = (await res.text()).replace(/\s+/g, " ");
        last = { ok: false, photo: null, error: explainFailure(res.status, detail), status: res.status };
        if (res.status !== 401 && res.status !== 403) break;
        continue;
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) {
        last = { ok: false, photo: null, error: "Модель ответила без изображения", status: res.status };
        break;
      }

      // НОВЫЙ файл, не поверх оригинала — см. заголовок файла, барьер №2.
      const id = randomUUID();
      const filename = `${id}.webp`;
      const fullPath = path.join(uploadsDir, filename);
      const thumbPath = path.join(thumbsDir, filename);
      const resultBuffer = Buffer.from(inline.data, "base64");
      // Та же обработка, что у обычной загрузки фото (routes/properties.ts,
      // POST /:id/photos) — чтобы улучшенное фото по качеству и весу не
      // отличалось от остальной галереи, если его потом одобрят.
      await sharp(resultBuffer).webp({ quality: 82 }).toFile(fullPath);
      await sharp(resultBuffer).resize(800, undefined, { withoutEnlargement: true }).webp({ quality: 80 }).toFile(thumbPath);

      const updated = await prisma.propertyPhoto.update({
        where: { id: photo.id },
        data: {
          enhancedUrl: `/uploads/${filename}`,
          enhancedThumbUrl: `/uploads/thumbs/${filename}`,
          enhancedRequestedAt: new Date(),
          enhancedRequestedBy: requestedBy,
        },
      });

      void logAiCall({
        endpoint: "photo-enhance:gemini",
        model,
        spent: {
          ...emptyUsage(),
          inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        ms: Date.now() - started,
        ok: true,
      });
      return { ok: true, photo: updated, error: null, status: res.status };
    } catch (err) {
      last = { ok: false, photo: null, error: describeError(err), status: null };
    }
  }

  void logSystemError("ai", `Улучшение фото ${photoId} не удалось (${model}): ${last.error}`);
  return last;
}

/**
 * Та же ретушь Gemini, но по буферу и БЕЗ записи в базу/галерею — для подложки
 * обложки «Royal Green» (владелец 28.09.2026: «нужны светлые такие же фото»).
 * Галерейный барьер (одобрение человеком) здесь не нужен: результат не
 * подменяет фото объекта, а живёт только внутри картинки обложки.
 */
export async function enhancePhotoBuffer(source: Buffer, mimeType: string): Promise<{ ok: true; image: Buffer } | { ok: false; error: string }> {
  const runtime = await resolveGeminiRuntime();
  if (runtime.keys.length === 0) return { ok: false, error: "Ключ Gemini не настроен" };
  const model = runtime.imageModel;
  const started = Date.now();
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: buildEnhancePrompt() }, { inlineData: { mimeType, data: source.toString("base64") } }] }],
    generationConfig: { responseModalities: ["IMAGE"] },
  });
  let error = "не с чем пробовать";
  for (const apiKey of runtime.keys) {
    try {
      const res = await fetch(geminiGenerateUrlFor(model), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey, ...geminiProxyHeaders() },
        body,
        signal: AbortSignal.timeout(ENHANCE_TIMEOUT_MS),
      });
      if (!res.ok) {
        error = explainFailure(res.status, (await res.text()).replace(/\s+/g, " "));
        if (res.status !== 401 && res.status !== 403) break;
        continue;
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const inline = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
      if (!inline?.data) {
        error = "Модель ответила без изображения";
        break;
      }
      void logAiCall({
        endpoint: "cover-retouch:gemini",
        model,
        spent: { ...emptyUsage(), inputTokens: data.usageMetadata?.promptTokenCount ?? 0, outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0 },
        ms: Date.now() - started,
        ok: true,
      });
      return { ok: true, image: Buffer.from(inline.data, "base64") };
    } catch (err) {
      error = describeError(err);
    }
  }
  return { ok: false, error };
}
