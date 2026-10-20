import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Скачивает вложение переписки и отдаёт blob-ссылку на него, освобождая её при
 * размонтировании.
 *
 * Вынесено из MessageAttachments.tsx (21.09.2026, «фото в чате листаются
 * свайпом по всем фото переписки»): просмотрщик всей переписки (ChatPhotoViewer)
 * качает те же закрытые файлы тем же маршрутом, что и одиночная плитка —
 * второй копии того же fetch+blob не заводим.
 *
 * Файл нельзя вставить в `<img src>` напрямую: он лежит в закрытом хранилище и
 * отдаётся маршрутом с проверкой права по заголовку Authorization, а тег
 * `<img>` заголовков не шлёт — получилась бы битая картинка.
 */
export type AttachmentLoadState = { url: string | null; failed: boolean };

export function useAttachmentUrl(file: string | null): AttachmentLoadState {
  const [state, setState] = useState<AttachmentLoadState>({ url: null, failed: false });

  useEffect(() => {
    if (!file) return;
    // Отменять сам запрос нечем (api() не принимает signal), поэтому просто не
    // трогаем состояние после размонтирования и не создаём осиротевшую ссылку:
    // незакрытый blob держит файл в памяти вкладки до перезагрузки страницы.
    let cancelled = false;
    let objectUrl: string | null = null;

    setState({ url: null, failed: false });
    api<Blob>(`/attachments/${encodeURIComponent(file)}`, { responseType: "blob" })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: null, failed: true });
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return state;
}

/**
 * То же скачивание, но без хука — для просмотрщика, которому нужно держать
 * СРАЗУ несколько blob-ссылок (текущий кадр и соседей) в одной карте состояния,
 * а не заводить хук на каждое фото переписки (число кадров меняется вместе с
 * историей — нарушило бы правило порядка хуков).
 */
export async function fetchAttachmentUrl(file: string): Promise<string | null> {
  try {
    const blob = await api<Blob>(`/attachments/${encodeURIComponent(file)}`, { responseType: "blob" });
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
