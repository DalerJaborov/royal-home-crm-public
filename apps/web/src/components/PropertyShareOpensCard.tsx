import { usePropertyShareLinks } from "../hooks/useProperties";
import { relativeTime } from "../lib/format";

/**
 * «Ссылки клиентам: кто открыл» — список выданных на объект личных ссылок,
 * только чтение.
 *
 * Откуда он взялся. До #1016 (29.09.2026) на карточке объекта стояла
 * `PropertyShareLinksCard`, и она делала ДВА разных дела: форму «создать
 * ссылку руками» и показ уже выданных с меткой «открыл / не открыл».
 * Владелец просил убрать первое — убралось вместе со вторым, и «кто открыл»
 * не осталось нигде: по `viewedAt` во фронте не было ни одного места.
 *
 * А ссылки выдаёт не только человек. Рассылка «Разослать по СМС» (просьба
 * владельца 23.09.2026, `MatchPanel`) даёт каждому клиенту подборки свою
 * ссылку — ровно затем, чтобы потом было видно, кто её открыл; выдаёт их
 * `getOrCreatePropertyShareLinks` в `routes/properties/smsShare.ts`. Маршрут
 * `GET /properties/:id/share-links` после #1016 остался живым, но без единого
 * вызывающего.
 *
 * Поэтому здесь нет ни создания, ни отзыва, ни копирования: решение владельца
 * про ручную ссылку не отменяется. Карточка отвечает на один вопрос — открыл
 * клиент присланное или нет.
 */
export function PropertyShareOpensCard({ propertyId }: { propertyId: string }) {
  const { data, isLoading, isError, error, refetch } = usePropertyShareLinks(propertyId);

  /* Пока ссылок нет, карточка не нужна вовсе: на объектах, которые никому не
     рассылали, это была бы пустая строка «ссылок пока нет» на каждой карточке.
     Прежняя карточка её показывала, потому что рядом стояла кнопка создания. */
  if (!isLoading && !isError && !data?.items.length) return null;

  return (
    <div className="card">
      <div className="sec-h stack">
        <h2>Ссылки клиентам</h2>
        <span className="note">Личная ссылка каждому, видно кто открыл</span>
      </div>

      {isLoading ? (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Загружаем…</span>
        </div>
      ) : isError ? (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error instanceof Error ? error.message : "Не удалось загрузить ссылки"}.</span>
          <button className="lnk" type="button" onClick={() => refetch()}>
            Повторить
          </button>
        </div>
      ) : (
        <div className="list">
          {data?.items.map((link) => {
            const revoked = !!link.revokedAt;
            const statusLabel = revoked
              ? "Отозвана"
              : link.isExpired
                ? "Истекла"
                : link.viewedAt
                  ? "Открыл"
                  : "Ещё не открыл";
            const statusChip = revoked || link.isExpired ? "chip mute" : link.viewedAt ? "chip ok" : "chip warn";
            return (
              <div className="row" key={link.id}>
                <div className="t">
                  <b>{link.client?.fullName ?? "Без карточки клиента"}</b>
                  {/* Отправлена тогда-то; открыл — когда открыл, это и есть ответ. */}
                  <span>{link.viewedAt ? relativeTime(link.viewedAt) : relativeTime(link.createdAt)}</span>
                </div>
                <span className={statusChip}>{statusLabel}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
