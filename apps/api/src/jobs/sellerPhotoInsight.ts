import { z } from "zod";
import sharp from "sharp";
import { PROPERTY_CONDITIONS } from "@royal-home/shared";
import { prisma } from "../db.js";
import { privateFilePath } from "../lib/privateFiles.js";
import {
  listSellerAttachments,
  SELLER_PHOTO_INSIGHT_JOB_TYPE,
  type SellerAttachment,
} from "../lib/sellerMedia.js";
import { logSystemError } from "../lib/systemError.js";
import { callAiText, type ImageInput } from "../ai/client.js";
import type { JobHandler } from "./registry.js";

/**
 * ОЦЕНКА ФОТО ПРОДАВЦА ИЗ ПЕРЕПИСКИ (21.09.2026, agent-brief.md §5) — фоновая,
 * а не по открытию мастера/чата/полосы (правило экономии токенов §1): один
 * vision-вызов на пачку НОВЫХ снимков, результат кэшируется в ChatPhotoInsight
 * по sha256 навсегда — один и тот же снимок модель не смотрит дважды, даже если
 * он всплывёт у другого клиента (переслали, сохранили из галереи и прислали
 * заново).
 *
 * Ставится lib/sellerMedia.ts::scheduleSellerPhotoInsights — debounce +15 минут
 * и dedupeKey на клиента, тем же приёмом, что у разбора фактов.
 */

const schema = z.object({ clientId: z.string() });
type Payload = z.infer<typeof schema>;

/** До 12 НОВЫХ снимков за вызов (agent-brief.md §5) — не 12 вообще присланных:
 *  уже оценённые (кэш по sha256) в пачку не попадают и денег не стоят. */
const MAX_PHOTO_INSIGHT_BATCH = 12;
/** Сколько пачек (vision-вызовов) за один запуск задания — верхняя граница расхода (CHANNEL-NEW-31). */
const MAX_BATCHES_PER_RUN = 4;
/** Сторона квадрата уменьшенной копии — снимку для классификации «планировка/
 *  фото, годится в обложку» не нужно разрешение крупнее миниатюры. */
const INSIGHT_IMAGE_SIZE = 384;

export const SELLER_PHOTO_INSIGHT_MAX_ATTEMPTS = 2;

/** Самая дешёвая рабочая модель, проверенная по ai/geminiTransport.ts (see
 *  GEMINI_MODEL_CHECKED/BAD_MODELS там же — `gemini-3.1-flash-lite` не входит в
 *  список 404 и числится в цепочке резервных моделей). Своя переменная, а не
 *  GEMINI_MODEL: диалоговая модель обязана быть умнее (держит промт бота с
 *  тридцатью запретами), а здесь — короткая закрытая классификация по JSON. */
const GEMINI_EXTRACT_MODEL = process.env.GEMINI_EXTRACT_MODEL || "gemini-3.1-flash-lite";

/** Экспорт только для теста (проверка формы схемы, уходящей в tools[0].function_declarations
 *  у Gemini) — тела вызова не изобретаем второй раз в тесте, сверяемся с тем же объектом. */
export const PHOTO_INSIGHT_SCHEMA = {
  type: "object",
  properties: {
    photos: {
      type: "array",
      description: "Ровно один элемент на каждый присланный снимок, в том же порядке.",
      items: {
        type: "object",
        properties: {
          index: { type: "number", description: "Порядковый номер снимка во входном списке, с нуля" },
          isPlan: { type: "boolean", description: "true — это планировка/чертёж квартиры, а не фото помещения" },
          condition: {
            type: "string",
            enum: [...PROPERTY_CONDITIONS],
            description:
              "Видимое состояние ремонта помещения на снимке; поле не присылать, если не определить (планировка, документ, вид из окна без интерьера)",
          },
          rooms: {
            type: "number",
            description: "Число комнат, различимое НА ПЛАНИРОВКЕ; поле не присылать у обычных фото и нечитаемых планов",
          },
          score: {
            type: "number",
            description:
              "0-100: насколько снимок годится в обложку объявления (светлый, просторный, презентабельный кадр реального помещения — не планировка, не документ, не случайный ракурс)",
          },
        },
        required: ["index", "isPlan", "score"],
      },
    },
  },
  required: ["photos"],
};

interface ModelPhoto {
  index: number;
  isPlan: boolean;
  condition?: string | null;
  rooms?: number | null;
  score: number;
}

/** Уменьшенная копия для vision-вызова — 384px jpeg q70 (agent-brief.md §5), не
 *  webp: часть моделей Gemini надёжнее читает jpeg/png, а вес на этом
 *  разрешении разницы почти не даёт. null — файл не прочитался (уборка успела
 *  удалить по сроку хранения, lib/privateFiles.ts::RETENTION_DAYS) — не
 *  блокирует остальную пачку, просто этот кадр остаётся неоценённым до
 *  следующего появления в переписке с новым файлом.
 */
async function loadInsightImage(attachment: SellerAttachment): Promise<ImageInput | null> {
  const full = privateFilePath(attachment.file);
  if (!full) return null;
  try {
    const buf = await sharp(full)
      .rotate()
      .resize(INSIGHT_IMAGE_SIZE, INSIGHT_IMAGE_SIZE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { mediaType: "image/jpeg", data: buf.toString("base64") };
  } catch {
    return null;
  }
}

function clampScore(n: unknown): number {
  const num = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function normalizeCondition(c: unknown): (typeof PROPERTY_CONDITIONS)[number] | null {
  return typeof c === "string" && (PROPERTY_CONDITIONS as readonly string[]).includes(c)
    ? (c as (typeof PROPERTY_CONDITIONS)[number])
    : null;
}

/**
 * Одна пачка снимков: vision-вызов и запись кэша. false — дальше не идти (отказ ИИ:
 * следующая пачка получила бы тот же отказ и зря сожгла вызов).
 */
async function insightBatch(payload: Payload, fresh: SellerAttachment[]): Promise<boolean> {
  const withImages: { attachment: SellerAttachment; image: ImageInput }[] = [];
  for (const a of fresh) {
    const image = await loadInsightImage(a);
    if (image) withImages.push({ attachment: a, image });
  }
  if (withImages.length === 0) return true;

  const result = await callAiText<{ photos: ModelPhoto[] }>({
    endpoint: "seller-photo-insight",
    system:
      "Ты помогаешь риелторскому агентству Royal Home разобрать фото квартиры, которые продавец прислал в " +
      "переписке. На вход приходит несколько снимков по порядку. Для КАЖДОГО снимка (по его номеру, с нуля) " +
      "определи: это планировка/чертёж или фото помещения (isPlan); если это фото помещения — видимое " +
      "состояние ремонта (condition: NEEDS_REPAIR — требует ремонта, GOOD — нормальное состояние, " +
      "EXCELLENT — отличный ремонт, NEW_BUILDING — черновая отделка новостройки; null, если не определить); " +
      "если это планировка — число комнат, которое на ней видно (rooms; null у фото помещений); и оценку " +
      "0-100, насколько кадр годится в обложку объявления — светлый, просторный, ракурс показывает комнату " +
      "целиком, без людей и беспорядка (score). Планировкам, документам и случайным кадрам ставь низкий score. " +
      "Ответь строго JSON по схеме, без пояснений.",
    user: `Снимков: ${withImages.length}, пронумерованы от 0 до ${withImages.length - 1} в порядке приложения.`,
    images: withImages.map((w) => w.image),
    maxTokens: 900,
    schema: PHOTO_INSIGHT_SCHEMA,
    simple: true,
    preferModel: GEMINI_EXTRACT_MODEL,
  });

  if (!result || !Array.isArray(result.photos)) {
    // «Отказ — logSystemError, повторов не больше 1» (agent-brief.md §6):
    // ход считается УСПЕШНЫМ (мастер и так открывается без оценки — хронологический
    // порядок ещё до кэша), лестница ретраев здесь не при чём. Не throw.
    void logSystemError(
      "ai",
      `Оценка фото продавца недоступна (клиент ${payload.clientId}, ${withImages.length} снимков) — мастер откроется без обложки по score`
    );
    return false;
  }

  const rows = result.photos
    .filter((p) => Number.isInteger(p.index) && p.index >= 0 && p.index < withImages.length)
    .map((p) => {
      const sha256 = withImages[p.index].attachment.sha256;
      return {
        sha256,
        isPlan: Boolean(p.isPlan),
        condition: normalizeCondition(p.condition),
        rooms: p.isPlan && typeof p.rooms === "number" && Number.isInteger(p.rooms) ? p.rooms : null,
        score: clampScore(p.score),
      };
    });
  if (rows.length === 0) return true;

  // skipDuplicates: та же фотография могла попасть в кэш параллельным
  // запуском этого же джоба для ДРУГОГО клиента (ключ — содержимое, не
  // клиент) между чтением `known` выше и этой записью.
  await prisma.chatPhotoInsight.createMany({ data: rows, skipDuplicates: true });
  return true;
}

export const sellerPhotoInsightJob: JobHandler<Payload> = {
  type: SELLER_PHOTO_INSIGHT_JOB_TYPE,
  schema,
  // Отказ ИИ (нет денег, таймаут) деградирует молча внутри run() — сюда
  // долетают только настоящие сбои (БД, диск), поэтому лестница короткая, как
  // у clip-compress: второй заход либо поможет, либо дело не в везении.
  backoff: () => 5 * 60_000,
  // Срок попытки под несколько vision-вызовов подряд (MAX_BATCHES_PER_RUN), а не
  // под один: умолчание лёгких заданий — минута.
  timeoutMs: MAX_BATCHES_PER_RUN * 90_000,
  async run(payload) {
    const attachments = await listSellerAttachments(payload.clientId);
    const photos = attachments.filter((a) => a.kind === "image");
    if (photos.length === 0) return;

    const existing = await prisma.chatPhotoInsight.findMany({
      where: { sha256: { in: photos.map((p) => p.sha256) } },
      select: { sha256: true },
    });
    const known = new Set(existing.map((e) => e.sha256));
    const pending = photos.filter((p) => !known.has(p.sha256));

    // Пачками по MAX_PHOTO_INSIGHT_BATCH, но не больше MAX_BATCHES_PER_RUN за запуск
    // (аудит Codex 04.10, CHANNEL-NEW-31): раньше брались первые 12, а остаток не ставился
    // повторно — dedupeKey живёт до финального статуса, самопереустановка блокируется, и без
    // нового сообщения снимки 13+ оставались без оценки навсегда. Хвост сверх предела
    // добирается следующим запуском (новое сообщение продавца ставит задание заново).
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN && pending.length > 0; batch++) {
      const keepGoing = await insightBatch(payload, pending.splice(0, MAX_PHOTO_INSIGHT_BATCH));
      if (!keepGoing) return;
    }
  },
  async onGiveUp(payload) {
    void logSystemError("ai", `Оценка фото продавца не удалась после всех попыток (клиент ${payload.clientId})`);
  },
};
