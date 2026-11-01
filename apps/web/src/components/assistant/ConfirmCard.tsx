import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { AssistantActionView } from "@royal-home/shared";
import {
  requestAssistantActionCancel,
  requestAssistantActionConfirm,
  requestAssistantActionUndo,
} from "../../lib/assistantStream";
import {
  ConfirmCardController,
  type ConfirmCardClient,
  type ConfirmCardState,
  type ConfirmPhase,
} from "./confirmCardModel";
import { previewRows } from "./previewRows";
import { Button } from "../rh2/Button";

/**
 * КАРТОЧКА ПОДТВЕРЖДЕНИЯ ДЕЙСТВИЯ ПОМОЩНИКА (SSE-событие `confirm`, П4а).
 * Замысел — docs/design/internal-assistant-architecture-2026-10-31.md §4 п. 4:
 * заголовок, «Было / Станет» с подсветкой изменённого, строка последствий,
 * «Подтвердить» (синяя) и «Отмена»; необратимое — красная плашка и второе
 * нажатие «Да, безвозвратно»; после исполнения — «Сделано · Отменить».
 *
 * Идиома «Royal Home 2026»: `.card`, `.chip`, `.pill`, `.pill.ghost`, цвета —
 * токены темы (`--ok`, `--crit`, `--accent-soft`), ничего мельче 13px. Один
 * компонент на телефон и ПК: `layout="rows"` (телефон, поле за полем строками)
 * и `layout="columns"` (ПК, две колонки). Логика состояний — в
 * confirmCardModel.ts, здесь только вид. Всё из превью выводится ТЕКСТОМ.
 */

export type ConfirmCardLayout = "columns" | "rows";

const defaultClient: ConfirmCardClient = {
  confirm: requestAssistantActionConfirm,
  cancel: requestAssistantActionCancel,
  undo: requestAssistantActionUndo,
};

export function createConfirmCardController(action: AssistantActionView, client: ConfirmCardClient = defaultClient) {
  return new ConfirmCardController(action, client);
}

export function ConfirmCard({
  action,
  layout,
  controller: external,
}: {
  action: AssistantActionView;
  layout: ConfirmCardLayout;
  /**
   * Контроллер снаружи — панель держит их по id действия, чтобы карточка,
   * переехавшая из «текущего хода» в готовую реплику (другое место в дереве,
   * React монтирует заново), не забыла, что её уже подтвердили.
   */
  controller?: ConfirmCardController;
}) {
  const [controller] = useState(() => external ?? createConfirmCardController(action));
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  return (
    <ConfirmCardView
      state={state}
      layout={layout}
      onConfirm={() => void controller.confirm()}
      onCancel={() => void controller.cancel()}
      onUndo={() => void controller.undo()}
    />
  );
}

const STATUS_TEXT: Record<ConfirmPhase, string | null> = {
  pending: null,
  arming: "Это действие нельзя будет отменить. Точно выполнить?",
  running: "Выполняю…",
  cancelling: "Отменяю…",
  done: "Сделано",
  undoing: "Возвращаю как было…",
  cancelled: "Отменено",
  undone: "Отменено — вернули как было",
  expired: "Время вышло — попросите заново",
  failed: "Не выполнено",
};

const TONE_STYLE: Record<"ok" | "warn" | "crit" | "plain", CSSProperties> = {
  ok: { background: "var(--ok-bg)", color: "var(--ok)" },
  warn: { background: "var(--warn-bg)", color: "var(--warn)" },
  crit: { background: "var(--crit-bg)", color: "var(--crit)" },
  plain: { background: "var(--soft)", color: "var(--body)" },
};

function toneOf(state: ConfirmCardState): keyof typeof TONE_STYLE {
  if (state.notice) return state.notice.tone === "ok" && state.phase !== "done" ? "plain" : state.notice.tone;
  if (state.phase === "done") return "ok";
  if (state.phase === "arming") return "crit";
  if (state.phase === "expired" || state.phase === "cancelled" || state.phase === "undone") return "warn";
  if (state.phase === "failed") return "crit";
  return "plain";
}

const BTN: CSSProperties = { minHeight: 44, flex: "1 1 auto" };
/** Пустая строка состояния остаётся в разметке (живая область объявит первую смену), но места не занимает. */
const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};
const muted: CSSProperties = { color: "var(--muted)", fontSize: 13 };

export function ConfirmCardView({
  state,
  layout,
  onConfirm,
  onCancel,
  onUndo,
}: {
  state: ConfirmCardState;
  layout: ConfirmCardLayout;
  onConfirm: () => void;
  onCancel: () => void;
  onUndo: () => void;
}) {
  const { action, phase, notice, canUndo } = state;
  const { preview } = action;
  const irreversible = preview.irreversible === true;
  const busy = ConfirmCardController.isBusy(phase);
  const rows = previewRows(preview);
  const statusText = notice?.text ?? STATUS_TEXT[phase];
  const showDecision = phase === "pending" || phase === "arming" || phase === "running" || phase === "cancelling";

  // ФОКУС НЕ ТЕРЯЕТСЯ: нажатая кнопка исчезает (подтвердил — на её месте «Сделано»),
  // и без этого фокус падал бы на <body>, а клавиатура и диктор — в начало страницы.
  // После нажатия внутри карточки фокус переходит на первую живую кнопку, а если
  // кнопок нет — на строку состояния (tabIndex −1).
  const rootRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const pressedRef = useRef(false);
  useEffect(() => {
    if (!pressedRef.current) return;
    const root = rootRef.current;
    if (!root) return;
    const active = document.activeElement;
    if (active instanceof HTMLButtonElement && root.contains(active) && !active.disabled) return;
    const next = root.querySelector<HTMLButtonElement>("button:not([disabled])");
    (next ?? statusRef.current)?.focus();
  }, [phase, canUndo]);
  const press = (fn: () => void) => () => {
    pressedRef.current = true;
    fn();
  };

  const isPhone = layout === "rows";

  return (
    <section
      ref={rootRef}
      className="card"
      aria-label={`Действие помощника: ${preview.title}`}
      data-assistant-confirm={phase}
      style={{ position: "relative", display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", alignSelf: "stretch" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <b style={{ fontSize: 15 }}>{preview.title}</b>
        {irreversible && (
          <span className="chip crit" style={{ flex: "0 0 auto" }}>
            Необратимо
          </span>
        )}
      </div>

      {irreversible && (phase === "pending" || phase === "arming") && (
        <p role="note" style={{ ...TONE_STYLE.crit, margin: 0, padding: "8px 12px", borderRadius: "var(--r-sm)", fontSize: 13 }}>
          Необратимо: после выполнения кнопки «Отменить» не будет.
        </p>
      )}

      {rows.length > 0 &&
        (isPhone ? (
          <dl style={{ display: "flex", flexDirection: "column", gap: 8, margin: 0 }}>
            {rows.map((row) => (
              <div key={row.key} data-changed={row.changed || undefined} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <dt style={muted}>{row.label}</dt>
                {row.changed ? (
                  <>
                    <dd style={{ margin: 0, ...muted }}>
                      Было: <span style={{ textDecoration: "line-through" }}>{row.was}</span>
                    </dd>
                    <dd style={{ margin: 0 }}>
                      Станет: <mark style={changedMark}>{row.becomes}</mark>
                    </dd>
                  </>
                ) : (
                  <dd style={{ margin: 0 }}>{row.was}</dd>
                )}
              </div>
            ))}
          </dl>
        ) : (
          <div role="table" aria-label="Было и станет" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", columnGap: 12, rowGap: 4 }}>
            <div role="row" style={{ display: "contents" }}>
              <span role="columnheader" style={muted}>
                Было
              </span>
              <span role="columnheader" style={muted}>
                Станет
              </span>
            </div>
            {rows.map((row) => (
              <div role="row" key={row.key} data-changed={row.changed || undefined} style={{ display: "contents" }}>
                <span role="rowheader" style={{ ...muted, gridColumn: "1 / -1", marginTop: 6 }}>
                  {row.label}
                </span>
                <span role="cell" style={row.changed ? { ...muted, textDecoration: "line-through" } : undefined}>
                  {row.was}
                </span>
                <span role="cell">{row.changed ? <mark style={changedMark}>{row.becomes}</mark> : row.becomes}</span>
              </div>
            ))}
          </div>
        ))}

      {preview.risk && (
        <p className="quiet" style={{ margin: 0, fontSize: 13 }}>
          {preview.risk}
        </p>
      )}

      <p
        ref={statusRef}
        tabIndex={-1}
        aria-live="polite"
        role="status"
        style={
          statusText
            ? { ...TONE_STYLE[toneOf(state)], margin: 0, padding: "8px 12px", borderRadius: "var(--r-sm)", fontSize: 14, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }
            : SR_ONLY
        }
      >
        {statusText}
        {phase === "done" && canUndo && (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" className="lk" onClick={press(onUndo)} style={{ minHeight: 44, fontWeight: 600 }}>
              Отменить
            </button>
          </>
        )}
      </p>

      {showDecision && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {/* Общая кнопка дизайн-системы (rh2/Button): «Подтвердить» — основная
              синяя, «Да, безвозвратно» — опасная (контур --crit). Пока идёт запрос,
              обе заблокированы (`loading` = disabled + aria-busy). */}
          {phase === "arming" ? (
            <Button key="confirm-arming" variant="danger" onClick={press(onConfirm)} style={BTN}>
              Да, безвозвратно
            </Button>
          ) : (
            <Button key="confirm-first" variant="primary" loading={busy} onClick={press(onConfirm)} style={BTN}>
              {phase === "running" ? "Выполняю…" : "Подтвердить"}
            </Button>
          )}
          <Button key={phase === "arming" ? "back" : "cancel"} variant="ghost" loading={busy} onClick={press(onCancel)} style={BTN}>
            {phase === "arming" ? "Назад" : "Отмена"}
          </Button>
        </div>
      )}
    </section>
  );
}

const changedMark: CSSProperties = {
  background: "var(--accent-soft)",
  color: "var(--ink)",
  fontWeight: 600,
  borderRadius: 6,
  padding: "0 4px",
};
