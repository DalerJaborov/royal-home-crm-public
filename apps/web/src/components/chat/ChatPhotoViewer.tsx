import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchAttachmentUrl } from "../../lib/attachmentUrl";
import { createBlobUrlRegistry, type BlobUrlRegistry } from "../../lib/blobUrlRegistry";
import type { ChatPhotoEntry } from "../../lib/chatPhotos";
import { PhotoLightbox, type LightboxItem } from "../PhotoLightbox";

/**
 * Просмотрщик ВСЕХ фото переписки — тонкая обёртка над общим PhotoLightbox
 * (21.09.2026, макет «Объект из переписки»). Свой файл только затем, чтобы
 * держать закрытые файлы (клиентские фото качаются по праву, см.
 * lib/attachmentUrl.ts) — сам жест, счётчик, клавиатура и лента миниатюр уже
 * есть в PhotoLightbox, второй раз не пишутся.
 *
 * ПОЧЕМУ НЕ ХУК НА КАЖДОЕ ФОТО. Число кадров растёт вместе с перепиской, а
 * хуки нельзя звать переменное число раз. Вместо этого — одна карта
 * `resolved: Map<file, url>` и эффект, который довычитывает ТЕКУЩИЙ кадр и его
 * соседей (не всю переписку разом: в диалоге бывают десятки фото, скачивать их
 * все в момент открытия — впустую тратить мобильный трафик агента).
 */
export function ChatPhotoViewer({
  photos,
  index,
  onClose,
  onIndexChange,
  /** Показывать «Добавить объект» в подвале — только для продавца, у которого
   *  просмотрщик и открыт из полосы/фото переписки (SellerObjectStrip рядом). */
  sellerClientId,
}: {
  photos: ChatPhotoEntry[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
  sellerClientId?: string | null;
}) {
  const navigate = useNavigate();
  const [resolved, setResolved] = useState<Map<string, string | null>>(new Map());
  // Какие file уже запрошены — чтобы не слать второй fetch за тем же кадром,
  // пока первый ещё летит (быстрое пролистывание туда-обратно).
  const requested = useRef<Set<string>>(new Set());
  // Все выданные blob-ссылки живут в реестре, а не в замкнутой карте state:
  // cleanup эффекта с [] видел бы только пустую начальную карту (WEB-PAGES04).
  const registry = useRef<BlobUrlRegistry | null>(null);

  useEffect(() => {
    // Скачиваем сам кадр и по одному соседу в каждую сторону — снимает
    // задержку при обычном пролистывании, не превращаясь в закачку всей
    // переписки разом.
    const wanted = [index - 1, index, index + 1]
      .map((i) => photos[i])
      .filter((p): p is ChatPhotoEntry => !!p && !p.url && !p.expired && !!p.file);

    for (const p of wanted) {
      const file = p.file as string;
      if (requested.current.has(file)) continue;
      requested.current.add(file);
      void fetchAttachmentUrl(file).then((fetched) => {
        // Окно уже закрыто: реестр освободит ссылку сам и вернёт null.
        const url = registry.current ? registry.current.track(fetched) : fetched;
        setResolved((prev) => {
          const next = new Map(prev);
          next.set(file, url);
          return next;
        });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, photos]);

  // Объект-ссылки не переживают размонтирование окна: без явного revoke они
  // остаются в памяти вкладки до перезагрузки страницы. Реестр создаётся в
  // эффекте (а не при первом рендере), чтобы пережить двойной монтаж StrictMode.
  useEffect(() => {
    const reg = createBlobUrlRegistry();
    registry.current = reg;
    return () => {
      reg.dispose();
    };
  }, []);

  const items: LightboxItem[] = photos.map((p) => {
    if (p.expired) return { key: p.key, url: null, failed: true, caption: p.caption };
    if (p.url) return { key: p.key, url: p.url, caption: p.caption };
    if (!p.file) return { key: p.key, url: null, failed: true, caption: p.caption };
    const got = resolved.get(p.file);
    if (got === undefined) return { key: p.key, url: null, caption: p.caption }; // ещё грузится
    return { key: p.key, url: got, failed: got === null, caption: p.caption };
  });

  return (
    <PhotoLightbox
      items={items}
      index={index}
      onClose={onClose}
      onIndexChange={onIndexChange}
      thumbnails
      footerExtra={
        sellerClientId ? (
          <button
            type="button"
            className="pill soft"
            onClick={() => navigate(`/properties/new?fromClient=${sellerClientId}`)}
          >
            Добавить объект
          </button>
        ) : undefined
      }
    />
  );
}
