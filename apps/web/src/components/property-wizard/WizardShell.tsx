import { useEffect, useState, type ReactNode } from "react";
import { WIZARD_STEPS, type WizardStepKey } from "./types";
import type { WizardDraftStatus } from "./draftAutosave";
import { WizardDraftNotice } from "./WizardDraftNotice";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import "../../theme-2026-wizard-desktop.css";

const DESKTOP_SECTIONS: Record<WizardStepKey, { label: string; title: string; next: string }> = {
  seller: { label: "Продавец", title: "Продавец", next: "К фото и видео" },
  media: { label: "Фото и видео", title: "Фото и видео", next: "К параметрам" },
  main: { label: "Параметры", title: "Параметры объекта", next: "К адресу" },
  place: { label: "Адрес", title: "Адрес объекта", next: "Проверить объект" },
  review: { label: "Проверка", title: "Проверьте объект", next: "Создать объект" },
};

/**
 * ОБОЛОЧКА МАСТЕРА — переодета в облик артефакта владельца «Мастер объекта
 * Royal Home» (15.09.2026, docs/pult/theme-2026/artifact-wizard-property-15-09.html).
 * Разметка (`.whead`/`.line1`/`.ttl`/`.sub`/`.mode`/`.xbtn`/`.bars`/`.draft`,
 * `.wbody`, `.wfoot`/`.back`/`.next`) — дословно из артефакта, классы приходят
 * из сгенерированного `theme-2026-wizard.css` (область `.rh2 .wiz`, файл не
 * трогать руками — см. его заголовок). Два предка обязательны: `<div
 * className="rh2"><div className="wiz">` — иначе область не сработает, ровно
 * как `.rh2 .mh` у мобильной главной.
 *
 * Логика — та же, что была: закрытие, шаг назад/вперёд, занятость кнопки,
 * шторка выбора «на сайт / только своим». Дописано ровно то, чего в артефакте
 * нет и не может быть — сама функциональность мастера, а не облик.
 *
 * МАСТЕР НА ВЕСЬ ЭКРАН, БЕЗ ХРОМА CRM (решение владельца 12.09.2026). `/properties/new`
 * зарегистрирован в App.tsx СНАРУЖИ AppLayout (свой `<Route>`, всё ещё под
 * ProtectedRoute), поэтому ни сайдбара, ни Topbar, ни BottomNav в дереве нет —
 * `WizardShell` единственная оболочка экрана. Высота на весь вьюпорт и
 * безопасные зоны — не из артефакта (там демо-рамка телефона фиксированной
 * высоты), это отступление задокументировано в theme-2026-wizard-shell.css.
 *
 * Один контроллер на всех устройствах. На ПК — широкая форма и горизонтальные
 * разделы; телефон сохраняет последовательные шаги и прежние кнопки полей.
 */
export function WizardShell({
  stepIndex,
  onClose,
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  busy,
  busyLabel,
  offSite,
  onOffSiteChange,
  draftSaved,
  draftStatus,
  onRetryDraft,
  onDeleteDraft,
  deleteDraftPending,
  deleteDraftError,
  onSaveAndExit,
  onGoToStep,
  stepStates,
  closeDisabled,
  overlay,
  children,
}: {
  stepIndex: number;
  onClose: () => void;
  /** null — это первый шаг, назад некуда. */
  onBack: (() => void) | null;
  onNext: () => void;
  nextLabel: string;
  nextDisabled?: boolean;
  busy?: boolean;
  /** Чем именно занята кнопка. «Сохраняю…» и «Дожидаюсь файлов…» — разные
   *  ожидания разной длины, и второе без подписи читается как зависание. */
  busyLabel?: string;
  /** Несайтовый объект — «только для своих клиентов» (types.ts). Чип режима
   *  живёт в шапке, а не отдельным полем формы: это состояние, а не вопрос,
   *  и видно на КАЖДОМ шаге, а не только на том, где раньше стояла галочка. */
  offSite: boolean;
  onOffSiteChange: (offSite: boolean) => void;
  /** Черновик реально сохранён на сервере только что — строка «Черновик
   *  сохранён» из артефакта показывается ЧЕСТНО, а не всегда: автосохранение
   *  (useServerAutosave в PropertyWizard.tsx) уже есть, здесь только его факт. */
  draftSaved?: boolean;
  draftStatus?: WizardDraftStatus;
  onRetryDraft?: () => void;
  onDeleteDraft?: () => void;
  deleteDraftPending?: boolean;
  deleteDraftError?: string | null;
  onSaveAndExit?: () => void;
  /** The controller validates and saves; this shell only requests navigation. */
  onGoToStep?: (index: number) => void;
  stepStates?: Partial<Record<WizardStepKey, "complete" | "invalid" | "empty">>;
  /** Крестик не работает, пока идёт сохранение или ожидание файлов (07.10.2026):
   *  закрыть мастер на середине — это и есть «ушёл, а ролик не доехал».
   *  «Назад»/«Отменить» блокируются через `busy` отдельно. */
  closeDisabled?: boolean;
  /** Окно поверх всего мастера: выбор при неудачных файлах, финальный экран загрузки. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const step = WIZARD_STEPS[stepIndex];
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useFocusTrap<HTMLDivElement>(modeOpen);
  const controlsBusy = busy || deleteDraftPending;
  const status = draftStatus ?? (draftSaved ? { state: "server" as const } : undefined);
  useEffect(() => {
    if (!modeOpen) return;
    modeRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [modeOpen, modeRef]);

  return (
    <div className="rh2">
      <div className="wiz wizard-workspace" data-step-key={step.key}>
        <div className="whead">
          <div className="line1">
            <div className="wizard-header-title" aria-live="polite" style={{ minWidth: 0 }}>
              {/* Название шага — заголовок экрана мастера. role/aria-level вместо
                  <h1>: класс `.ttl` описан в эталоне темы для div, смена тега
                  утащила бы кегль и отступы. До 19.09.2026 у мастера не было
                  заголовка вовсе — ни для читалки экрана, ни для проверок. */}
              <div className="ttl" role="heading" aria-level={1}>
                <span className="wizard-desktop-title">Новый объект</span>
                <span className="wizard-mobile-title">{step.title}</span>
              </div>
              <div className="sub">
                Шаг {stepIndex + 1} из {WIZARD_STEPS.length}
              </div>
            </div>
            <button
              type="button"
              className="xbtn"
              onClick={onClose}
              disabled={closeDisabled || deleteDraftPending}
              aria-label="Закрыть мастер"
              aria-disabled={closeDisabled || deleteDraftPending || undefined}
              data-testid="wizard-close"
              style={closeDisabled ? { opacity: 0.4, cursor: "not-allowed" } : undefined}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Чип режима «на сайт / только своим» — тихое СОСТОЯНИЕ, а не поле
              формы: видно на КАЖДОМ шаге. Нажатие открывает шторку с двумя
              вариантами и последствиями каждого — см. ниже. */}
          <div className="wizard-toolbar">
          <button
            type="button"
            className={offSite ? "mode priv" : "mode"}
            aria-haspopup="dialog"
            aria-label="Куда пойдёт объект — изменить"
            data-testid="wizard-mode-chip"
            onClick={() => setModeOpen(true)}
            disabled={controlsBusy}
          >
            <span className="sd" aria-hidden />
            <span>{offSite ? "Только для своих клиентов" : "Пойдёт на сайт"}</span>
            <span className="ch">· изменить</span>
          </button>
          <div className="wizard-draft-actions wizard-header-actions">
            {onSaveAndExit && <button type="button" className="wizard-secondary-action" data-testid="wizard-save-exit"
              onClick={onSaveAndExit} disabled={controlsBusy || closeDisabled || status?.state === "saving"}>Сохранить и выйти</button>}
            {onDeleteDraft && <button type="button" className="wizard-text-action wizard-delete-action" data-testid="wizard-delete-draft"
              onClick={onDeleteDraft} disabled={controlsBusy}>{deleteDraftPending ? "Удаляю черновик…" : "Удалить черновик"}</button>}
          </div>
          </div>

          <div
            className="bars"
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={WIZARD_STEPS.length}
            aria-valuenow={stepIndex + 1}
            aria-label={`Шаг ${stepIndex + 1} из ${WIZARD_STEPS.length}: ${step.title}`}
          >
            {WIZARD_STEPS.map((s, i) => (
              <i key={s.key} className={i < stepIndex ? "done" : i === stepIndex ? "now" : ""} />
            ))}
          </div>

          <WizardDraftNotice status={status} onRetry={onRetryDraft} disabled={controlsBusy} />
          {deleteDraftError && <p className="wizard-delete-error" role="alert" data-testid="wizard-delete-error">{deleteDraftError} Можно повторить удаление.</p>}
        </div>

        <nav className="wizard-steps" aria-label="Разделы объекта">
          <ol>{WIZARD_STEPS.map((item, index) => {
            const state = stepStates?.[item.key] ?? "empty";
            const label = DESKTOP_SECTIONS[item.key].label;
            const content = <><span className="wizard-step-number" aria-hidden="true">{state === "complete" ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10" /></svg> : index + 1}</span><span className="wizard-step-copy"><span>{label}</span>{state === "invalid" && <small>Нужно проверить</small>}</span></>;
            return <li key={item.key} data-step-state={state}>
              {onGoToStep ? <button type="button" className="wizard-step-link" data-testid={`wizard-step-${item.key}`}
                aria-current={index === stepIndex ? "step" : undefined} aria-label={`${label}${state === "complete" ? ", заполнено" : state === "invalid" ? ", нужно проверить" : ""}`} disabled={controlsBusy} onClick={() => onGoToStep(index)}>{content}</button>
                : <span className="wizard-step-link" aria-current={index === stepIndex ? "step" : undefined}>{content}</span>}
            </li>;
          })}</ol>
        </nav>

        <section className="wizard-main" aria-labelledby="wizard-current-section">
          <div className="wizard-form-sheet">
          <h2 className="wizard-step-title" id="wizard-current-section">{DESKTOP_SECTIONS[step.key].title}</h2>
          <div className="wbody">{children}</div>
          </div>
        </section>

        <div className="wfoot">
          {onBack ? (
            <button type="button" className="back" data-testid="wizard-back" onClick={onBack} disabled={controlsBusy}>
              Назад
            </button>
          ) : (
            <button type="button" className="back" data-testid="wizard-cancel" onClick={onClose} disabled={controlsBusy || closeDisabled}>
              Закрыть
            </button>
          )}
          <button
            type="button"
            className="next"
            data-testid="wizard-next"
            onClick={onNext}
            disabled={nextDisabled || controlsBusy}
          >
            {busy ? (busyLabel ?? "Сохраняю…") : <><span className="wizard-mobile-next-label">{nextLabel}</span><span className="wizard-desktop-next-label">{DESKTOP_SECTIONS[step.key].next}</span></>}
          </button>
        </div>

        {overlay}

        {modeOpen && (
          <div className="sheet wizard-mode-dialog" data-open="1" role="dialog" aria-modal="true" aria-label="Куда пойдёт объект"
            onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setModeOpen(false); } }}>
            <div className="scrim" data-testid="wizard-mode-scrim" onClick={() => setModeOpen(false)} />
            <div ref={modeRef} className="panel" role="radiogroup" aria-label="Куда пойдёт объект" data-testid="wizard-mode-sheet">
              <h4>Куда пойдёт объект</h4>
              <ModeOption
                active={!offSite}
                testId="wizard-mode-site"
                title="На сайт, обычным путём"
                text="Проверка маркетингом, фото и видео-обзор от монтажёра, публикация на сайте — так заводится большинство объектов."
                onClick={() => {
                  onOffSiteChange(false);
                  setModeOpen(false);
                }}
              />
              {/* Текст — дословно из старой формы (PropertyFormModal.tsx, чекбокс
                  offSite): владелец его уже выверил, второй раз придумывать не за чем. */}
              <ModeOption
                active={offSite}
                testId="wizard-mode-private"
                title="Только для показа своим клиентам"
                text="Объект нашли сами (сосед, знакомый): сразу «В продаже», без проверки фото/видео и без конвейера Маркетинга. На сайт не попадёт никогда, карта и ссылка на Instagram не нужны; клиенту можно будет отправить только персональную ссылку."
                onClick={() => {
                  onOffSiteChange(true);
                  setModeOpen(false);
                }}
              />
              <button type="button" className="ghost" onClick={() => setModeOpen(false)} data-testid="wizard-mode-close">
                Закрыть
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Строка выбора в шторке режима — радиокнопка со своим описанием последствий. */
function ModeOption({
  active,
  title,
  text,
  onClick,
  testId,
}: {
  active: boolean;
  title: string;
  text: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button type="button" role="radio" aria-checked={active} data-testid={testId} onClick={onClick} className="pick2">
      <span className="mk" aria-hidden />
      <span>
        <b>{title}</b>
        <span style={{ display: "block", fontSize: 13, color: "var(--muted)", lineHeight: 1.42, marginTop: 2 }}>
          {text}
        </span>
      </span>
    </button>
  );
}
