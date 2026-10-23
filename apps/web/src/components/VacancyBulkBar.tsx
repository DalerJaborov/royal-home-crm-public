import { useState } from "react";
import type { RecruitmentPosition } from "@royal-home/shared";
import type { JobApplication, VacancyBulkInput, VacancyBulkResponse } from "../types/vacancies";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { MutationError } from "./MutationError";
import { bulkResultText } from "../lib/vacancyQueue";

type BulkMutation = {
  isPending: boolean; isError: boolean; error: Error | null; reset(): void;
  mutate(input: VacancyBulkInput, options?: { onSuccess?(result: VacancyBulkResponse): void }): void;
};

/** Панель массовых действий над выбранными анкетами — `.bulk` темы, как у Объектов. */
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
    {selected.length > 0 && <div className="bulk" role="region" aria-label="Действия с выбранными анкетами" style={{ marginTop: 16 }}>
      <span className="cnt">Выбрано {selected.length}</span>
      {!readOnly && <>
        <button type="button" className="pill sm" disabled={busy} onClick={() => run({ action: "setStatus", status: "REVIEWED" })}>В работу</button>
        <button type="button" className="pill ghost sm" disabled={busy} onClick={() => { setPositionKey(""); mutation.reset(); setAssigning(true); }}>Привязать к вакансии</button>
        <button type="button" className="pill ghost sm" disabled={busy} onClick={() => run({ action: "setStatus", status: "REJECTED" })}>Отказ</button>
        <button type="button" className="pill ghost sm" disabled={busy} onClick={() => run({ action: "setStatus", status: "NOT_CANDIDATE" })}>Не кандидат</button>
      </>}
      <button type="button" className="pill ghost sm" disabled={busy} onClick={onPrint}>Распечатать</button>
      {canDelete && !readOnly && <button type="button" className="pill ghost sm" disabled={busy} onClick={onDelete}>Удалить навсегда</button>}
      <span className="spacer" />
      {busy && <span role="status">Сохраняем…</span>}
      <button type="button" className="lnk" onClick={() => { setResult(null); onClear(); }}>Снять выбор</button>
    </div>}
    {result && <div className="quiet" role="status">
      <span className="dot ok" />
      <span className="txt">{result.text}
        {result.skipped.length > 0 && <details><summary>Почему пропущены</summary><ul>{result.skipped.map(line => <li key={line}>{line}</li>)}</ul></details>}
      </span>
      <button type="button" className="lnk" onClick={() => setResult(null)}>Скрыть</button>
    </div>}
    {!assigning && <MutationError mutation={mutation} fallback="Не удалось выполнить действие" />}
    {assigning && <Rh2Sheet title="Привязать к вакансии" onClose={() => setAssigning(false)} dismissible={!busy} closeOnBackdrop={false}
      onSubmit={event => { event.preventDefault(); if (positionKey) run({ action: "assignPosition", positionKey }, () => setAssigning(false)); }}
      footer={<><button type="button" className="pill ghost" disabled={busy} onClick={() => setAssigning(false)}>Отмена</button>
        <button type="submit" className="pill" disabled={busy || !positionKey}>{busy ? "Сохраняем…" : `Привязать ${selected.length}`}</button></>}>
      <label className="fld"><span className="lab">Вакансия</span><select value={positionKey} required onChange={event => setPositionKey(event.target.value)}>
        <option value="">Выберите вакансию</option>
        {positions?.map(position => <option key={position.key} value={position.key}>{position.titleRu}{position.isOpen ? "" : " · набор закрыт"}</option>)}
      </select><span className="msg">Анкеты из нового бота сохраняют свою вакансию — сервер пропустит их и покажет в итоге.</span></label>
      <MutationError mutation={mutation} fallback="Не удалось привязать анкеты" />
    </Rh2Sheet>}
  </>;
}
