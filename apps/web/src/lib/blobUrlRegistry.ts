/**
 * Учёт blob-ссылок, которые держит окно, пока оно открыто. Всё, что выдали,
 * освобождается разом при закрытии, а ответ, пришедший уже ПОСЛЕ закрытия,
 * освобождается сразу: иначе ссылка остаётся в памяти вкладки до перезагрузки.
 * Живёт вне React, потому что cleanup эффекта с `[]` видит только пустое
 * начальное состояние (аудит 04.10.2026, WEB-PAGES04).
 */
export interface BlobUrlRegistry {
  /** Запомнить ссылку. После dispose сразу освобождает её и возвращает null. */
  track: (url: string | null) => string | null;
  dispose: () => void;
}

export function createBlobUrlRegistry(
  revoke: (url: string) => void = (url) => URL.revokeObjectURL(url),
): BlobUrlRegistry {
  const urls = new Set<string>();
  let disposed = false;
  return {
    track(url) {
      if (!url) return url;
      if (disposed) {
        revoke(url);
        return null;
      }
      urls.add(url);
      return url;
    },
    dispose() {
      disposed = true;
      for (const url of urls) revoke(url);
      urls.clear();
    },
  };
}
