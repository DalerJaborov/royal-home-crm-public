import { daysSince, pluralizeRu } from "../lib/format";
import type { Property } from "../types";

/**
 * ТРИ ЦИФРЫ ПОД НАЗВАНИЕМ ОБЪЕКТА — плитками, как в Livento-кейсе.
 *
 * Бриф цветного слоя (docs/archive/agent-briefs/color-layer.md, пункт 6): в кейсе под
 * карточкой объекта стоят три маленькие плитки — 175 Sold / 125 Rented / 2K+
 * Views. Фото слева в строке каталога уже было (`.ph` эталона); здесь добавлены
 * цифры.
 *
 * ЧТО ПОКАЗЫВАЕМ И ПОЧЕМУ ИМЕННО ЭТО. Взяты только поля, которые ДЕЙСТВИТЕЛЬНО
 * приходят в ответе списка (apps/api/src/routes/properties/list.ts):
 *   · `viewsCount`        — просмотры карточки;
 *   · `listingAcceptedAt` — отсюда «дней в продаже»;
 *   · `demandCount`       — сколько клиентов подходит объекту по требованиям.
 *
 * Третьей цифрой брифа значились «показы». Их в ответе списка НЕТ: проведённые
 * показы живут в Interaction(type=SHOWING) и по объектам страницы не считаются.
 * Выдумывать нечем, поэтому вместо них честный «спрос» — то, что этот же список
 * уже считает. Плитка, для которой поля нет, не рисуется вовсе.
 *
 * Один компонент на ПК и телефон: строка каталога у них общая по разметке
 * (`.prow`), и две копии этих же трёх цифр разъехались бы при первой же правке.
 */
export function PropertyStats({ property: p }: { property: Property }) {
  const cells: { value: string; label: string; title: string; key: string }[] = [];

  if (typeof p.viewsCount === "number") {
    cells.push({
      key: "views",
      value: String(p.viewsCount),
      // Подпись сокращена намеренно: колонка названия в широкой строке каталога
      // всего 255 px (замер 11.09), и три полных слова уезжали во вторую строку,
      // добавляя 57 px высоты каждой строке списка из двадцати. Полная
      // формулировка осталась в подсказке.
      label: "просм.",
      title: `Просмотров карточки: ${p.viewsCount}`,
    });
  }

  // «Дней в продаже» считаем от приёма объекта. У проданного счётчик замирает на
  // дате продажи: иначе карточка в архиве продолжала бы «стареть» каждый день.
  const from = p.listingAcceptedAt || p.createdAt;
  if (from) {
    const days = p.soldAt
      ? Math.max(0, Math.floor((new Date(p.soldAt).getTime() - new Date(from).getTime()) / 86400000))
      : daysSince(from);
    cells.push({
      key: "days",
      value: String(days),
      label: p.soldAt ? "дн. до продажи" : "дн. в продаже",
      title: p.soldAt
        ? `От приёма объекта до продажи прошло ${days} ${pluralizeRu(days, ["день", "дня", "дней"])}`
        : `В продаже ${days} ${pluralizeRu(days, ["день", "дня", "дней"])}`,
    });
  }

  if (typeof p.demandCount === "number") {
    cells.push({
      key: "demand",
      value: String(p.demandCount),
      label: "ждут покупателей",
      title: "Покупатели, чьим требованиям подходит объект",
    });
  }

  if (cells.length === 0) return null;

  return (
    <span className="pstats">
      {cells.map((c) => (
        <span className="pstat" key={c.key} title={c.title}>
          <b>{c.value}</b>{" "}
          <small>{c.label}</small>
        </span>
      ))}
    </span>
  );
}
