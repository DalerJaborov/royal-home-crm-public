import { RefreshCw } from "lucide-react";

/**
 * Общий кирпич «не удалось загрузить» — та же идиома `.empty`, что у
 * `Rh2EmptyState`, но с кнопкой повтора вместо второстепенной подсказки.
 * Разбор §2.6 `docs/ui-audit-night-20-09.md`: раньше это была то голая
 * красная строка вне карточки, то `.quiet crit` с подчёркнутой ссылкой —
 * владелец читал это как поломку. Здесь — тихая строка ВНУТРИ карточки,
 * серый значок (не `--crit`), одна человеческая фраза без слов вроде «сбой
 * связи»/«снимок»/«журнал недоступен», и кнопка-пилюля «Попробовать снова»,
 * а не подчёркнутая ссылка.
 *
 * ОДИН ОБЩИЙ КОМПОНЕНТ ошибки загрузки на все экраны (К14, аудит 20.11.2026): понятный текст и кнопка «Повторить»;
 * экран с данными, у которого запрос может упасть, показывает его вместо серого скелета (сторож —
 * `loadErrorGuard.test.ts`). Внутри блока главной та же роль у `RhBlockState kind="error"` (тот же текст и та же кнопка).
 *
 * `message` — необязательный, для тех редких случаев, где стоит уточнить
 * что именно не загрузилось («Не удалось загрузить звонки. Попробуйте ещё
 * раз.»); формулировка всё равно должна остаться человеческой.
 */
/**
 * ЕДИНАЯ ФУНКЦИЯ «ЧТО СЕЙЧАС С ЗАГРУЗКОЙ» (ревью #346): одно место, где решается, что показать вместо данных.
 *  - есть данные → "ready": их НЕ прячем ни при фоновой ошибке, ни при паузе (человек видит прежнее, а не пустой экран);
 *  - данных нет, запрос на паузе (устройство без связи, react-query networkMode "online") → "offline":
 *    «Нет связи. Загрузим, как только она появится» — сам запрос поедет, когда связь вернётся;
 *  - данных нет, запрос упал → "error": «Не удалось загрузить» + «Повторить»;
 *  - иначе → "loading" (серые плашки).
 * Сторож `loadErrorGuard.test.ts` не пускает на экраны нового вида проверку `isError` мимо этой функции.
 */
export type LoadView = "ready" | "loading" | "offline" | "error";
export type LoadQuery = { data: unknown; isError: boolean; fetchStatus: "fetching" | "paused" | "idle" };
export function loadView(q: LoadQuery): LoadView {
  if (q.data !== undefined) return "ready";
  if (q.fetchStatus === "paused") return "offline";
  if (q.isError) return "error";
  return "loading";
}

/** Текст «нет связи»: один на карточку и на блок главной (`RhBlockState kind="offline"`). */
export const OFFLINE_TEXT = "Нет связи. Загрузим, как только она появится.";

export function Rh2OfflineState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="empty" role="status">
      <span className="ic">
        <RefreshCw className="i" aria-hidden />
      </span>
      <p>{OFFLINE_TEXT}</p>
      <button className="pill ghost" type="button" onClick={onRetry}>
        Повторить
      </button>
    </div>
  );
}

/**
 * Карточка вместо данных, когда их нет: «нет связи» или «не удалось загрузить» (иначе null — экран рисует своё).
 * Вызывать вместо самописного `isError && …`.
 */
export function Rh2LoadProblem({ query, message }: { query: LoadQuery & { refetch: () => unknown; isFetching: boolean }; message?: string }) {
  const view = loadView(query);
  if (view === "offline") return <Rh2OfflineState onRetry={() => void query.refetch()} />;
  if (view === "error") return <Rh2ErrorState message={message} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  return null;
}

export function Rh2ErrorState({
  message = "Не удалось загрузить. Проверьте связь и нажмите «Повторить».",
  onRetry,
  retrying,
}: {
  message?: string;
  onRetry: () => void;
  retrying?: boolean;
}) {
  return (
    <div className="empty">
      <span className="ic">
        <RefreshCw className="i" aria-hidden />
      </span>
      <p>{message}</p>
      <button className="pill ghost" type="button" onClick={onRetry} disabled={retrying}>
        {retrying ? "Пробуем снова…" : "Повторить"}
      </button>
    </div>
  );
}

/**
 * Первый запрос не прошёл, идут повторы (окно `RETRY_WINDOW_MS`, lib/queryClient.ts): говорим словами, с отступами и сразу даём «Повторить» —
 * а не молча крутим серые плашки и не жмём строку к краю карточки (К14, аудит 20.11.2026, кадр 14.2).
 */
export function Rh2RetryingNote({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="empty" role="status">
      <p>Связь с сервером прерывается, пробуем ещё раз…</p>
      <button className="pill ghost" type="button" onClick={onRetry}>
        Повторить
      </button>
    </div>
  );
}
