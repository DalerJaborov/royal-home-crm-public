import { useState } from "react";
import { useDuplicates, useMergeClients, type DuplicateClient } from "../hooks/useDuplicates";
import { useDuplicateReviews, useConfirmDuplicateReview, useDenyDuplicateReview, type DuplicateReviewItem } from "../hooks/useClients";
import { useContactLinks, useDecideContactLink, type ContactLinkCandidate } from "../hooks/useContactLinks";
import { contactCategoryLabel } from "@royal-home/shared";
import { CLIENT_SOURCE_LABELS } from "../lib/clientFormat";
import { clientPrimaryState } from "../lib/clientPrimaryState";
import { relativeTime } from "../lib/format";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

/** Объединение дубликатов: в каждой группе выбирается «основная» карточка,
 * остальные вливаются в неё по одной (история и сделки переносятся).
 *
 * Широкая шторка: в строке живут имя, статус, источник, агент, число записей и
 * кнопка — на 440 px это превратилось бы в шесть переносов на строку. */
export function DuplicatesModal({ onClose }: { onClose: () => void }) {
  const { data: groups, isLoading, isError, error: loadError, refetch } = useDuplicates();
  const merge = useMergeClients();
  // Раздел L, уровень 4 (03.09.2026, план вечерней сессии §L) — «На слияние»:
  // ВСЕ пары по компании, ещё ждущие ответа агента (не только свои — тот же
  // ?all=1, что и для руководителя в GET /clients/duplicate-reviews). Модалка и
  // так открывается только по праву clients.merge (см. Clients.tsx), второй
  // проверки здесь не нужно — 403 от сервера, если что, просто даст пустой список.
  const { data: pendingReviews } = useDuplicateReviews(true);
  /**
   * КАНДИДАТЫ НА СЛИЯНИЕ ДОСЬЕ СОБЕСЕДНИКА — здесь же, а не отдельным экраном:
   * это та же работа и тот же человек, что разбирает дубликаты клиентов. Код
   * находил их с 20.09 и складывал в базу, а решить было нечем — и они копились
   * невидимо, пока бот читал одно досье из двух.
   */
  const { data: contactLinks } = useContactLinks(true);
  const [error, setError] = useState<string | null>(null);

  async function handleMerge(primary: DuplicateClient, duplicate: DuplicateClient, force = false) {
    setError(null);
    try {
      await merge.mutateAsync({ primaryId: primary.id, duplicateId: duplicate.id, force });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось объединить");
    }
  }

  return (
    <Rh2Sheet title="Возможные дубликаты" onClose={onClose} wide>
      <p className="state">
        Надёжные совпадения — по телефону или Telegram-аккаунту, одинаковое имя не считается дубликатом (Далер, Умед и
        другие имена часто принадлежат разным людям). Ниже отдельно — более слабый сигнал: похожее имя и похожий номер.
      </p>

      {/* Раздел L, уровень 4 — пары, ждущие ответа агента: руководитель может
          решить сам, не дожидаясь его. */}
      {(pendingReviews ?? []).length > 0 && (
        <>
          <div className="sec-t">На слияние — ждут ответа агента ({pendingReviews!.length})</div>
          <div className="list">
            {pendingReviews!.map((r) => (
              <PendingReviewRow key={r.id} review={r} />
            ))}
          </div>
        </>
      )}

      {(contactLinks ?? []).length > 0 && (
        <>
          <div className="sec-t">Похоже, это один собеседник ({contactLinks!.length})</div>
          <div className="list">
            {contactLinks!.map((c) => (
              <ContactLinkRow key={c.id} candidate={c} />
            ))}
          </div>
        </>
      )}

      {error && (
        <p className="quiet crit">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </p>
      )}

      {/* «База чистая» — утверждение обо ВСЕЙ базе, и раньше оно печаталось
          и на загрузке, и при отказе запроса (аудит 22.08.2026, раунд 5).
          Гигиена базы, объявленная по несостоявшемуся запросу, — ровно тот
          же класс, что «Все ключи в офисе» в Keys.tsx. */}
      {isLoading && <p className="state">Ищем дубликаты…</p>}

      {isError && (
        <div className="empty">
          <p>{loadError instanceof Error ? loadError.message : "Не удалось проверить базу на дубликаты"}</p>
          <span className="sub">Это не значит, что дубликатов нет, проверка не прошла.</span>
          <button type="button" className="pill ghost" onClick={() => refetch()}>
            Повторить
          </button>
        </div>
      )}

      {!isLoading && !isError && (groups ?? []).length === 0 && (
        <div className="empty">
          <p>Дубликатов не найдено, база чистая</p>
        </div>
      )}

      {groups?.map((g, gi) => {
        // Основной — самый «богатый»: больше истории, при равенстве — старейший.
        const sorted = [...g.clients].sort(
          (a, b) =>
            b._count.interactions + b._count.deals - (a._count.interactions + a._count.deals) ||
            +new Date(a.createdAt) - +new Date(b.createdAt)
        );
        const primary = sorted[0];
        // "nameAndPhone" (раздел L, уровень 4) — слабее "identity": номер не
        // совпадает, только последние 7 цифр + похожее имя, поэтому слияние
        // отсюда всегда идёт с force=true (POST /merge иначе откажет 409 —
        // тот же самый сервер, что уже требует force для несовпадающих номеров).
        const weak = g.reason === "nameAndPhone";
        return (
          <div key={gi}>
            <div className="sec-t">
              {weak ? "Похоже по имени и близкому номеру — проверьте вручную" : "Совпадает телефон или Telegram-аккаунт"}
            </div>
            <div className="list">
              {sorted.map((c) => (
                <div key={c.id} className="row wrapt">
                  <div className="t">
                    <b>{c.fullName}</b>
                    <span>
                      {c.phone} · {clientPrimaryState(c).label} · {CLIENT_SOURCE_LABELS[c.source]} ·{" "}
                      {c.assignedAgent?.fullName ?? "без агента"} · {c._count.interactions + c._count.deals} записей ·{" "}
                      {relativeTime(c.createdAt)}
                    </span>
                  </div>
                  {c.id === primary.id ? (
                    <span className="chip ok">основной</span>
                  ) : (
                    <div className="act">
                      <button
                        type="button"
                        className="pill ghost sm"
                        onClick={() => handleMerge(primary, c, weak)}
                        disabled={merge.isPending}
                      >
                        Влить в основного
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </Rh2Sheet>
  );
}

/**
 * Строка «На слияние» — руководитель видит пару, ждущую ответа конкретного
 * агента (owner карточки-кандидата), и может решить сам (override), не дожидаясь
 * его — те же confirm/deny, что и в собственном виджете агента (Dashboard.tsx),
 * только право clients.merge пропускает проверку «это точно вам адресовано».
 */
function PendingReviewRow({ review: r }: { review: DuplicateReviewItem }) {
  const confirm = useConfirmDuplicateReview(r.id);
  const deny = useDenyDuplicateReview(r.id);
  const busy = confirm.isPending || deny.isPending;
  return (
    <div className="row wrapt">
      <div className="t">
        <b>
          {r.fullName} ↔ {r.duplicateReviewOfClient?.fullName ?? "?"}
        </b>
        <span>
          {r.phone} / {r.duplicateReviewOfClient?.phone ?? "—"} · спросили{" "}
          {r.duplicateReviewOfClient?.assignedAgent?.fullName ?? "агента"} · {relativeTime(r.duplicateReviewAskedAt)}
        </span>
      </div>
      <div className="act">
        <button type="button" className="pill ghost sm" disabled={busy} onClick={() => deny.mutate()}>
          {deny.isPending ? "…" : "Разные"}
        </button>
        <button type="button" className="pill sm" disabled={busy} onClick={() => confirm.mutate()}>
          {confirm.isPending ? "…" : "Слить"}
        </button>
      </div>
    </div>
  );
}

/** Почему два досье предложены к слиянию — словами, а не кодом причины. */
const LINK_REASON_LABELS: Record<string, string> = {
  TRANSPORT_SPLIT: "один и тот же номер в разных каналах",
  STATED_PHONE: "назвал в переписке номер другого досье",
  NAME_AND_DIGITS: "совпали имя и хвост номера",
  USERNAME: "совпал ник",
};

/**
 * Строка «Похоже, это один собеседник». Какое досье останется жить, решает
 * сервер (там же, где слияние) — выбор «основного» руками был бы лишним
 * вопросом с одним и тем же ответом. Слитая запись не удаляется, поэтому
 * ошибочное решение можно разобрать.
 */
function ContactLinkRow({ candidate: c }: { candidate: ContactLinkCandidate }) {
  const decide = useDecideContactLink();
  const busy = decide.isPending;
  const name = (p: ContactLinkCandidate["left"]) =>
    p.displayName ?? contactCategoryLabel(p.category).toLowerCase();
  return (
    <div className="row wrapt">
      <div className="t">
        <b>
          {name(c.left)} ↔ {name(c.right)}
        </b>
        <span>
          {LINK_REASON_LABELS[c.reason] ?? c.reason} · {c.left.messagesIn} и {c.right.messagesIn} сообщений ·{" "}
          {relativeTime(c.createdAt)}
          {decide.isError ? ` · ${(decide.error as Error).message}` : ""}
        </span>
      </div>
      <div className="act">
        <button
          type="button"
          className="pill ghost sm"
          disabled={busy}
          onClick={() => decide.mutate({ id: c.id, decision: "dismiss" })}
        >
          {busy ? "…" : "Разные"}
        </button>
        <button
          type="button"
          className="pill sm"
          disabled={busy}
          onClick={() => decide.mutate({ id: c.id, decision: "confirm" })}
        >
          {busy ? "…" : "Это один человек"}
        </button>
      </div>
    </div>
  );
}
