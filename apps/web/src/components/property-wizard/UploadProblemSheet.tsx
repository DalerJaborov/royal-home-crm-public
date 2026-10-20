import { canRetryDraftItem, type DraftMediaItem } from "../../lib/draftUploads";
import { uploadProblemTitle } from "./saveDecision";

/**
 * ОКНО ВЫБОРА, КОГДА ЧАСТЬ ФАЙЛОВ НЕ ДОЕХАЛА (07.10.2026, владелец: «чтобы он
 * видел процесс, а не просто что-то идёт в фоне»). Показывается при «Сохранить»,
 * если ничего уже не едет, а часть файлов упала или потеряна. Молчаливого
 * создания объекта без файлов больше нет: «Сохранить без них» — только явным
 * нажатием и с текстом о последствиях.
 *
 * Облик — шторка мастера (`.sheet`/`.panel`/`.pick2` из theme-2026-wizard.css),
 * та же, что у выбора режима «на сайт / только своим».
 */
export function UploadProblemSheet({
  problems,
  timedOut,
  onRetry,
  onGoToFiles,
  onRemove,
  onSaveWithout,
}: {
  /** Упавшие и потерянные плитки (из useDraftMedia). */
  problems: DraftMediaItem[];
  /** Ждали полчаса и файлы всё ещё едут — объект не создавали. */
  timedOut: boolean;
  onRetry: () => void;
  onGoToFiles: () => void;
  onRemove: () => void;
  onSaveWithout: () => void;
}) {
  const retryable = problems.filter(canRetryDraftItem).length;
  const title = uploadProblemTitle(problems.length, timedOut);
  const shown = problems.slice(0, 4);

  return (
    <div className="sheet" data-open="1" role="alertdialog" aria-modal="true" aria-label={title} data-testid="wizard-upload-problem">
      <div className="scrim" />
      <div className="panel">
        <h4>{title}</h4>
        {timedOut && problems.length === 0 ? (
          <div style={{ fontSize: 14, color: "var(--muted)", lineHeight: 1.45 }}>
            Файлы ещё не доехали — связь медленная. Объект не создан: подождите или сохраните позже, файлы не пропадут.
          </div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
            {shown.map((p) => (
              <li key={p.uploadKey} style={{ fontSize: 14, lineHeight: 1.4 }}>
                <b style={{ fontWeight: 600 }}>{p.name}</b>
                <span style={{ display: "block", fontSize: 13, color: "var(--muted)" }}>{p.error ?? "Не загрузился"}</span>
              </li>
            ))}
            {problems.length > shown.length && (
              <li style={{ fontSize: 13, color: "var(--muted)" }}>и ещё {problems.length - shown.length}</li>
            )}
          </ul>
        )}

        {retryable > 0 && (
          <button type="button" className="pick2" data-testid="wizard-upload-problem-retry" onClick={onRetry}>
            <span>
              <b>Повторить</b>
              <Hint>Отправить упавшие файлы ещё раз и дождаться их</Hint>
            </span>
          </button>
        )}
        {retryable < problems.length && (
          <button type="button" className="pick2" data-testid="wizard-upload-problem-files" onClick={onGoToFiles}>
            <span>
              <b>К файлам</b>
              <Hint>Выбрать потерянный файл заново или заменить тот, что не принял сервер</Hint>
            </span>
          </button>
        )}
        {problems.length > 0 && (
          <button type="button" className="pick2" data-testid="wizard-upload-problem-remove" onClick={onRemove}>
            <span>
              <b>Убрать</b>
              <Hint>Убрать эти файлы из мастера и остаться на проверке</Hint>
            </span>
          </button>
        )}
        <button type="button" className="pick2" data-testid="wizard-upload-problem-skip" onClick={onSaveWithout}>
          <span>
            <b>Сохранить без них</b>
            <Hint>Объект создастся сейчас, эти файлы в карточку НЕ попадут</Hint>
          </span>
        </button>
      </div>
    </div>
  );
}

function Hint({ children }: { children: string }) {
  return (
    <span style={{ display: "block", fontSize: 13, color: "var(--muted)", lineHeight: 1.42, marginTop: 2 }}>{children}</span>
  );
}
