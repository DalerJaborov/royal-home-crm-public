import { daysSince, pluralizeRu } from "../lib/format";
import type { Property } from "../types";

/** Shared desktop/mobile metrics. Legacy viewsCount counts showing bookings,
 * including cancellations, and is not evidence of card views or completed showings.
 * Show conducted showings only when the API supplies the verified aggregate. */
export function PropertyStats({ property: p }: { property: Property }) {
  const cells: { value: string; label: string; title: string; key: string }[] = [];

  if (typeof p.conductedShowingsCount === "number") {
    cells.push({
      key: "showings",
      value: String(p.conductedShowingsCount),
      // Подпись сокращена намеренно: колонка названия в широкой строке каталога
      // всего 255 px (замер 11.09), и три полных слова уезжали во вторую строку,
      // добавляя 57 px высоты каждой строке списка из двадцати. Полная
      // формулировка осталась в подсказке.
      label: "показов",
      title: `Проведено показов: ${p.conductedShowingsCount}`,
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
