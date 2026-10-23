import { useEffect, useState } from "react";
import type { PultTone } from "@royal-home/shared";
import { useUndoToast } from "../../hooks/useUndoToast";
import { ApiError } from "../../lib/api";
import { dushanbeTime } from "../../lib/date";
import { Button, LinkButton } from "../rh2/Button";
import { Card } from "../rh2/Card";
import { List, Row } from "../rh2/Row";

/** Пастельный аватар строки решения (`Row` набора принимает те же тона). */
export interface ActionRowAvatar {
  label: string;
  tone: "lime" | "aqua" | "lav" | "pink" | "sky";
}

export interface ActionRowAction {
  label: string;
  /** REST-эндпоинт решения — виден в DOM (`data-endpoint`) для e2e/аудита. */
  endpoint: string;
  /** Выполняет запрос и возвращает true при успехе. Строка сама не знает про fetch/react-query. */
  onRun: (choiceId?: string) => Promise<boolean>;
  /** Второй клик в «чистом» пульте: подпись кнопки «Точно одобрить?», сброс через 10 с. */
  confirm?: string;
  /** Обратный вызов отмены — если не передан, кнопки «Отменить» не будет (правило §3: не у каждого решения есть undo). */
  onUndo?: () => Promise<void>;
  /** Текст итога после нажатия, например «Одобрено». Функция читается ПОСЛЕ запроса (массовое решение знает итог только тогда). */
  doneMessage: string | (() => string);
  /** Вторичная кнопка (не главная): тот же запрос, но без синей заливки. */
  secondary?: boolean;
}

/** Решение, у которого нет запроса: кнопка просто ведёт в раздел (вопрос ИИ → «Ответить»). */
export interface ActionRowLink {
  label: string;
  href: string;
}

/**
 * Строка решения пульта: `Row` набора. Одно решение = одна строка = одна синяя
 * кнопка (контракт 06.10). После нажатия кнопки уходят, строка пишет итог и время
 * по Душанбе, а у решения с обратным вызовом появляется «Отменить» на 10 секунд
 * (то же окно держит тост `useUndoToast`, поведение не менялось). Через 10 секунд
 * без отмены строка убирается из списка.
 *
 * ГРУППА (`members`). Одинаковые решения свёрнуты в одну строку: у неё «массовая»
 * кнопка (`bulkLabel`) и «Разобрать», раскрывающая отдельные строки со своими
 * кнопками и своей отменой. Сделанное по одной строке из массового решения
 * выпадает, поэтому «Передать всех» не передаёт повторно.
 */
export function ActionRow({
  k,
  avatar,
  title,
  description,
  actions,
  links,
  members,
  bulkLabel,
  bulkEndpoint,
  onDone,
  onDecided,
  onUndone,
}: {
  tone: PultTone;
  /** Раздел в начале второй строки: «Сделки», «Клиенты», «Объекты». */
  k: string;
  avatar?: ActionRowAvatar;
  title: string;
  description?: string;
  actions: ActionRowAction[];
  links?: ActionRowLink[];
  members?: ActionRowData[];
  bulkLabel?: string;
  bulkEndpoint?: string;
  /** Вызывается один раз, когда 10-секундное окно истекло без отмены — строка убирается из списка. */
  onDone?: () => void;
  /** Первое успешное решение по строке. */
  onDecided?: () => void;
  /** Решение УСПЕШНО отменено в окне: строка снова доступна (FORMS10). Неудачная отмена не вызывает. */
  onUndone?: () => void;
}) {
  const { showUndoToast } = useUndoToast();
  const [status, setStatus] = useState<"idle" | "done" | "leaving">("idle");
  const [resultText, setResultText] = useState<string | null>(null);
  const [doneAt, setDoneAt] = useState<string | null>(null);
  const [undo, setUndo] = useState<(() => Promise<void>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [memberDone, setMemberDone] = useState<Set<string>>(new Set());

  const isGroup = !!members && members.length > 1;
  const remaining = isGroup ? members.filter((m) => !memberDone.has(m.id)) : [];
  const allActions =
    isGroup && bulkLabel && bulkEndpoint && remaining.length > 0 ? [bulkAction(remaining, bulkLabel, bulkEndpoint)] : actions;

  async function run(action: ActionRowAction) {
    if (busy) return;
    setBusy(true);
    try {
      let ok = false;
      try {
        ok = await action.onRun();
      } catch (err) {
        // Сервер отклонил запрос или сеть отвалилась — строка остаётся,
        // пользователь видит тост и может нажать кнопку заново.
        // Отказ по правилу (4xx) — ожидаемый ответ, человек видит его тостом;
        // в консоли это предупреждение, а не ошибка (e2e dead-controls
        // считает console.error поломкой экрана).
        if (err instanceof ApiError && err.status < 500) {
          console.warn("[ActionRow] onRun rejected", action.endpoint, err.message);
        } else {
          console.error("[ActionRow] onRun failed", action.endpoint, err);
        }
        showUndoToast({ message: `Не удалось · ${action.label.toLowerCase()} · повторите` });
        return;
      }
      if (!ok) {
        showUndoToast({ message: `Не удалось · ${action.label.toLowerCase()} · повторите` });
        return;
      }
      const message = typeof action.doneMessage === "function" ? action.doneMessage() : action.doneMessage;
      setResultText(message);
      // По Душанбе, а не в поясе браузера (ночная проверка 24.09.2026, находка №10).
      setDoneAt(dushanbeTime(new Date()));
      setStatus("done");
      onDecided?.();
      const undoFn = action.onUndo
        ? async () => {
            try {
              await action.onUndo?.();
            } catch (err) {
              // Отмена не удалась — строка остаётся «сделано», а человек видит
              // причину: раньше строка показывала «отменено», хотя ничего не
              // отменилось (аудит 23.09.2026, №36).
              console.warn("[ActionRow] onUndo failed", action.endpoint, err);
              showUndoToast({ message: `Отменить не удалось${err instanceof Error && err.message ? `: ${err.message}` : ""}` });
              return;
            }
            setStatus("idle");
            setResultText(null);
            setUndo(null);
            onUndone?.();
          }
        : null;
      setUndo(() => undoFn);
      showUndoToast({
        message,
        onUndo: undoFn ?? undefined,
        onCommit: () => {
          setStatus("leaving");
          window.setTimeout(() => onDone?.(), 240);
        },
      });
    } finally {
      setBusy(false);
    }
  }

  const idle = status === "idle";
  const second = idle
    ? [k, description].filter(Boolean).join(" · ")
    : `${resultText ?? ""}${doneAt ? ` · ${doneAt}` : ""}`;

  const actionCount = idle
    ? allActions.length + (links ?? []).length + (isGroup ? 1 : 0)
    : undo
      ? 1
      : 0;

  return (
    <>
      <Row
        className="wrapt"
        actionCount={actionCount}
        avatar={avatar}
        title={title}
        line={second || undefined}
        done={!idle}
        actions={
          <>
            {idle &&
              allActions.map((action, i) => (
                <Button
                  key={action.endpoint + action.label}
                  size="sm"
                  variant={action.secondary || i > 0 ? "ghost" : "primary"}
                  data-endpoint={action.endpoint}
                  loading={busy}
                  onClick={() => run(action)}
                >
                  {action.label}
                </Button>
              ))}
            {idle &&
              (links ?? []).map((l, i) => (
                <LinkButton key={l.href + l.label} to={l.href} size="sm" variant={allActions.length === 0 && i === 0 ? "primary" : "ghost"}>
                  {l.label}
                </LinkButton>
              ))}
            {idle && isGroup && (
              <Button
                size="sm"
                variant={allActions.length === 0 && (links ?? []).length === 0 ? "primary" : "ghost"}
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? "Свернуть" : "Разобрать"}
              </Button>
            )}
            {!idle && undo && (
              <Button size="sm" variant="ghost" onClick={() => void undo()}>
                Отменить
              </Button>
            )}
          </>
        }
      />
      {idle && isGroup && expanded && (
        <div className="rh-group-members">
          {members.map((m) => (
            <ActionRow
              key={m.id}
              tone={m.tone}
              k={kOf(m)}
              avatar={m.avatar}
              title={m.title}
              description={m.description}
              actions={m.actions}
              links={m.links}
              onDecided={() => setMemberDone((prev) => new Set(prev).add(m.id))}
              onUndone={() =>
                setMemberDone((prev) => {
                  const next = new Set(prev);
                  next.delete(m.id);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

/** Выбор исполнителя в строке (кому передать): defaultId — наименее загруженный. */
export interface ActionRowChoice {
  label: string;
  options: { id: string; label: string }[];
  defaultId: string;
}

/** Объект, материалы которого директор проверяет на месте (шторка «Проверить материалы»). */
export interface ActionRowReview {
  propertyId: string;
  shortId: number;
  title: string;
}

export interface ActionRowData {
  id: string;
  tone: Exclude<PultTone, "ok">;
  /** Раздел во второй строке. Если не задан, выводится по префиксу id. */
  k?: string;
  avatar: ActionRowAvatar;
  title: string;
  description?: string;
  actions: ActionRowAction[];
  /** Переходы без запроса («Ответить» на вопрос ИИ). */
  links?: ActionRowLink[];
  /** Одинаковые решения под одной строкой: массовая кнопка и «Разобрать». */
  members?: ActionRowData[];
  bulkLabel?: string;
  bulkEndpoint?: string;
  /** Подтверждение массовой кнопки с числом оставшихся («Передать 5 клиентов?»). */
  bulkConfirm?: (count: number) => string;
  /** Выбор агента для «Передать»; у группы действует на всех участников. */
  choice?: ActionRowChoice;
  /** Строка проверки материалов: решение принимается в шторке. */
  review?: ActionRowReview;
  /** Вопрос бота директору: ответ вводится в самой строке. */
  ownerQuestionId?: string;
}

const K_BY_PREFIX: [RegExp, string][] = [
  [/^deal/, "Сделки"],
  [/^property/, "Объекты"],
  [/^client/, "Клиенты"],
  [/^call/, "Звонки"],
  [/^system/, "Система"],
  [/^owner|^question/, "Вопрос"],
];

function kOf(row: ActionRowData): string {
  if (row.k) return row.k;
  return K_BY_PREFIX.find(([re]) => re.test(row.id))?.[1] ?? "Дело";
}

/**
 * Массовое решение по группе: прогоняет первое действие каждой строки
 * параллельно. Успех, если прошла хотя бы одна; итог говорит «N из M». Отмена
 * есть только если она есть у КАЖДОГО решения (иначе обещание было бы ложным).
 */
export function bulkAction(members: ActionRowData[], label: string, endpoint: string): ActionRowAction {
  const ran: ActionRowAction[] = [];
  const total = members.length;
  const allUndoable = members.every((m) => !!m.actions[0]?.onUndo);
  return {
    label,
    endpoint,
    onRun: async () => {
      ran.length = 0;
      await Promise.all(
        members.map(async (m) => {
          const a = m.actions[0];
          if (!a) return;
          try {
            if (await a.onRun()) ran.push(a);
          } catch (err) {
            console.warn("[ActionRow] bulk member failed", a.endpoint, err);
          }
        }),
      );
      return ran.length > 0;
    },
    onUndo: allUndoable
      ? async () => {
          const done = [...ran];
          await Promise.all(done.map((a) => a.onUndo?.()));
          ran.length = 0;
        }
      : undefined,
    doneMessage: () => (ran.length === total ? `Готово · ${total}` : `Готово ${ran.length} из ${total}`),
  };
}

/** Сообщает родителю, сколько решений осталось: пульт пишет число в подзаголовок. */
function CountReporter({ n, onCount }: { n: number; onCount: (n: number) => void }) {
  useEffect(() => {
    onCount(n);
  }, [n, onCount]);
  return null;
}

/**
 * Блок «Ждут вас · N»: карточка с `List` из строк решений. Порядок crit → warn.
 * Когда решать нечего, вместо списка тихая строка «Всё решено». `onCount`
 * сообщает число нерешённых (подзаголовок экрана читает его оттуда же).
 */
export function ActionRowList({
  rows,
  title = "Ждут вас",
  onCount,
}: {
  rows: ActionRowData[];
  title?: string;
  onCount?: (n: number) => void;
}) {
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [decided, setDecided] = useState<Set<string>>(new Set());

  const sorted = [...rows]
    .filter((r) => !hiddenIds.has(r.id))
    .sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "crit" ? -1 : 1));

  const left = sorted.filter((r) => !decided.has(r.id)).length;

  if (sorted.length === 0) {
    return (
      <Card tight title={`${title} · 0`}>
        {onCount ? <CountReporter n={0} onCount={onCount} /> : null}
        <p className="quiet ok">
          <i className="dot d-ok" aria-hidden="true" />
          Всё решено, ждать нечего.
        </p>
      </Card>
    );
  }

  return (
    <Card tight title={`${title} · ${left}`}>
      {onCount ? <CountReporter n={left} onCount={onCount} /> : null}
      <List aria-label="Решения, которые ждут вас">
        {sorted.map((row) => (
          <ActionRow
            key={row.id}
            tone={row.tone}
            k={kOf(row)}
            avatar={row.avatar}
            title={row.title}
            description={row.description}
            actions={row.actions}
            links={row.links}
            members={row.members}
            bulkLabel={row.bulkLabel}
            bulkEndpoint={row.bulkEndpoint}
            onDone={() => setHiddenIds((prev) => new Set(prev).add(row.id))}
            onDecided={() => setDecided((prev) => new Set(prev).add(row.id))}
            // Успешная отмена возвращает строку в счётчик (FORMS10).
            onUndone={() =>
              setDecided((prev) => {
                const next = new Set(prev);
                next.delete(row.id);
                return next;
              })
            }
          />
        ))}
      </List>
    </Card>
  );
}
