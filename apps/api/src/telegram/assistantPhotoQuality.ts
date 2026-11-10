/**
 * КАЧЕСТВО ФОТО В МАСТЕРЕ ОБЪЕКТА (Telegram, решение владельца 10.11.2026).
 *
 * Telegram сжимает снимок, отправленный «как фото», до ~1280 px — на сайте он
 * выходит мылом. Мастер ОДИН раз на черновик предлагает прислать файлом; ответ
 * «Оставить эти» — и больше по этому черновику не спрашиваем (владелец: «редко
 * беспокоить людей»). Тёмное / пересвеченное / размытое — только пометка у фото
 * в карточке «Проверьте объект», без отдельного сообщения и без отказа.
 *
 * Оценка снимка — lib/photoQuality.ts; здесь только запись пометок, текст и кнопки.
 */
import { prisma } from "../db.js";
import { assessPhotoQuality, PHOTO_QUALITY_FLAGS, type PhotoQualityFlag } from "../lib/photoQuality.js";
import { deleteDraftMedia } from "../lib/propertyDraftMedia.js";
import { logSystemError } from "../lib/systemError.js";
import type { DraftRecord } from "../routes/properties/draftLifecycle.js";
import { sendMessageWithButtons } from "./api.js";

type Lang = "ru" | "tg";

const copy = {
  ru: {
    ask: "📸 Фото пришли сжатыми — на сайте будут хуже. Лучше файлом: 📎 → Файл → выберите фото.",
    keep: "✅ Оставить эти",
    file: "📎 Пришлю файлом",
    kept: "Хорошо, оставляем эти.",
    waiting: (n: number) => n ? `Жду фото файлом. Сжатые (${n}) убрала из черновика.` : "Жду фото файлом.",
    photo: "фото",
    flags: { compressed: "сжатое", dark: "тёмное", bright: "пересвечено", blurry: "размытое" } satisfies Record<PhotoQualityFlag, string>,
  },
  tg: {
    ask: "📸 Аксҳо фишурда омаданд — дар сайт бадтар менамоянд. Беҳтараш ҳамчун файл фиристед: 📎 → Файл → аксҳоро интихоб кунед.",
    keep: "✅ Ҳаминҳоро монед",
    file: "📎 Ҳамчун файл мефиристам",
    kept: "Хуб, ҳаминҳоро мемонем.",
    waiting: (n: number) => n ? `Аксҳоро ҳамчун файл интизорам. ${n} акси фишурдаро аз черновик гирифтам.` : "Аксҳоро ҳамчун файл интизорам.",
    photo: "акс",
    flags: { compressed: "фишурда", dark: "торик", bright: "аз ҳад равшан", blurry: "хира" } satisfies Record<PhotoQualityFlag, string>,
  },
} as const;

/** `pdt:q:keep|file:<черновик>` — ответ на вопрос о сжатых фото. */
export const photoQualityCallback = /^pdt:q:(keep|file):([\da-f-]{36})$/u;

/**
 * Пометки качества — в строку снимка черновика (по uploadKey, он известен до
 * сохранения). Сбой оценки не мешает фото: снимок уже сохранён, пометки нет.
 */
export async function recordDraftPhotoQuality(uploadKey: string, buffer: Buffer, compressed: boolean): Promise<PhotoQualityFlag[]> {
  const flags: PhotoQualityFlag[] = compressed ? ["compressed"] : [];
  try {
    flags.push(...await assessPhotoQuality(buffer));
  } catch (error) {
    void logSystemError("telegram", `Мастер объекта: не удалось оценить качество фото: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (flags.length) await prisma.propertyDraftMedia.updateMany({ where: { uploadKey }, data: { qualityFlags: flags } });
  return flags;
}

/**
 * Вопрос про сжатые фото — ОДИН раз на черновик. Отметка ставится атомарно
 * (updateMany по null): фото альбома приходят пачкой параллельно, и без этого
 * вопрос ушёл бы на каждое.
 */
export async function askAboutCompressedOnce(chatId: string, draftId: string, lang: Lang): Promise<boolean> {
  const claimed = await prisma.propertyDraft.updateMany({
    where: { id: draftId, compressedPhotoNoticeAt: null },
    data: { compressedPhotoNoticeAt: new Date() },
  });
  if (claimed.count !== 1) return false;
  const c = copy[lang];
  await sendMessageWithButtons(chatId, c.ask, [[
    { text: c.keep, callback_data: `pdt:q:keep:${draftId}` },
    { text: c.file, callback_data: `pdt:q:file:${draftId}` },
  ]]);
  return true;
}

/**
 * Ответ на вопрос. «Оставить» — ничего не меняем. «Пришлю файлом» — убираем из
 * черновика сжатые снимки: иначе на сайт ушли бы и сжатые, и файлы, дважды одно.
 */
export async function answerCompressedChoice(
  agentId: string, draft: Pick<DraftRecord, "id" | "media">, choice: "keep" | "file", lang: Lang
): Promise<string> {
  const c = copy[lang];
  if (choice === "keep") return c.kept;
  const compressed = draft.media.filter(file => file.kind === "PHOTO" && file.qualityFlags.includes("compressed"));
  for (const file of compressed) await deleteDraftMedia(agentId, draft.id, file.id);
  return c.waiting(compressed.length);
}

/** «⚠️ фото 2 — тёмное; фото 5 — размытое» для карточки «Проверьте объект»; null — замечаний нет. */
export function photoQualityLine(draft: Pick<DraftRecord, "media">, lang: Lang): string | null {
  const c = copy[lang];
  // Номер — как у кнопки «Убрать фото N» (fileLabel): по порядку среди всех снимков.
  const photos = draft.media.filter(file => file.kind === "PHOTO");
  const notes = photos.flatMap((file, index) => {
    // «Сжатое» здесь не повторяем: об этом уже спросили один раз.
    const flags = PHOTO_QUALITY_FLAGS.filter(flag => flag !== "compressed" && file.qualityFlags.includes(flag));
    return flags.length ? [`${c.photo} ${index + 1} — ${flags.map(flag => c.flags[flag]).join(", ")}`] : [];
  });
  return notes.length ? `⚠️ ${notes.join("; ")}` : null;
}
