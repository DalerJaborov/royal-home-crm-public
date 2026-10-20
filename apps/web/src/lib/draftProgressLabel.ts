import { pluralizeRu } from "@royal-home/shared";
import type { DraftMediaItem } from "./draftUploads";

/**
 * Подпись для единого индикатора загрузки (components/WorkIndicator.tsx):
 * «Видео 3 из 5 — 47%». Чистая функция от плиток мастера.
 *
 * Считаем по ЕДУЩЕМУ файлу и его виду: «3 из 5» — это третье видео из пяти, а не
 * третий файл вообще; процент — именно этого файла, а общая полоса рисуется
 * рядом отдельно. Нет едущего — берём первый ждущий. Все упали — говорим об
 * этом, а не рисуем «0%».
 */
export function describeDraftProgress(items: Pick<DraftMediaItem, "kind" | "status" | "loaded" | "sizeBytes">[]): string | null {
  const pending = items.some((i) => i.status === "queued" || i.status === "uploading");
  const failed = items.filter((i) => i.status === "failed" || i.status === "lost").length;
  if (!pending) {
    if (failed === 0) return null;
    return `Не загрузилось ${failed} ${pluralizeRu(failed, ["файл", "файла", "файлов"])}`;
  }
  const active = items.find((i) => i.status === "uploading") ?? items.find((i) => i.status === "queued");
  if (!active) return null;
  const sameKind = items.filter((i) => i.kind === active.kind);
  const done = sameKind.filter((i) => i.status === "ready").length;
  const noun = active.kind === "video" ? "Видео" : "Фото";
  const percent =
    active.sizeBytes > 0 ? Math.min(99, Math.round((Math.min(active.loaded, active.sizeBytes) / active.sizeBytes) * 100)) : 0;
  return `${noun} ${Math.min(done + 1, sameKind.length)} из ${sameKind.length} — ${percent}%`;
}
