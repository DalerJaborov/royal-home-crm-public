import { partitionVideosByLimit, videoTooLargeMessage } from "@royal-home/shared";
import { formatUploadSize } from "../../lib/uploadFormat";

/**
 * Пределы самого черновика объекта — сколько снимков/роликов в него вообще
 * помещается. Подпись в шапке блока («до 60 снимков») должна совпадать с тем,
 * что реально отвергнет сервер, поэтому число одно — в packages/shared
 * (propertyWizardDraft.ts), его же зовёт сервер (lib/propertyDraftMedia.ts).
 */
export { MAX_DRAFT_PHOTOS, MAX_DRAFT_VIDEOS } from "@royal-home/shared";

/**
 * Отсев выбранных роликов ДО постановки в очередь (07.10.2026): тяжелее
 * единого предела (`UPLOAD_VIDEO_MAX_BYTES`, packages/shared) сервер отвергнет
 * ещё до первого байта, и узнать об этом агенту лучше сразу, а не плиткой с
 * ошибкой. Проверяются ВСЕ выбранные файлы, не только первый; годные идут в
 * очередь, а слишком тяжёлые остаются заметкой — каждый назван по имени.
 */
export function screenPickedVideos<T extends { name: string; size: number }>(
  picked: readonly T[]
): { accepted: T[]; note: string | null } {
  const { accepted, rejected } = partitionVideosByLimit(picked);
  if (rejected.length === 0) return { accepted, note: null };
  return {
    accepted,
    note: rejected.map((f) => videoTooLargeMessage(f.name, formatUploadSize(f.size))).join(" "),
  };
}
