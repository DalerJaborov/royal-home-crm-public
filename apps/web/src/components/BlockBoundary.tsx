import { useState, type ReactNode } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { ErrorBoundary } from "./ErrorBoundary";
import { isChunkLoadError } from "../lib/chunkLoadError";

/**
 * ГРАНИЦА ОДНОГО БЛОКА ГЛАВНОЙ (20.11.2026).
 *
 * Случай: 18.11 в 10:04 UTC на iPhone владельца главная целиком показала «Что-то
 * пошло не так» — `undefined is not an object (evaluating 't.count')`. Телефон
 * держал сборку до правки #220: она рисовала три плитки «Контроля», а сервер с
 * #220 отдаёт две (плитку «На лимите нагрузки» убрали вместе с лимитом). Одна
 * плитка без данных уронила весь экран, хотя остальные блоки были в порядке.
 *
 * Теперь каждый блок главной стоит за своей границей: упал — блок пишет «Не
 * загрузилось» и кнопку «Повторить», соседи живут, ошибка уходит в журнал с
 * именем блока. Ловить и записывать — по-прежнему одна дверь, `ErrorBoundary`.
 *
 * ПОЧЕМУ `children` МОЖЕТ БЫТЬ ФУНКЦИЕЙ. Граница React ловит ошибки отрисовки
 * ДОЧЕРНИХ компонентов. Выражение вида `{hero.leadsToday.count}`, записанное в
 * JSX родителя, вычисляется в отрисовке самого родителя — граница вокруг него
 * ничего бы не поймала, и упала бы вся страница. Функция откладывает вычисление
 * внутрь границы: `<CleanBlock>{() => <Kpi value={hero.x.count} />}</CleanBlock>`.
 *
 * «Повторить» перезапрашивает только упавшие, помеченные к обновлению и
 * устаревшие запросы (не все подряд), кнопка заблокирована, пока они идут, и
 * лишь потом блок рисуется заново: на том же ответе повтор бессмыслен.
 *
 * КУСОК СБОРКИ НЕ ЗАГРУЗИЛСЯ (`isChunkLoadError`) — это вкладка на старой сборке
 * после выката, а не данные. «Повторить» тут не поможет: React.lazy запоминает
 * отказ навсегда. Такой блок говорит «Вышла новая версия» и предлагает обновить
 * страницу — тем же действием, что граница страницы.
 */
export type BlockContent = ReactNode | (() => ReactNode);

export interface BlockFallbackProps {
  /** Перезапросить упавшее и нарисовать блок заново. */
  retry: () => void;
  /** Перезапрос идёт — кнопку держим заблокированной. */
  retrying: boolean;
  /** Кусок сборки не загрузился: нужен не повтор, а обновление страницы. */
  stale: boolean;
  /** Обновить страницу (для `stale`). */
  reload: () => void;
}

/** Какие запросы «Повторить» перезапрашивает: упавшие, помеченные к обновлению и устаревшие. */
export function needsRetry(query: Query): boolean {
  return query.state.status === "error" || query.state.isInvalidated || query.isStale();
}

export function BlockBoundary({ name, fallback, children }: {
  name: string;
  fallback: (props: BlockFallbackProps) => ReactNode;
  children: BlockContent;
}) {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  return (
    <ErrorBoundary
      name={name}
      fallback={(reset, error) => fallback({
        stale: isChunkLoadError(error),
        reload: () => window.location.reload(),
        retrying,
        retry: () => {
          if (retrying) return;
          setRetrying(true);
          void queryClient.refetchQueries({ type: "active", predicate: needsRetry }).finally(() => {
            setRetrying(false);
            reset();
          });
        },
      })}
    >
      <BlockBody content={children} />
    </ErrorBoundary>
  );
}

function BlockBody({ content }: { content: BlockContent }) {
  return <>{typeof content === "function" ? content() : content}</>;
}
