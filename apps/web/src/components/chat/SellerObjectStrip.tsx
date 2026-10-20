import { useNavigate } from "react-router-dom";
import { sellerFactsSummary, sellerMediaSummary, useSellerObject } from "../../hooks/useSellerObject";

/**
 * ПОЛОСА ПОД ШАПКОЙ ЧАТА ПРОДАВЦА (владелец 21.09.2026, макет «Объект из
 * переписки», `chat-add-object.html`, раздел 1 «Чат с продавцом»).
 *
 * ОДИН КОМПОНЕНТ НА ОБЕ РАСКЛАДКИ, а не Mobile-копия (правило CLAUDE.md про
 * `Mobile*.tsx`): `.pane-b` — тот же класс, что уже держит строку поиска/данных
 * диалога и в Messages.tsx, и в MobileChatView.tsx (оба экрана давно рисуют
 * `.pane-h`/`.pane-b` темы «Royal Home 2026» одинаково) — своей разметки под
 * ширину экрана заводить незачем.
 *
 * БЕЗ ВЫЗОВА ИИ: `useSellerObject` только читает уже посчитанные факты (см.
 * apps/api/src/lib/sellerFacts.ts, фоновое задание). Полоса рисуется на КАЖДЫЙ
 * открытый диалог — платный вызов здесь означал бы плату за каждый взгляд.
 *
 * Рендерит `null`, если клиент не продавец (`isSeller: false`) — по макету
 * полоса видна ТОЛЬКО в чате продавца, у покупателя её нет вовсе.
 */
export function SellerObjectStrip({ clientId }: { clientId: string | null | undefined }) {
  const navigate = useNavigate();
  const { data, isLoading } = useSellerObject(clientId);

  if (!clientId || isLoading || !data || !data.isSeller) return null;

  const addUrl = `/properties/new?fromClient=${clientId}`;
  const existing = data.properties[0];
  const media = sellerMediaSummary(data);
  const facts = sellerFactsSummary(data);

  return (
    <div
      className="pane-b"
      style={{ display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid var(--line-soft)" }}
      data-testid="seller-object-strip"
    >
      <span className="txt" style={{ flex: 1, minWidth: 0, fontSize: "var(--fs-13)" }}>
        {existing ? (
          <>
            <b>ОБ-{String(existing.shortId).padStart(6, "0")}</b>
            {facts ? ` · ${facts}` : ""}
          </>
        ) : media || facts ? (
          <>
            {media && <b>{media}</b>}
            {media && facts ? " · " : ""}
            {facts}
          </>
        ) : (
          "Продавец пока не присылал фото и параметры объекта"
        )}
      </span>

      {existing ? (
        <>
          <button
            type="button"
            className="pill ghost sm"
            onClick={() => navigate(`/properties/${existing.shortId}`)}
            data-testid="seller-object-open"
          >
            Открыть
          </button>
          <button
            type="button"
            className="pill ghost sm"
            onClick={() => navigate(addUrl)}
            aria-label="Ещё объект от этого продавца"
            data-testid="seller-object-more"
          >
            Ещё
          </button>
        </>
      ) : (
        <button type="button" className="pill sm" onClick={() => navigate(addUrl)} data-testid="seller-object-add">
          Добавить объект
        </button>
      )}
    </div>
  );
}
