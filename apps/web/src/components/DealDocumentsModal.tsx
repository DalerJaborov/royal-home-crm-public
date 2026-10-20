import { useRef, useState } from "react";
import { DEAL_DOCUMENT_KIND_LABELS, DEAL_DOCUMENT_KINDS, type DealDocumentKind } from "@royal-home/shared";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { downloadFromApi } from "../lib/downloadFile";
import { useIsReadOnly } from "../lib/permissions";
import {
  useDealDocuments,
  useDealPayout,
  useDealPayoutStatus,
  useDeleteDealDocument,
  useUploadDealDocument,
} from "../hooks/useDealDocuments";

/**
 * «Документы» сделки + «Выплачено» (Пачка 14, 11.09.2026) — один компонент на ПК
 * и телефон: `Rh2Sheet` уже адаптивна (см. её докстринг), отдельного мобильного
 * файла не заводим (правило CLAUDE.md про Mobile*.tsx только для целых экранов
 * с собственной раскладкой, окно-шторка ведёт себя одинаково на обеих ширинах).
 *
 * `canPayout` решает видимость кнопки «Выплачено» — право проверяется ещё раз на
 * сервере (finance.manage/deals.setCommission), кнопка скрыта заранее, чтобы не
 * обещать действие, которое всё равно отклонят.
 */
export function DealDocumentsModal({
  dealId,
  dealStage,
  canPayout,
  onClose,
}: {
  dealId: string;
  dealStage: string;
  canPayout: boolean;
  onClose: () => void;
}) {
  const readOnly = useIsReadOnly();
  const documents = useDealDocuments(dealId);
  const upload = useUploadDealDocument(dealId);
  const remove = useDeleteDealDocument(dealId);
  const payoutStatus = useDealPayoutStatus(dealId);
  const payout = useDealPayout(dealId);

  const [downloadError, setDownloadError] = useState<string | null>(null);

  /** Отказ обязан быть виден: до 19.09.2026 клик по документу молча открывал
   *  пустую вкладку, и понять, что сервер ответил отказом, было неоткуда. */
  async function openDocument(docId: string, originalName: string) {
    setDownloadError(null);
    try {
      await downloadFromApi(`/deals/${dealId}/documents/${docId}/file`, originalName);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : "Не удалось открыть документ");
    }
  }

  const [kind, setKind] = useState<DealDocumentKind>("OWNERSHIP");
  const [payoutNote, setPayoutNote] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <Rh2Sheet title="Документы сделки" onClose={onClose} dismissible closeOnBackdrop>
      <div className="sec-t">Загруженные документы</div>
      {documents.isLoading && <p className="state">Загрузка…</p>}
      {documents.data?.length === 0 && <p className="state">Пока ничего не загружено.</p>}
      <ul className="list">
        {documents.data?.map((doc) => (
          <li className="row" key={doc.id}>
            {/* Кнопка, а не ссылка: файл документа закрыт правом
                deals.manageDocuments, и обычная ссылка браузера уходит за ним
                без заголовка авторизации — открывалась пустая вкладка
                (поймано 19.09.2026). Забираем через api(), см.
                lib/downloadFile.ts. */}
            <button className="lk" type="button" onClick={() => openDocument(doc.id, doc.originalName)}>
              {DEAL_DOCUMENT_KIND_LABELS[doc.kind]} — {doc.originalName}
            </button>
            <span className="quiet">
              <span className="txt">
                {doc.uploadedByName}, {new Date(doc.uploadedAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" })}
              </span>
            </span>
            {!readOnly && <button
              className="pill ghost sm"
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                // Подтверждение (C5, 02.10.2026): файл стирается с сервера насовсем,
                // а «Удалить» стояло в одно касание рядом с названием документа.
                const label = `${DEAL_DOCUMENT_KIND_LABELS[doc.kind]} — ${doc.originalName}`;
                if (!window.confirm(`Удалить документ «${label}»? Файл будет стёрт насовсем.`)) return;
                remove.mutate(doc.id);
              }}
            >
              Удалить
            </button>}
          </li>
        ))}
      </ul>
      {downloadError && <p className="state">{downloadError}</p>}
      {/* Отказ сервера (документ отправленной/закрытой сделки удаляет только
          руководитель) должен быть виден, а не молча оставлять строку на месте. */}
      {remove.isError && (
        <p className="state">{remove.error instanceof Error ? remove.error.message : "Не удалось удалить документ"}</p>
      )}

      {!readOnly && <><div className="sec-t">Добавить документ</div>
      <label className="fld">
        <span className="lab">Вид документа</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as DealDocumentKind)}>
          {DEAL_DOCUMENT_KINDS.map((k) => (
            <option key={k} value={k}>
              {DEAL_DOCUMENT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="fld">
        <span className="lab">Файл (изображение или PDF)</span>
        <input ref={fileInputRef} type="file" accept="image/*,application/pdf" />
      </label>
      <button
        className="pill"
        type="button"
        disabled={upload.isPending}
        onClick={() => {
          const file = fileInputRef.current?.files?.[0];
          if (!file) return;
          upload.mutate(
            { file, kind },
            {
              onSuccess: () => {
                if (fileInputRef.current) fileInputRef.current.value = "";
              },
            }
          );
        }}
      >
        {upload.isPending ? "Загрузка…" : "Загрузить"}
      </button>
      </>}

      {dealStage === "COMPLETED" && (
        <>
          <div className="sec-t">Комиссия риелтору</div>
          {payoutStatus.data?.realtorPayoutAt ? (
            <p className="state">
              Выплачено {new Date(payoutStatus.data.realtorPayoutAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe" })}
              {payoutStatus.data.realtorPayoutNote ? ` — ${payoutStatus.data.realtorPayoutNote}` : ""}
            </p>
          ) : canPayout && !readOnly ? (
            <>
              <label className="fld">
                <span className="lab">Комментарий (необязательно)</span>
                <input type="text" value={payoutNote} onChange={(e) => setPayoutNote(e.target.value)} placeholder="Например, номер перевода" />
              </label>
              <button
                className="pill"
                type="button"
                disabled={payout.isPending}
                onClick={() => payout.mutate(payoutNote.trim() || undefined)}
              >
                {payout.isPending ? "Отмечаем…" : "Отметить выплаченной"}
              </button>
            </>
          ) : (
            <p className="state">Ждёт выплаты.</p>
          )}
        </>
      )}
    </Rh2Sheet>
  );
}
