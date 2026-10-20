import { useEffect, useState } from "react";
import { api } from "../lib/api";

/**
 * Плеер уже сохранённой голосовой заметки (заморозка сотрудника, отказ вакансии,
 * итог звонка/показа, заявка на удаление и т.п. — везде, где рядом стоит
 * VoiceNoteButton/SummaryVoiceNoteButton).
 *
 * Тот же приём, что у MessageAttachments.tsx: файл лежит в закрытом хранилище и
 * отдаётся маршрутом с проверкой Authorization (GET /me/voice-notes/:name,
 * routes/me.ts, исправлено 02.09.2026 — раньше папка была публичной статикой без
 * единой проверки). Тег `<audio src>` заголовков не шлёт — получилась бы битая
 * ссылка, поэтому качаем файл через api() и показываем blob-ссылкой.
 *
 * ОБЛИК. Плеер живёт на восьми экранах, и семь из них ещё не переведены на тему
 * «Royal Home 2026» (Профиль, Архив, Карточка объекта, Вакансии, Заморозка,
 * Проблемы, Разбор ИИ). CSS макета действует только внутри `.rh2`, поэтому
 * безусловный перевод оставил бы плеер на этих экранах вообще без стилей.
 * Отсюда необязательный проп `rh2` — тот же приём, что у `ClientsTabs`: новый
 * облик включает ТОЛЬКО перенесённый экран (сейчас — хронология карточки
 * клиента), остальные получают прежний вид без единого изменения.
 */
export function VoiceNotePlayer({
  url,
  className,
  rh2 = false,
}: {
  url: string;
  className?: string;
  rh2?: boolean;
}) {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;

    setState({ url: null, failed: false });
    api<Blob>(url, { responseType: "blob" })
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
  }, [url]);

  if (state.failed) {
    if (rh2) return <span className="state err">Заметка не открылась</span>;
    return <span className="text-[13px] text-gray-400">Заметка не открылась</span>;
  }
  if (!state.url) {
    // `.sk` — скелетон прототипа; ширина задана инлайном, как в макете (`.sk.w28`
    // фиксирует процент от родителя, здесь нужен предсказуемый размер плеера).
    if (rh2) return <span className="sk" style={{ display: "inline-block", height: 32, width: 220 }} />;
    return <span className={`inline-block rounded-lg bg-line-soft animate-pulse h-8 w-[220px] ${className ?? ""}`} />;
  }
  if (rh2) {
    // Полосу `.voice` прототипа рисует нативный плеер: перерисовывать её своими
    // кнопками значило бы заново писать перемотку и время — их макет не задаёт.
    // Класс даёт ту же строку с отступом и высотой 44px, что в messages.html.
    return (
      <span className="voice">
        <audio controls preload="none" src={state.url} style={{ height: 34, maxWidth: 260, flex: 1 }} />
      </span>
    );
  }
  return <audio controls preload="none" src={state.url} className={className ?? "h-8 max-w-[260px]"} />;
}
