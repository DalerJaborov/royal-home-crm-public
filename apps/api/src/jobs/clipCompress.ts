import path from "node:path";
import { promises as fs } from "node:fs";
import { z } from "zod";
import { prisma } from "../db.js";
import { logSystemError } from "../lib/systemError.js";
import { compressClipVideo } from "../lib/propertyClipVideo.js";
import { clipVideoDir, uploadsDir } from "../upload.js";
import type { JobHandler } from "./registry.js";

/**
 * Сжатие короткого ролика карточки объекта (чертёж Б4, 27.08.2026).
 *
 * Раньше — фоновый промис прямо в HTTP-процессе (routes/properties.ts):
 * минуты ffmpeg делили event loop с запросами агентов, а падение процесса
 * оставляло clipVideoStatus=PROCESSING навсегда (это был задокументированный
 * «сознательный компромисс v1»). Теперь ffmpeg крутится в worker-контейнере,
 * а зависшее задание подбирается очередью.
 *
 * Исходник ждёт сжатия В ОБЩЕМ ТОМЕ (clipVideoDir, префикс incoming-), а не в
 * os.tmpdir(): /tmp у api- и worker-контейнеров разный, а /app/uploads — один.
 *
 * «ПОБЕЖДАЕТ ПОСЛЕДНИЙ ФАЙЛ» (Б9, 25.09.2026). Раньше идемпотентность держалась
 * только на clipVideoStatus === "READY" — это ловило повтор уже записанного
 * задания, но не гонку ДВУХ загрузок до завершения обеих: агент грузит А,
 * почти сразу грузит Б (второе задание встаёт поверх первого без дедупа —
 * так и задумано, свежая загрузка важнее), Б сжимается и пишет READY первым,
 * А заканчивает позже и молча переписывает карточку поверх Б своим старым
 * файлом. Теперь роут (/clip-video) перед постановкой задания пишет
 * `Property.clipVideoPendingInput` = имя своего исходника — это и есть «кто
 * последний загрузил». Задание, чьё `inputFilename` разошлось с этим полем к
 * моменту завершения сжатия, устарело: выходит молча (не трогая карточку), но
 * убирает СВОЙ файл, чтобы не копить мусор на диске. Задания, поставленные до
 * этой правки, несут `clipVideoPendingInput` не в схеме payload вовсе —
 * различаем их по «legacy»: на строке пусто (null) и статус ещё PROCESSING.
 */
const schema = z.object({
  propertyId: z.string(),
  /** Имя исходника в clipVideoDir (только имя, не путь — общий том смонтирован
   *  в обоих контейнерах одинаково, но абсолютный путь не обещан). */
  inputFilename: z.string(),
  outputFilename: z.string(),
  /** Больше не используется для уборки прежнего файла (см. clipVideoUrl,
   *  прочитанный в run() до сжатия) — оставлено в схеме только потому, что
   *  задания, поставленные в очередь до этой правки, всё ещё несут его в
   *  payload, и zod обязан его принять, не отбрасывая всю запись. */
  previousUrl: z.string().nullable(),
  sizeBytes: z.number(),
  durationSec: z.number(),
});

type Payload = z.infer<typeof schema>;

export const CLIP_COMPRESS_MAX_ATTEMPTS = 2;

async function cleanupInput(payload: Payload): Promise<void> {
  await fs.rm(path.join(clipVideoDir, payload.inputFilename), { force: true });
}

async function cleanupOutput(payload: Payload): Promise<void> {
  await fs.rm(path.join(clipVideoDir, payload.outputFilename), { force: true });
}

export const clipCompressJob: JobHandler<Payload> = {
  type: "clip-compress",
  schema,
  // ffmpeg падает либо стабильно (битый файл — второй заход не спасёт, поэтому
  // всего 2 попытки), либо из-за нехватки ресурсов — 5 минут, чтобы отпустило.
  backoff: () => 5 * 60_000,
  async run(payload) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: { clipVideoStatus: true, clipVideoUrl: true, clipVideoPendingInput: true },
    });
    if (!property) {
      await cleanupInput(payload);
      return;
    }

    // Задания, поставленные ДО этой правки, несут пустое clipVideoPendingInput
    // и уже стоящий PROCESSING — «легаси»-поведение (проверка по READY, ниже).
    const legacy = property.clipVideoPendingInput === null && property.clipVideoStatus === "PROCESSING";
    if (!legacy && property.clipVideoPendingInput !== payload.inputFilename) {
      // Либо загрузили новее (моё задание устарело — свежая загрузка важнее),
      // либо это повтор уже записанного задания (pendingInput сброшен в null
      // чужим успехом). В обоих случаях карточку не трогаем, но свой временный
      // исходник убираем — иначе он останется мусором в uploads/video навсегда.
      await cleanupInput(payload);
      return;
    }

    const targetUrl = `/uploads/video/${payload.outputFilename}`;
    const inputPath = path.join(clipVideoDir, payload.inputFilename);
    const outputPath = path.join(clipVideoDir, payload.outputFilename);
    await compressClipVideo(inputPath, outputPath);

    const written = await prisma.property.updateMany({
      where: {
        id: payload.propertyId,
        ...(legacy
          ? { clipVideoPendingInput: null, clipVideoStatus: "PROCESSING" }
          : { clipVideoPendingInput: payload.inputFilename }),
      },
      data: {
        clipVideoUrl: targetUrl,
        clipVideoStatus: "READY",
        clipVideoDurationSec: payload.durationSec,
        clipVideoSizeBytes: payload.sizeBytes,
        clipVideoUpdatedAt: new Date(),
        clipVideoPendingInput: null,
      },
    });
    if (written.count === 0) {
      // Пока сжимали, подоспела более новая загрузка — запись принадлежит ей,
      // но собственный вход и уже готовый выход всё равно нужно убрать.
      await cleanupOutput(payload);
      await cleanupInput(payload);
      return;
    }

    // Предыдущий готовый файл удаляем ПОСЛЕ успешной записи нового: неудачная
    // перекодировка или проигранная гонка не имеет права снести уже
    // показываемое клиенту видео. clipVideoUrl читаем из property В НАЧАЛЕ —
    // это снимок ДО сжатия, а не payload.previousUrl (тот больше не обещание
    // «этот файл сейчас в карточке», см. докстринг схемы выше).
    if (property.clipVideoUrl && property.clipVideoUrl !== targetUrl) {
      await fs.rm(path.join(uploadsDir, "video", path.basename(property.clipVideoUrl)), { force: true });
    }
    await cleanupInput(payload);
  },
  async onGiveUp(payload) {
    await logSystemError(
      "storage",
      `Сжатие видео объекта ${payload.propertyId} не удалось после всех попыток — карточка осталась со старым роликом`
    );
    await prisma.property
      .updateMany({
        // Только если это задание всё ещё «последнее» (или легаси, никогда не
        // переписанное свежей загрузкой) — устаревший give-up статус не трогает,
        // иначе он затёр бы READY/PROCESSING уже победившей загрузки.
        where: {
          id: payload.propertyId,
          clipVideoStatus: "PROCESSING",
          OR: [{ clipVideoPendingInput: payload.inputFilename }, { clipVideoPendingInput: null }],
        },
        data: { clipVideoStatus: "FAILED", clipVideoPendingInput: null },
      })
      .catch(() => {});
    await cleanupOutput(payload).catch(() => {});
    await cleanupInput(payload);
  },
};
