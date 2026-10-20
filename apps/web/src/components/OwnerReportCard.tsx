import { useIsReadOnly } from "../lib/permissions";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pluralizeRu, type OwnerReportLinkInfo } from "@royal-home/shared";
import { api } from "../lib/api";
import { reportDateTime } from "../lib/ownerReportView";
import { toast } from "../store/toast";
import "../owner-report.css";

/**
 * «ОТЧЁТ ВЛАДЕЛЬЦУ» В КАРТОЧКЕ ОБЪЕКТА (03.10.2026, lib/ownerReport/ на сервере).
 *
 * Публичная страница по секретной ссылке «Что мы сделали для вашей квартиры» — аргумент
 * для разговора с собственником об эксклюзиве и цене. НИЧЕГО не отправляется владельцу
 * само: здесь только «создать», «скопировать / открыть» и «отозвать». Кому и как передать
 * ссылку, решает сотрудник.
 *
 * Показывается тем же людям, что делятся объектом (серверный canManageProperty:
 * `properties.editForeign`, ответственный, принявший, создатель) — условие стоит в
 * PropertyDetail, а сервер всё равно проверяет сам. Один адаптивный блок на телефон и
 * компьютер: отдельной мобильной копии нет.
 */

interface LinkResponse {
  link: OwnerReportLinkInfo | null;
}

const linkKey = (propertyId: string) => ["property", propertyId, "owner-report-link"] as const;

/** Абсолютный адрес страницы: сервер без `CRM_PUBLIC_URL` отдаёт относительный `/o/…`. */
function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

export function OwnerReportCard({ propertyId }: { propertyId: string }) {
  const qc = useQueryClient();
  const readOnly = useIsReadOnly();
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const path = `/properties/${propertyId}/owner-report-link`;
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const urlInput = useRef<HTMLInputElement>(null);

  const query = useQuery({
    queryKey: linkKey(propertyId),
    queryFn: () => api<LinkResponse>(path),
    staleTime: 60_000,
  });
  const create = useMutation({
    mutationFn: () => {
      if (readOnlyRef.current) throw new Error("Доступ только для просмотра");
      return api<LinkResponse>(path, { method: "POST" });
    },
    onSuccess: (data) => qc.setQueryData(linkKey(propertyId), data),
  });
  const revoke = useMutation({
    mutationFn: () => {
      if (readOnlyRef.current) throw new Error("Доступ только для просмотра");
      return api<void>(path, { method: "DELETE" });
    },
    onSuccess: () => {
      qc.setQueryData(linkKey(propertyId), { link: null } satisfies LinkResponse);
      setConfirmRevoke(false);
    },
  });

  const link = query.data?.link ?? null;
  const url = link ? absoluteUrl(link.url) : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Ссылка скопирована");
    } catch {
      // Буфер недоступен (нет разрешения, небезопасный контекст) — выделяем адрес, чтобы скопировать вручную.
      urlInput.current?.focus();
      urlInput.current?.select();
      toast.error("Не удалось скопировать — адрес выделен, скопируйте вручную");
    }
  }

  return (
    <section className="card" aria-labelledby="orc-title">
      <div className="sec-h stack">
        <h2 id="orc-title">Отчёт владельцу</h2>
      </div>
      <p className="orc-meta">
        Страница с цифрами по объекту для собственника: сколько людей увидели квартиру, что спрашивают и какой шаг
        предлагаем дальше. Ссылка никому не отправляется сама — вы передаёте её сами.
      </p>

      {query.isLoading ? (
        <p className="state" role="status">
          Загружаем…
        </p>
      ) : query.isError ? (
        <p className="state" role="alert">
          Не удалось получить ссылку. Обновите страницу.
        </p>
      ) : link ? (
        <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
          <label>
            <span className="sr-only">Адрес отчёта для владельца</span>
            <input ref={urlInput} className="orc-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </label>
          <div className="wrap" style={{ gap: 8 }}>
            <button type="button" className="pill" onClick={() => void copy()}>
              Скопировать ссылку
            </button>
            <a className="pill ghost" href={url} target="_blank" rel="noopener noreferrer">
              Открыть отчёт
            </a>
            {confirmRevoke ? (
              <>
                <button type="button" className="pill ghost" disabled={readOnly || revoke.isPending} onClick={() => revoke.mutate()}>
                  {revoke.isPending ? "Отзываем…" : "Да, отозвать"}
                </button>
                <button type="button" className="pill ghost" onClick={() => setConfirmRevoke(false)}>
                  Не отзывать
                </button>
              </>
            ) : (
              <button type="button" className="pill ghost" disabled={readOnly} onClick={() => setConfirmRevoke(true)}>
                Отозвать ссылку
              </button>
            )}
          </div>
          <p className="orc-meta">
            {link.viewsCount > 0
              ? `Открывали ${link.viewsCount} ${pluralizeRu(link.viewsCount, ["раз", "раза", "раз"])} (включая ваши открытия; не чаще раза в минуту)${
                  link.lastViewedAt ? `, последний раз ${reportDateTime(link.lastViewedAt)}` : ""
                }.`
              : "Пока не открывали."}
          </p>
          {confirmRevoke && (
            <p className="orc-meta" role="status">
              После отзыва старая ссылка перестанет открываться, а новая появится только по кнопке «Создать ссылку».
            </p>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <button type="button" className="pill" disabled={readOnly || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Создаём…" : "Создать ссылку"}
          </button>
        </div>
      )}
    </section>
  );
}
