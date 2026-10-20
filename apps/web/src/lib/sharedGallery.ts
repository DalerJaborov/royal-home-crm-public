import type { LightboxItem } from "../components/PhotoLightbox";

/** Ячеек в галерее публичной страницы: первая крупная, остальные мелкие. */
export const SHARE_GALLERY_CELLS = 5;

export interface SharedGalleryPhoto {
  url: string;
  thumbUrl: string;
}

/** Все фото объекта для просмотрщика, а не только пять видимых ячеек. */
export function lightboxItemsFromShared(photos: SharedGalleryPhoto[]): LightboxItem[] {
  return photos.map((p, i) => ({ key: `${i}:${p.url}`, url: p.url }));
}

/**
 * Какой кадр открыть по клику на ячейку. Надпись «Ещё N» лежит на последней
 * видимой ячейке и обещает остальные фото, поэтому ведёт на первое скрытое, а
 * не на то же пятое, что и сама ячейка (аудит 04.10.2026, WEB-PAGES05).
 */
export function openIndexForCell(cell: number, total: number, cells = SHARE_GALLERY_CELLS): number {
  const shown = Math.min(total, cells);
  const hidden = total - shown;
  return cell === shown - 1 && hidden > 0 ? shown : cell;
}
