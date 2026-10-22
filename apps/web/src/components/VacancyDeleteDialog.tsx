import { useState } from "react";
import type { JobApplication } from "../types/vacancies";
import { useBulkVacancies, useDeleteVacancy } from "../hooks/useVacancies";
import { ConfirmDialog } from "./ConfirmDialog";
import { MutationError } from "./MutationError";
import { candidateTitle } from "../lib/vacanciesResume";
import { deleteWordMatches, VACANCY_DELETE_WORD } from "../lib/vacancyQueue";

/** Удаление навсегда: одна анкета — DELETE, несколько — массовым запросом.
 *  Подтверждение — набрать слово, число анкет видно в заголовке. */
export function VacancyDeleteDialog({ items, onClose, onDeleted }: {
  items: JobApplication[]; onClose(): void; onDeleted(ids: string[], skipped: number): void;
}) {
  const single = useDeleteVacancy(), bulk = useBulkVacancies();
  const [word, setWord] = useState("");
  const mutation = items.length === 1 ? single : bulk;
  const busy = mutation.isPending;
  const ids = items.map(item => item.id);
  const title = items.length === 1 ? `Удалить анкету «${candidateTitle(items[0])}» навсегда?` : `Удалить навсегда ${items.length} анкет?`;
  function confirm() {
    if (!deleteWordMatches(word) || busy) return;
    if (items.length === 1) single.mutate(ids[0], { onSuccess: () => onDeleted(ids, 0) });
    else bulk.mutate({ ids, action: "delete" }, { onSuccess: result => {
      const skipped = new Set(result.skipped.map(entry => entry.id));
      onDeleted(ids.filter(id => !skipped.has(id)), skipped.size);
    } });
  }
  return <ConfirmDialog title={title} description="Анкета, заметки, история приглашений и файлы резюме будут удалены без возможности восстановления. Переписка с человеком в «Обращениях» останется. Для обычного отказа используйте «Отказ»."
    confirmLabel={busy ? "Удаляем…" : "Удалить навсегда"} onCancel={onClose} onConfirm={confirm} dismissible={!busy}
    confirmDisabled={busy || !deleteWordMatches(word)}>
    <div className="vacancy-contact-scope">
      <label className="vacancy-field"><span>Чтобы подтвердить, наберите слово {VACANCY_DELETE_WORD}</span>
        <input value={word} onChange={event => setWord(event.target.value)} autoComplete="off" autoFocus aria-describedby="vacancy-delete-count" /></label>
      <p id="vacancy-delete-count" className="vacancy-muted">Будет удалено анкет: {items.length}.</p>
      <MutationError mutation={mutation} fallback="Не удалось удалить. Удалять может только администратор или директор." />
    </div>
  </ConfirmDialog>;
}
