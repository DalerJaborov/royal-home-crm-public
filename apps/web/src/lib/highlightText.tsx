import { Fragment } from "react";

/** Экранирует спецсимволы regexp — запрос пользователя («?», «(», «.» и т.п.)
 *  не должен трактоваться как часть регулярного выражения. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Подсвечивает вхождения `query` внутри `text` — используется поиском внутри
 * открытого диалога (`useConversationSearch`) в десктопном инбоксе и мобильном
 * чате. Без учёта регистра, без изменения самого текста (whitespace-pre-wrap
 * на пузыре сообщения делает остальное). Пустой запрос — исходный текст без
 * единой обёртки: не заворачивать в <mark> то, что не искали.
 *
 * `isActiveMessage` красит ВСЕ вхождения в этом сообщении ярче остальных —
 * «активное совпадение» в `useConversationSearch` это конкретное СООБЩЕНИЕ
 * (то, к которому сейчас проскроллили), а не одно конкретное вхождение внутри
 * него; если запрос встретился в сообщении дважды, обе подсветки должны быть
 * одинаково яркими, чтобы глаз не гадал, которая из двух — «та самая».
 */
export function highlightText(text: string, query: string, isActiveMessage: boolean) {
  const q = query.trim();
  if (!q) return text;

  const parts = text.split(new RegExp(`(${escapeRegExp(q)})`, "gi"));
  if (parts.length === 1) return text;

  return parts.map((part, i) =>
    part.toLowerCase() === q.toLowerCase() ? (
      <mark
        key={i}
        className={isActiveMessage ? "rounded-xs bg-amber px-0.5 text-ink" : "rounded-xs bg-amber/30 px-0.5 text-ink"}
      >
        {part}
      </mark>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    )
  );
}
