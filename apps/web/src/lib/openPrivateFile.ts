import { api } from "./api";

/**
 * ОТКРЫТЬ ЗАКРЫТЫЙ ФАЙЛ В НОВОЙ ВКЛАДКЕ — ТАК, ЧТОБЫ ЭТО РАБОТАЛО И НА iPhone.
 *
 * Было (резюме кандидата, components/VacancyDetails.tsx): сначала скачать файл
 * (`await api(...)`), потом `window.open(blob-ссылка)`. Safari на iPhone
 * разрешает открыть окно только прямо в обработчике нажатия; после `await`
 * нажатие уже «кончилось», и окно молча блокируется — кнопка ничего не делала,
 * без единой ошибки. Плюс blob-ссылка не отзывалась и держала файл в памяти
 * вкладки до перезагрузки.
 *
 * Стало: окно открывается СРАЗУ, синхронно в обработчике нажатия, а адрес ему
 * даётся, когда файл скачан. Окно не открылось (блокировщик всплывающих окон) —
 * файл отдаётся ссылкой на скачивание, как документы в переписке
 * (MessageAttachments). Не скачался — пустое окно закрывается, а вызывающий
 * получает false и показывает ошибку. Ссылка отзывается через минуту: сразу
 * нельзя, новая вкладка ещё не успела её прочитать.
 */
export interface OpenPrivateFileDeps {
  open: (url: string, target: string) => { location: { href: string }; close: () => void } | null;
  load: (file: string) => Promise<Blob>;
  createObjectURL: (blob: Blob) => string;
  revokeObjectURL: (url: string) => void;
  /** Запасной путь — скачивание ссылкой, когда окно заблокировано. */
  download: (url: string, filename: string) => void;
  later: (fn: () => void, ms: number) => void;
}

export const REVOKE_AFTER_MS = 60_000;

/** Браузерные зависимости. `load` — откуда качать: по умолчанию вложения
 *  переписки (/attachments/:name); резюме кандидата качается своим маршрутом
 *  /vacancies/:id/cv (components/VacancyDetails.tsx). */
export function browserDeps(
  load: (file: string) => Promise<Blob> = (file) =>
    api<Blob>(`/attachments/${encodeURIComponent(file)}`, { responseType: "blob" })
): OpenPrivateFileDeps {
  return {
    open: (url, target) => window.open(url, target),
    load,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    download: (url, filename) => {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
    },
    later: (fn, ms) => {
      setTimeout(fn, ms);
    },
  };
}

/** ВЫЗЫВАТЬ ПРЯМО ИЗ ОБРАБОТЧИКА НАЖАТИЯ, без `await` перед вызовом. */
export async function openPrivateFile(file: string, deps: OpenPrivateFileDeps = browserDeps()): Promise<boolean> {
  // Синхронно, до любого ожидания: только так iPhone пропускает окно.
  const win = deps.open("", "_blank");
  let blob: Blob;
  try {
    blob = await deps.load(file);
  } catch {
    win?.close();
    return false;
  }
  const url = deps.createObjectURL(blob);
  if (win) win.location.href = url;
  else deps.download(url, file);
  deps.later(() => deps.revokeObjectURL(url), REVOKE_AFTER_MS);
  return true;
}
