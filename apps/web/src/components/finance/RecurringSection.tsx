import { useState } from "react";
import { CLIENT_SOURCES, CLIENT_SOURCE_LABELS, EXPENSE_CATEGORY_LABELS, type ClientSource } from "@royal-home/shared";
import {
  useDeleteRecurring,
  useRecurringExpenses,
  useUpdateRecurring,
  type RecurringExpense,
} from "../../hooks/useFinance";
import { useAgents } from "../../hooks/useAgents";
import { Rh2Money } from "../rh2/Rh2Money";
import { ConfirmDialog } from "../ConfirmDialog";
import { parseRecurringForm } from "../../lib/recurringForm";

/**
 * ПОВТОРЯЮЩИЕСЯ ПЛАТЕЖИ — аренда, серверы, домены, связь. Раздел прототипа
 * «Повторяющиеся платежи» (`screens/finance.html`) один в один: строки списка,
 * чип состояния, кнопка «Изменить», тихая строка-подсказка снизу.
 *
 * Шаблон заводится один раз; дальше CRM сама: за три дня — напоминание «подходит
 * оплата», в день оплаты — строка в расходах и уведомление. Выключенный шаблон
 * ничего не делает, но история строк цела.
 *
 * Заведение шаблона живёт в шторке «Новый расход» (переключатель «Каждый
 * месяц»), как и обещает подпись под списком в прототипе.
 */

/** «2026-09» → «сентябрь». Для строки «последняя строка за сентябрь». */
function monthWord(month: string | null): string | null {
  if (!month) return null;
  // Середина месяца в UTC: подпись месяца не должна зависеть от пояса устройства.
  const d = new Date(`${month}-15T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return month;
  return d.toLocaleDateString("ru-RU", { month: "long", timeZone: "UTC" });
}

export function RecurringSection({ canManage }: { canManage: boolean }) {
  const { data: rows, isLoading, isError: rowsFailed, refetch: refetchRows } = useRecurringExpenses();
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Повторяющиеся платежи</h2>
        <span className="note">CRM заводит строку каждый месяц сама</span>
      </div>
      <div className="card tight">
        {isLoading ? (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w28" /> Загружаем шаблоны
          </div>
        ) : rowsFailed ? (
          /* «Пока пусто» при отказе толкало завести шаблон заново — и CRM начала
             бы создавать ДВЕ одинаковые строки расхода каждый месяц автоматически
             (аудит 22.08.2026, раунд 6). */
          <div className="state err">
            <span className="dot crit" /> Шаблоны не загрузились. Не заводите заново, иначе расход задвоится.
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetchRows()}
            >
              Повторить
            </button>
          </div>
        ) : (rows?.length ?? 0) === 0 ? (
          <p className="state">
            Пока пусто. Заведите аренду, серверы или связь: CRM будет заводить строку каждый месяц и напоминать об
            оплате сама.
          </p>
        ) : (
          <div className="list">
            {rows!.map((r) =>
              editingId === r.id && canManage ? (
                <RecurringEdit key={r.id} row={r} onDone={() => setEditingId(null)} />
              ) : (
                <div className="row" key={r.id}>
                  <div className="t">
                    <b>{r.title}</b>
                    <span>
                      {EXPENSE_CATEGORY_LABELS[r.category]}
                      {r.category === "ADVERTISING" && r.source ? `, ${CLIENT_SOURCE_LABELS[r.source]}` : ""}, {r.dayOfMonth} числа
                      {monthWord(r.lastCreatedMonth) ? `, последняя строка за ${monthWord(r.lastCreatedMonth)}` : ""}
                    </span>
                  </div>
                  {/* Валюта чипом, а не подписью `.cur`: `.cur` это .72em, и от
                      14 px строки получается 10 px — ниже разрешённых 12. */}
                  {r.currency === "USD" && <span className="chip mute">долларов</span>}
                  <Rh2Money value={Number(r.amount)} style={{ fontSize: "var(--fs-14)" }} />
                  <div className="act">
                    <span className={r.active ? "chip ok" : "chip mute"}>{r.active ? "включено" : "выключено"}</span>
                    {canManage && (
                      <button className="pill ghost sm" type="button" onClick={() => setEditingId(r.id)}>
                        Изменить
                      </button>
                    )}
                  </div>
                </div>
              )
            )}
          </div>
        )}
        <p className="state">
          Добавить шаблон можно кнопкой «Добавить расход»: отметьте «Каждый месяц».
        </p>
      </div>
    </div>
  );
}

/**
 * Правка шаблона прямо в строке, без модального окна (правило владельца 9).
 * Меняются сумма, число оплаты, состояние и (для рекламы и зарплаты) канал или
 * сотрудник; удаление тут же, рядом. Шаблон, заведённый до CRM-07, можно сохранить и
 * без канала/сотрудника: расходы по нему заводятся, как раньше.
 */
function RecurringEdit({ row, onDone }: { row: RecurringExpense; onDone: () => void }) {
  const update = useUpdateRecurring();
  const remove = useDeleteRecurring();
  const [amount, setAmount] = useState(String(Number(row.amount)));
  const [day, setDay] = useState(String(row.dayOfMonth));
  const [active, setActive] = useState(row.active);
  const [source, setSource] = useState<ClientSource | "">(row.source ?? "");
  const [agentId, setAgentId] = useState(row.agentId ?? "");
  const needsSource = row.category === "ADVERTISING";
  const needsAgent = row.category === "SALARY";
  const { data: agents } = useAgents({ enabled: needsAgent });
  // Шаблон удаляется насовсем, без корзины, — только через подтверждение (F7).
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);

  const save = async () => {
    // Негодную сумму или число не подменяем прежними молча: ошибка у поля,
    // редактор остаётся открытым (FORMS06).
    const parsed = parseRecurringForm(amount, day);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    setFormError(null);
    await update.mutateAsync({
      id: row.id,
      amount: parsed.amount,
      dayOfMonth: parsed.dayOfMonth,
      active,
      // Только выбранное: пустое поле старого шаблона не отправляем, иначе сервер
      // потребовал бы канал/сотрудника ради простой правки суммы.
      ...(needsSource && source ? { source } : {}),
      ...(needsAgent && agentId ? { agentId } : {}),
    });
    onDone();
  };

  return (
    <div className="row">
      <div className="t">
        <b>{row.title}</b>
        <span>{EXPENSE_CATEGORY_LABELS[row.category]}</span>
      </div>
      <label className="field">
        <span className="lab">Сумма</span>
        <input
          className="inp"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-invalid={formError !== null}
          style={{ maxWidth: 140 }}
        />
      </label>
      <label className="field">
        <span className="lab">Число</span>
        <input
          className="inp"
          inputMode="numeric"
          value={day}
          onChange={(e) => setDay(e.target.value)}
          aria-invalid={formError !== null}
          style={{ maxWidth: 96 }}
        />
      </label>
      {needsSource && (
        <label className="field">
          <span className="lab">Канал рекламы</span>
          <select className="inp" value={source} onChange={(e) => setSource(e.target.value as ClientSource | "")}>
            <option value="">Не выбран</option>
            {CLIENT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {CLIENT_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}
      {needsAgent && (
        <label className="field">
          <span className="lab">Сотрудник</span>
          <select className="inp" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Не выбран</option>
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </select>
        </label>
      )}
      {((needsSource && !source) || (needsAgent && !agentId)) && (
        <p className="state">
          {needsSource ? "Канал не выбран: расход заведётся без канала и не попадёт в стоимость лида." : "Сотрудник не выбран: расход заведётся без сотрудника."}
        </p>
      )}
      {formError && (
        <p className="state err" role="alert">
          <span className="dot crit" /> {formError}
        </p>
      )}
      <div className="seg" role="group" aria-label="Состояние шаблона">
        <button type="button" aria-selected={active} onClick={() => setActive(true)}>
          Включено
        </button>
        <button type="button" aria-selected={!active} onClick={() => setActive(false)}>
          Выключено
        </button>
      </div>
      <div className="act">
        <button className="pill sm" type="button" disabled={update.isPending} onClick={save}>
          Сохранить
        </button>
        <button className="pill ghost sm" type="button" onClick={onDone}>
          Отмена
        </button>
        <button className="lnk" type="button" onClick={() => setConfirmDelete(true)}>
          Удалить
        </button>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title={`Удалить шаблон «${row.title}»?`}
          description="Шаблон удаляется насовсем, восстановить его нельзя: со следующего месяца этот расход сам не появится. Уже записанные расходы останутся."
          confirmLabel={remove.isPending ? "Удаляем…" : "Удалить"}
          confirmDisabled={remove.isPending}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() =>
            remove.mutate(row.id, {
              onSuccess: () => onDone(),
              onSettled: () => setConfirmDelete(false),
            })
          }
        />
      )}
    </div>
  );
}
