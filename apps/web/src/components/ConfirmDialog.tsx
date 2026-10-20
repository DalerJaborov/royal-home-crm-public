import type { ReactNode } from "react";
import { Rh2Sheet } from "./rh2/Rh2Sheet";
import { Button } from "./rh2/Button";

/**
 * Общий диалог подтверждения для опасных/массовых действий (удаление,
 * массовая публикация и т.п.) — ничего необратимое или затрагивающее много
 * записей разом не должно происходить по одному клику без явного "да".
 *
 * ОБЛИК — эталон «Royal Home 2026»: шторка `.sheet` (справа на компьютере,
 * снизу на телефоне), объяснение тихой строкой `.state`, кнопки `.pill` в
 * подвале `.sheet-f`. Договор дизайна §6.9 разрешает модальное окно только у
 * шага подтверждения личности, но это окно не «решение одной кнопкой» в строке,
 * а последний вопрос перед необратимым действием — у него та же роль, что у
 * step-up, и та же подача.
 *
 * ПОЧЕМУ ОБЛИК ПРИШЁЛ, А ПОВЕДЕНИЕ НЕ МЕНЯЛОСЬ. Диалог вызывается примерно из
 * 35 мест, половина из которых на ещё не перенесённых экранах. Область темы
 * `.rh2` открывается в корне портала (`Rh2Sheet` → `Rh2Portal`), поэтому облик
 * не зависит от экрана-хозяина, а порядок кнопок, ловушка фокуса, Esc, блокировка
 * прокрутки фона и `confirmDisabled` остались ровно теми же.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel = "Подтвердить",
  cancelLabel = "Отмена",
  danger = true,
  onConfirm,
  onCancel,
  children,
  confirmDisabled,
  confirmHint,
  layer,
  dismissible = true,
}: {
  title: string;
  description: string;
  confirmLabel?: string;
  /** Подпись кнопки отказа — когда «Отмена» неточна: вопрос «да/нет», где
   *  отказ — тоже действие («Нет, оставить мои»). */
  cancelLabel?: string;
  /** Необратимое действие: подпись и текст объяснения красные (`.state.err`). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Доп. поля внутри диалога — например, обязательная причина отмены показа. */
  children?: ReactNode;
  /** Запретить подтверждение, пока доп. поле (см. children) не заполнено. */
  confirmDisabled?: boolean;
  /**
   * Одна строка рядом с выключенной кнопкой: чего именно не хватает, чтобы
   * подтвердить. Серая кнопка без слов читается как поломка (владелец
   * 24.09.2026, «Вернуть монтажёру»: файл загружен, кнопка мёртвая, почему —
   * неизвестно). `aria-live` — диктор объявляет смену подсказки без перехода
   * фокуса. Не показывать, когда кнопка активна: пустая строка тоже шум.
   */
  confirmHint?: ReactNode;
  /** См. Rh2Sheet: поднять диалог над полноэкранным окном входящего лида
   *  (`above-incoming`) или над мобильным чатом (`above-chat`). */
  layer?: "above-incoming" | "above-chat";
  /**
   * По умолчанию окно закрывается как обычно (Esc, подложка, «Закрыть» в
   * шапке, «Отмена» в подвале). `false` — пока внутри идёт незавершаемая
   * работа (загрузка исходника, «Вернуть монтажёру» 24.09.2026): все четыре
   * пути закрытия выключаются сразу — проброс `dismissible` в `Rh2Sheet`
   * убирает Esc/подложку/«Закрыть», здесь же гасим и кнопку «Отмена», иначе
   * человек терял загруженный файл одним лишним кликом.
   */
  dismissible?: boolean;
}) {
  return (
    <Rh2Sheet
      open
      onClose={onCancel}
      closeLabel="Закрыть окно подтверждения"
      title={title}
      layer={layer}
      dismissible={dismissible}
      // alertdialog, а не dialog: экранный диктор объявляет вопрос сразу, не
      // дожидаясь, пока человек дойдёт до текста табуляцией.
      role="alertdialog"
      footer={
        <>
          {confirmHint != null && confirmHint !== "" && (
            <p className="state confirm-hint" role="status" aria-live="polite">
              {confirmHint}
            </p>
          )}
          {/* Порядок кнопок прежний: отказ слева, подтверждение справа. */}
          {dismissible === false ? (
            <Button variant="ghost" onClick={onCancel} disabled disabledReason="Идёт операция, закрыть окно пока нельзя">
              {cancelLabel}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onCancel}>
              {cancelLabel}
            </Button>
          )}
          {/* Необратимое действие рисуется контуром crit, обычное синей заливкой. */}
          {confirmDisabled ? (
            <Button
              variant={danger ? "danger" : "primary"}
              onClick={onConfirm}
              disabled
              disabledReason={typeof confirmHint === "string" && confirmHint ? confirmHint : "Заполните обязательные поля"}
            >
              {confirmLabel}
            </Button>
          ) : (
            <Button variant={danger ? "danger" : "primary"} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </>
      }
    >
      {/* Точка `.dot.crit` несёт предупреждение, текст остаётся спокойным:
          красный абзац целиком — это та самая «кричащая карточка», которую
          договор дизайна §6.1 запрещает. Красным подписана кнопка действия и
          точка, объяснение читается как обычный текст. */}
      <p className="state">
        {danger && <span className="dot crit" />}
        {description}
      </p>
      {children}
    </Rh2Sheet>
  );
}
