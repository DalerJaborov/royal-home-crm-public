import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ErrorBoundary } from "./ErrorBoundary";

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
 * «Повторить» снимает ошибку и перезапрашивает активные запросы экрана: если
 * упало от неполного ответа сервера, свежий ответ обычно чинит блок. Если упало
 * от старой сборки против нового сервера, вкладку обновит UpdatePrompt.
 */
export type BlockContent = ReactNode | (() => ReactNode);

export function BlockBoundary({ name, fallback, children }: {
  name: string;
  fallback: (retry: () => void) => ReactNode;
  children: BlockContent;
}) {
  const queryClient = useQueryClient();
  return (
    <ErrorBoundary
      name={name}
      // Сначала свежие данные, потом повторная отрисовка: иначе блок перерисуется
      // на том же ответе, на котором только что упал.
      fallback={(reset) => fallback(() => {
        void queryClient.refetchQueries({ type: "active" }).finally(reset);
      })}
    >
      <BlockBody content={children} />
    </ErrorBoundary>
  );
}

function BlockBody({ content }: { content: BlockContent }) {
  return <>{typeof content === "function" ? content() : content}</>;
}
