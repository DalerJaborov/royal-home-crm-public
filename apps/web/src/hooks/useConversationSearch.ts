import { useCallback, useMemo, useState } from "react";
import type { ConversationMessage } from "../types";

/**
 * ПОИСК ВНУТРИ ОТКРЫТОГО ДИАЛОГА (06.09.2026).
 *
 * Раньше поиск (шапка инбокса, `Messages.tsx`) находил только ДИАЛОГ целиком по
 * списку слева — конкретную реплику внутри уже открытой переписки найти было
 * нельзя, приходилось листать вручную. Это чисто клиентский поиск по уже
 * загруженному массиву `messages` — история диалога и так приходит с сервера
 * ОДНИМ запросом целиком (`GET /conversations/:id` / `client.botConversation`),
 * поэтому искать есть по чему без похода на сервер и без новой нагрузки на API.
 *
 * Общий для десктопного инбокса (`pages/Messages.tsx`) и мобильного
 * (`components/mobile/MobileChatView.tsx`) — сама логика (что считать
 * совпадением, какой индекс сейчас активен, next/prev с переносом по кругу)
 * одна и та же, в отличие от вёрстки строки поиска и подсветки, которая у
 * каждого экрана своя.
 */
export function useConversationSearch(messages: ConversationMessage[]) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Индекс ВНУТРИ массива найденных совпадений (matches), не абсолютный индекс
  // сообщения — так next/prev не зависят от того, что именно нашлось.
  const [activeMatch, setActiveMatch] = useState(0);

  // Абсолютные индексы сообщений в `messages`, чей content содержит запрос
  // (без учёта регистра). Пустой запрос — пустой список: не подсвечивать и не
  // листать «совпадения», когда пользователь ещё ничего не ввёл.
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    const result: number[] = [];
    messages.forEach((m, i) => {
      if (m.content?.toLowerCase().includes(q)) result.push(i);
    });
    return result;
  }, [messages, query]);

  // Абсолютный индекс сообщения — текущее совпадение, на которое надо
  // проскроллить и выделить ярче остальных. null — искать нечего или ничего
  // не найдено (пустая строка результата, а не сломанный скролл в никуда).
  const activeAbsoluteIndex = matches.length > 0 ? matches[Math.min(activeMatch, matches.length - 1)] : null;

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setActiveMatch(0);
  }, []);

  const changeQuery = useCallback((value: string) => {
    setQuery(value);
    setActiveMatch(0);
  }, []);

  // Перенос по кругу — последнее совпадение → следующим станет первое, и
  // наоборот: то же поведение, что у Ctrl+F в браузере.
  const goNext = useCallback(() => {
    setActiveMatch((i) => (matches.length === 0 ? 0 : (i + 1) % matches.length));
  }, [matches.length]);
  const goPrev = useCallback(() => {
    setActiveMatch((i) => (matches.length === 0 ? 0 : (i - 1 + matches.length) % matches.length));
  }, [matches.length]);

  return {
    isOpen,
    open,
    close,
    query,
    setQuery: changeQuery,
    matches,
    activeMatch,
    activeAbsoluteIndex,
    goNext,
    goPrev,
  };
}
