import { Archive, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * МЕЛКИЕ ЧАСТИ СПИСКА ЧАТОВ (макет владельца 26.11.2026): серые строки на время подгрузки, вход в «Архив»
 * и шапка самого архива. Своих запросов нет: счётчик и переключение приходят от списка.
 */

/** Серые строки: список подгружается при прокрутке сам, кнопки «Показать ещё» нет. */
export function ChatSkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div role="status" aria-label="Подгружаем ещё" data-testid="chat-skeleton">
      {Array.from({ length: count }, (_, index) => (
        <div className="ry-chat-skel" key={index} aria-hidden="true">
          <i />
          <span><i /><i /></span>
        </div>
      ))}
    </div>
  );
}

/** Строка «Архив · N» над списком «Все»: переписки без карточки клиента и без сообщений 30 дней. */
export function ArchiveEntryRow({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button type="button" className="ry-chat-archive" onClick={onOpen} data-testid="chat-archive-entry">
      <span className="ry-chat-archive-ic" aria-hidden="true"><Archive /></span>
      <span className="ry-chat-archive-tx">
        <b>Архив</b>
        <span>Старые переписки без карточки клиента</span>
      </span>
      <span className="ry-chat-archive-n">{count}</span>
      <ChevronRight aria-hidden="true" width={20} height={20} />
    </button>
  );
}

/** Шапка внутри архива: как сюда попали, чем он безопасен и как вернуться. */
export function ArchiveHeaderRow({ count, onBack }: { count: number; onBack: () => void }) {
  return (
    <button type="button" className="ry-chat-archive" onClick={onBack} data-testid="chat-archive-back">
      <span className="ry-chat-archive-ic" aria-hidden="true"><ChevronLeft /></span>
      <span className="ry-chat-archive-tx">
        <b>Архив · {count}</b>
        <span>Поиск находит эти переписки, новое сообщение возвращает чат в список. Нажмите, чтобы вернуться ко всем.</span>
      </span>
    </button>
  );
}
