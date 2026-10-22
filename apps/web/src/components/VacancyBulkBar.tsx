import { useState } from "react";
import { Printer, Trash2, X } from "lucide-react";
import type { RecruitmentPosition } from "@royal-home/shared";
import type { JobApplication, VacancyBulkInput, VacancyBulkResponse } from "../types/vacancies";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { MutationError } from "./MutationError";
import { bulkResultText } from "../lib/vacancyQueue";

type BulkMutation = {
  isPending: boolean; isError: boolean; error: Error | null; reset(): void;
  mutate(input: VacancyBulkInput, options?: { onSuccess?(result: VacancyBulkResponse): void }): void;
};

/** Плавающая панель массовых действий над выбранными анкетами ленты. */
export function VacancyBulkBar({ selected, positions, mutation, canDelete, readOnly, onClear, onPrint, onDelete }: {
  selected: JobApplication[]; positions: RecruitmentPosition[] | undefined; mutation: BulkMutation;
  canDelete: boolean; readOnly: boolean; onClear(): void; onPrint(): void; onDelete(): void;
}) {
  const [assigning, setAssigning] = useState(false);
  const [positionKey, setPositionKey] = useState("");
  const [result, setResult] = useState<{ text: string; skipped: string[] } | null>(null);
  const ids = selected.map(item => item.id);
  const busy = mutation.isPending;
  function run(input: Omit<VacancyBulkInput, "ids">, after?: () => void) {
    setResult(null);
    mutation.mutate({ ...input, ids }, { onSuccess: response => { setResult(bulkResultText(response, selected)); after?.(); } });
  }
  if (!selected.length && !result) return null;
  return <>
    <div className="vacancy-bulk-bar" role="region" aria-label="Действия с выбранными анкетами">
      {selected.length > 0 ? <>
        <strong className="vacancy-bulk-count">Выбрано: {selected.length}</strong>
        {!readOnly && <>
          <button type="button" className="vacancy-chip" disabled={busy} onClick={() => { setPositionKey(""); mutation.reset(); setAssigning(true); }}>Привязать к вакансии…</button>
          <button type="button" className="vacancy-chip" disabled={busy} onClick={() => run({ action: "setStatus", status: "REVIEWED" })}>В работу</button>
          <button type="button" className="vacancy-chip" disabled={busy} onClick={() => run({ action: "setStatus", status: "REJECTED" })}>Отказ</button>
          <button type="button" className="vacancy-chip" disabled={busy} onClick={() => run({ action: "setStatus", status: "NOT_CANDIDATE" })}>Не кандидат</button>
        </>}
        <button type="button" className="vacancy-chip" disabled={busy} onClick={onPrint}><Printer size={16} aria-hidden="true" />Распечатать</button>
        {canDelete && !readOnly && <button type="button" className="vacancy-chip danger" disabled={busy} onClick={onDelete}><Trash2 size={16} aria-hidden="true" />Удалить навсегда</button>}
        <button type="button" className="vacancy-chip quiet" onClick={() => { setResult(null); onClear(); }} aria-label="Снять выбор"><X size={16} aria-hidden="true" /></button>
      </> : null}
      {busy && <span className="vacancy-bulk-status" role="status">Сохраняем…</span>}
      {result && <div className="vacancy-bulk-result" role="status"><span>{result.text}</span>
        {result.skipped.length > 0 && <details><summary>Почему пропущены</summary><ul>{result.skipped.map(line => <li key={line}>{line}</li>)}</ul></details>}
        <button type="button" className="vacancy-text-button" onClick={() => setResult(null)}>Скрыть</button></div>}
      {!assigning && <MutationError mutation={mutation} fallback="Не удалось выполнить действие" />}
    </div>
    {assigning && <Rh2Sheet title="Привязать к вакансии" onClose={() => setAssigning(false)} dismissible={!busy} closeOnBackdrop={false} className="vacancy-contact-sheet"
      onSubmit={event => { event.preventDefault(); if (positionKey) run({ action: "assignPosition", positionKey }, () => setAssigning(false)); }}
      footer={<div className="vacancy-contact-scope vacancy-form-buttons"><button type="button" className="vacancy-button secondary" disabled={busy} onClick={() => setAssigning(false)}>Отмена</button>
        <button type="submit" className="vacancy-button" disabled={busy || !positionKey}>{busy ? "Сохраняем…" : `Привязать ${selected.length}`}</button></div>}>
      <div className="vacancy-contact-scope">
        <label className="vacancy-field"><span>Вакансия</span><select value={positionKey} required onChange={event => setPositionKey(event.target.value)}>
          <option value="">Выберите вакансию</option>
          {positions?.map(position => <option key={position.key} value={position.key}>{position.titleRu}{position.isOpen ? "" : " · набор закрыт"}</option>)}
        </select></label>
        <p className="vacancy-muted">Анкеты из нового бота сохраняют свою вакансию — сервер пропустит их и покажет в итоге.</p>
        <MutationError mutation={mutation} fallback="Не удалось привязать анкеты" />
      </div>
    </Rh2Sheet>}
  </>;
}
