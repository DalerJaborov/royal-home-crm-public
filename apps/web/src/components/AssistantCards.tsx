import { Link } from "react-router-dom";
import type { AssistantCard } from "@royal-home/shared";
import { CLIENT_STATUS_LABELS } from "../lib/clientFormat";
import { exactDateTime, formatMoney, PROPERTY_STATUS_LABELS } from "../lib/format";

/**
 * Карточка результата помощника (SSE-событие `card`, packages/shared/assistantCard.ts).
 *
 * Сервер уже отдал поля с учётом прав вызвавшего (маска телефона и т.д.) — здесь
 * только вид. Вся карточка — ссылка в раздел, поэтому открывается тем же роутером,
 * что и ссылки в тексте ответа, и закрывает панель (`onNavigate`). Размеры текста
 * не мельче 13px, цвета — токены темы, без своих оттенков.
 */
const muted = { color: "var(--muted)", fontSize: 13 } as const;

export function AssistantCardView({ card, onNavigate }: { card: AssistantCard; onNavigate: () => void }) {
  const isProperty = card.kind === "property";
  const statusLabel = isProperty
    ? (PROPERTY_STATUS_LABELS[card.status as keyof typeof PROPERTY_STATUS_LABELS] ?? card.status)
    : (CLIENT_STATUS_LABELS[card.status as keyof typeof CLIENT_STATUS_LABELS] ?? card.status);

  return (
    <Link
      to={card.href}
      onClick={onNavigate}
      className="card"
      data-assistant-card={card.kind}
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: "12px 14px", textDecoration: "none", color: "inherit" }}
    >
      <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <b>{card.code}</b>
        <span className="chip">{statusLabel}</span>
      </span>
      {card.kind === "property" ? (
        <>
          <span>{card.title}</span>
          <span style={muted}>
            {[
              formatMoney(card.price, card.currency),
              card.rooms ? `${card.rooms}-комн.` : null,
              `${card.areaSqm} м²`,
              card.district,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {card.agent && <span style={muted}>Агент: {card.agent}</span>}
        </>
      ) : (
        <>
          <span>{card.name}</span>
          <span style={muted}>{card.phone}</span>
          <span style={muted}>
            {[card.agent ? `Агент: ${card.agent}` : null, card.lastContactAt ? `Контакт: ${exactDateTime(card.lastContactAt)}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </>
      )}
    </Link>
  );
}

export function AssistantCardList({ cards, onNavigate }: { cards: AssistantCard[]; onNavigate: () => void }) {
  if (cards.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignSelf: "stretch" }}>
      {cards.map((card) => (
        <AssistantCardView key={`${card.kind}:${card.id}`} card={card} onNavigate={onNavigate} />
      ))}
    </div>
  );
}
