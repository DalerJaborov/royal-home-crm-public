import { useState } from "react";
import type { RecruitmentPosition } from "@royal-home/shared";
import { useCreateVacancy } from "../hooks/useVacancies";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { MutationError } from "./MutationError";
import { candidateCreateBody, duplicateCandidateId, EMPTY_CANDIDATE_DRAFT, type CandidateDraft } from "../lib/vacancyQueue";

/** «+ Кандидат»: ручное добавление (звонок, рекомендация, пришёл в офис). */
export function VacancyCreateSheet({ positions, defaultPositionKey, onClose, onCreated, onOpenExisting }: {
  positions: RecruitmentPosition[] | undefined; defaultPositionKey?: string;
  onClose(): void; onCreated(id: string): void;
  /** Открыть уже существующую анкету: экран ищет её по телефону из формы. */
  onOpenExisting(id: string, phone: string): void;
}) {
  const create = useCreateVacancy();
  const [draft, setDraft] = useState<CandidateDraft>({ ...EMPTY_CANDIDATE_DRAFT,
    positionKey: positions?.some(position => position.key === defaultPositionKey) ? defaultPositionKey ?? "" : "" });
  const [formError, setFormError] = useState("");
  const existingId = duplicateCandidateId(create.error);
  const busy = create.isPending;
  const set = (key: keyof CandidateDraft) => (event: { target: { value: string } }) => setDraft(value => ({ ...value, [key]: event.target.value }));
  return <Rh2Sheet title="Новый кандидат" onClose={onClose} dismissible={!busy} closeOnBackdrop={false} className="vacancy-contact-sheet"
    onSubmit={event => {
      event.preventDefault();
      const result = candidateCreateBody(draft);
      if ("error" in result) { setFormError(result.error); return; }
      setFormError("");
      create.mutate(result.body, { onSuccess: created => onCreated(created.id) });
    }}
    footer={<div className="vacancy-contact-scope vacancy-form-buttons"><button type="button" className="vacancy-button secondary" disabled={busy} onClick={onClose}>Отмена</button>
      <button type="submit" className="vacancy-button" disabled={busy}>{busy ? "Сохраняем…" : "Добавить кандидата"}</button></div>}>
    <div className="vacancy-contact-scope">
      <p className="vacancy-muted">Анкета появится в ленте со статусом «Новый отклик». Кандидату ничего не отправляется.</p>
      <label className="vacancy-field"><span>Имя и фамилия *</span><input value={draft.name} onChange={set("name")} maxLength={120} required autoComplete="off" /></label>
      <label className="vacancy-field"><span>Вакансия *</span><select value={draft.positionKey} onChange={set("positionKey")} required>
        <option value="">Выберите вакансию</option>
        {positions?.map(position => <option key={position.key} value={position.key}>{position.titleRu}{position.isOpen ? "" : " · набор закрыт"}</option>)}
      </select></label>
      <div className="vacancy-form-grid">
        <label className="vacancy-field"><span>Телефон</span><input type="tel" value={draft.phone} onChange={set("phone")} maxLength={40} autoComplete="off" /></label>
        <label className="vacancy-field"><span>Город</span><input value={draft.city} onChange={set("city")} maxLength={80} /></label>
        <label className="vacancy-field"><span>Возраст</span><input inputMode="numeric" value={draft.age} onChange={set("age")} maxLength={3} /></label>
      </div>
      <label className="vacancy-field"><span>Опыт</span><textarea rows={3} value={draft.experience} onChange={set("experience")} maxLength={2000} /></label>
      <label className="vacancy-field"><span>Заметка</span><textarea rows={3} value={draft.note} onChange={set("note")} maxLength={4000} /><small>Видно только сотрудникам.</small></label>
      {formError && <p className="vacancy-form-error" role="alert">{formError}</p>}
      {existingId ? <div className="vacancy-notice" role="alert"><p>Такой кандидат уже есть.</p>
        <button type="button" className="vacancy-text-button" onClick={() => onOpenExisting(existingId, draft.phone.trim())}>Открыть его анкету</button></div>
        : <MutationError mutation={create} fallback="Не удалось добавить кандидата" />}
    </div>
  </Rh2Sheet>;
}
