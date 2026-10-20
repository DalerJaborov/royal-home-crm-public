import { Link } from "react-router-dom";

/**
 * КНОПКА «ЗАПРОСИТЬ ИЗМЕНЕНИЕ» рядом с пояснением, почему карточку не правят
 * (владелец 07.10.2026). Сама заявка (готовые кнопки, формы, «Мои заявки») —
 * `PropertyChangeRequestCard` на карточке объекта; здесь только короткий путь к ней:
 * на самой карточке — прокрутка к блоку, из формы правки — переход на карточку.
 */
export function RequestChangeSlot({ href }: { href: string }) {
  const className = "pill sm";
  return (
    <div data-testid="request-change-slot">
      {href.startsWith("#") ? (
        <a className={className} href={href}>
          Запросить изменение
        </a>
      ) : (
        <Link className={className} to={href}>
          Запросить изменение
        </Link>
      )}
    </div>
  );
}
