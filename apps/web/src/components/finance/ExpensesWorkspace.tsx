import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  CLIENT_SOURCES,
  CLIENT_SOURCE_LABELS,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  expenseUpdateSchema,
  type ClientSource,
  type ExpenseCategory,
} from "@royal-home/shared";
import {
  useCreateExpense,
  useCreateRecurring,
  useDeleteExpense,
  useExpenseForecast,
  useExpenses,
  useUpdateExpense,
  type Expense,
} from "../../hooks/useFinance";
import { useAgents } from "../../hooks/useAgents";
import { Rh2Money } from "../rh2/Rh2Money";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { ConfirmDialog } from "../ConfirmDialog";
import { useCleanShell } from "../../hooks/useCleanShell";
import { CleanExpenseWizard } from "./CleanExpenseWizard";

/**
 * РАСХОДЫ — раздел «Расходы» экрана /finance, перенесённый из прототипа темы
 * «Royal Home 2026» (`screens/finance.html`) дословно: полоса долей категорий,
 * прокручиваемая лента категорий, тихая строка прогноза, строка-решение с
 * единственной чёрной кнопкой экрана, две группы строк («Ведёт CRM» и
 * «Заведено вручную») и подпись «Показаны N из M за месяц».
 *
 * Один компонент на телефон и компьютер: у прототипа своя раскладка ≤820 px,
 * второй копии экрана нет специально — правки в двух копиях разъезжались.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ СВЕРХ ПРОТОТИПА (функции CRM, которых макет не рисует; одеты
 * теми же классами, чтобы не выбиваться):
 * · правка суммы строкой, без модального окна;
 * · доллары авто-строк: сумма показывается в сомони по курсу CRM, исходный
 *   счёт остаётся чипом рядом (решение владельца 20.08.2026);
 * · в шторке «Новый расход» переключатель «Каждый месяц» заводит шаблон
 *   повторяющегося платежа — ровно то, что обещает подпись под списком
 *   шаблонов в прототипе.
 */

/** Серая лесенка полосы долей — как в прототипе, по позиции категории. */
const BAR_TONES = ["var(--ink)", "var(--muted)", "var(--faint)", "var(--track)"];

/** Готовые платежи агентства: клик подставляет название, остаётся сумма и число. */
const RECURRING_PRESETS: { title: string; category: ExpenseCategory }[] = [
  { title: "Аренда офиса", category: "OFFICE" },
  { title: "Интернет и связь", category: "OFFICE" },
  { title: "Сервер и домены", category: "OFFICE" },
  { title: "Телефония, АТС", category: "OFFICE" },
  { title: "Хранилище файлов", category: "OFFICE" },
  { title: "Реклама у блогеров", category: "ADVERTISING" },
];

/** Сколько строк видно до нажатия «Показать ещё» (правило владельца 8). */
const PAGE = 6;

function monthLabel(m: string): string {
  // Середина месяца в UTC: подпись месяца не должна зависеть от пояса устройства.
  return new Date(`${m}-15T12:00:00Z`).toLocaleDateString("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).replace(" г.", "");
}

/** Сумма строки в сомони — авто-строки бывают в долларах. */
function amountTjs(e: Expense, usdToTjs: number): number {
  const value = Number(e.amount);
  return (e as { currency?: string }).currency === "USD" ? value * usdToTjs : value;
}

/** Заголовок строки: чем платёж узнаётся с одного взгляда. */
function rowTitle(e: Expense): string {
  if (e.source) return CLIENT_SOURCE_LABELS[e.source];
  if (e.agent) return e.agent.fullName;
  return EXPENSE_CATEGORY_LABELS[e.category];
}

export function ExpensesWorkspace({
  month,
  canManage,
  usdToTjs,
}: {
  month: string;
  canManage: boolean;
  usdToTjs: number;
}) {
  const cleanShell = useCleanShell();
  const { data: expenses, isLoading, isError: expensesFailed, refetch: refetchExpenses } = useExpenses(month);
  const { data: forecast } = useExpenseForecast();
  const [filter, setFilter] = useState<ExpenseCategory | "all">("all");
  const [visibleCount, setVisibleCount] = useState(PAGE);
  const [sheetOpen, setSheetOpen] = useState(false);

  // useMemo, а не `expenses ?? []`: новая ссылка на каждый рендер пересчитывала бы
  // разбивку по категориям вхолостую (и линт правильно на это ругается).
  const rows = useMemo(() => expenses ?? [], [expenses]);
  // The endpoint has no total/truncated metadata. At its cap, every list statistic
  // is explicitly scoped to loaded records, not presented as the whole month.
  const possiblyLimited = rows.length >= 200;
  const total = rows.reduce((acc, e) => acc + amountTjs(e, usdToTjs), 0);

  const byCategory = useMemo(() => {
    const map = new Map<ExpenseCategory, number>();
    for (const e of rows) map.set(e.category, (map.get(e.category) ?? 0) + amountTjs(e, usdToTjs));
    return EXPENSE_CATEGORIES.map((c) => ({ category: c, amount: map.get(c) ?? 0 })).filter((x) => x.amount > 0);
  }, [rows, usdToTjs]);

  const visible = filter === "all" ? rows : rows.filter((e) => e.category === filter);
  // Порядок прототипа: сначала то, что ведёт CRM, потом заведённое руками.
  const ordered = useMemo(() => [...visible.filter((e) => e.autoKey), ...visible.filter((e) => !e.autoKey)], [visible]);
  const shown = ordered.slice(0, visibleCount);
  const auto = shown.filter((e) => e.autoKey);
  const manual = shown.filter((e) => !e.autoKey);

  const isCurrentMonth = forecast?.month === month;

  return (
    <div className="sec">
      <div className="sec-h">
        <h2>Расходы</h2>
        <span className="note">
          {monthLabel(month)}, {Math.round(total).toLocaleString("ru-RU")} сомони{possiblyLimited ? " в загруженных строках" : ""}
        </span>
      </div>

      <div className="card tight">
        {possiblyLimited && (
          <p className="state err" role="alert">
            Загружено {rows.length} расходов; достигнут предел списка. Суммы и доли категорий ниже относятся только к загруженным строкам. Итог месяца смотрите в финансовой сводке.
          </p>
        )}
        {byCategory.length > 0 && (
          <div className="prog split" aria-hidden="true">
            {byCategory.map((c, i) => (
              <i
                key={c.category}
                style={
                  {
                    "--v": Math.round((c.amount / total) * 100),
                    background: BAR_TONES[i % BAR_TONES.length],
                  } as CSSProperties
                }
              />
            ))}
          </div>
        )}

        <div className="hscroll" style={{ marginTop: 12 }}>
          <div className="seg" role="tablist" aria-label="Категория расходов">
            <button
              type="button"
              role="tab"
              aria-selected={filter === "all"}
              onClick={() => {
                setFilter("all");
                setVisibleCount(PAGE);
              }}
            >
              {possiblyLimited ? "Все загруженные" : "Все"} <span className="n">{Math.round(total).toLocaleString("ru-RU")}</span>
            </button>
            {byCategory.map((c) => (
              <button
                key={c.category}
                type="button"
                role="tab"
                aria-selected={filter === c.category}
                onClick={() => {
                  setFilter(filter === c.category ? "all" : c.category);
                  setVisibleCount(PAGE);
                }}
              >
                {EXPENSE_CATEGORY_LABELS[c.category]}{" "}
                <span className="n">
                  {total > 0 && (c.amount / total) * 100 < 1 ? "меньше 1" : Math.round((c.amount / total) * 100)} %
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Прогноз — только для текущего месяца: у закрытого прогнозировать нечего. */}
        {isCurrentMonth && forecast && forecast.averageTjs > 0 && (
          <div className={forecast.overrun ? "quiet warn" : "quiet"} style={{ marginTop: 12 }}>
            <span className="txt">
              К концу месяца по текущему темпу выйдет около {forecast.projectedTjs.toLocaleString("ru-RU")} сомони.
              Средний месяц {forecast.averageTjs.toLocaleString("ru-RU")}:{" "}
              {forecast.overrun ? "идём выше обычного" : "идём в пределах обычного"}.
            </span>
          </div>
        )}

        {/* Правка только при праве finance.manage. Единственная чёрная кнопка экрана. */}
        {canManage && (
          <div className="solve" style={{ marginTop: 4 }}>
            <span className="t">
              {cleanShell
                ? "Три коротких шага: сумма, назначение и месяц учёта. Для повторов — ежемесячный шаблон."
                : "Добавить расход строкой: что оплатили и сколько. Категория и источник подставятся, если узнаваемо."}
            </span>
            <span className="acts">
              <button className="pill sm" type="button" onClick={() => setSheetOpen(true)}>
                Добавить расход
              </button>
            </span>
          </div>
        )}

        {isLoading ? (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Считаем деньги
          </div>
        ) : expensesFailed ? (
          /* Отказ запроса читался директором как месяц без трат (аудит
             22.08.2026, раунд 6). */
          <div className="state err">
            <span className="dot crit" /> Расходы не загрузились. Это сбой связи, а не нулевые траты.
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetchExpenses()}
            >
              Повторить
            </button>
          </div>
        ) : ordered.length === 0 ? (
          <div className="empty">
            <span className="ic">
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="6" width="18" height="13" rx="3" />
                <path d="M3 10h18M7 15h4" />
              </svg>
            </span>
            <p>
              За этот месяц расходов нет. Реклама и повторяющиеся платежи появятся здесь сами, остальное добавьте
              строкой.
            </p>
            {canManage && (
              <button className="pill ghost" type="button" onClick={() => setSheetOpen(true)}>
                Добавить расход
              </button>
            )}
          </div>
        ) : (
          <>
            {auto.length > 0 && (
              <>
                <div className="sec-t">Ведёт CRM</div>
                <div className="list">
                  {auto.map((e) => (
                    <ExpenseRow key={e.id} e={e} canManage={canManage} usdToTjs={usdToTjs} />
                  ))}
                </div>
              </>
            )}
            {manual.length > 0 && (
              <>
                <div className="sec-t">Заведено вручную</div>
                <div className="list">
                  {manual.map((e) => (
                    <ExpenseRow key={e.id} e={e} canManage={canManage} usdToTjs={usdToTjs} />
                  ))}
                </div>
              </>
            )}
            <p className="state">
              Показаны {shown.length} из {ordered.length}{possiblyLimited ? " загруженных строк выбранной категории" : " за месяц"}.{" "}
              {ordered.length > shown.length && (
                <button className="lk" type="button" onClick={() => setVisibleCount((c) => c + PAGE)}>
                  Показать ещё ({ordered.length - shown.length})
                </button>
              )}
            </p>
          </>
        )}
      </div>

      {cleanShell
        ? <CleanExpenseWizard open={sheetOpen} onClose={() => setSheetOpen(false)} month={month} canManage={canManage} />
        : <NewExpenseSheet open={sheetOpen && canManage} onClose={() => setSheetOpen(false)} month={month} />}
    </div>
  );
}

/** Synchronous lock: two clicks before React's next render must still send one request. */
export function createExpenseActionLock() {
  let busy = false;
  return async (action: () => Promise<void>): Promise<boolean> => {
    if (busy) return false;
    busy = true;
    try { await action(); return true; }
    finally { busy = false; }
  };
}

/** Keep API validation authoritative; accept the decimal comma used by local keyboards. */
export function parseExpenseEditAmount(value: string): number | null {
  const parsed = expenseUpdateSchema.safeParse({ amount: Number(value.trim().replace(",", ".")) });
  return parsed.success && parsed.data.amount !== undefined ? parsed.data.amount : null;
}

/** Строка расхода прототипа: заголовок и пояснение, чип «авто», сумма, действия. */
function ExpenseRow({ e, canManage, usdToTjs }: { e: Expense; canManage: boolean; usdToTjs: number }) {
  const update = useUpdateExpense();
  const remove = useDeleteExpense();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(Number(e.amount)));
  const openingVersion = useRef(e.version);
  const deleteVersion = useRef(e.version);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const actionLock = useRef(createExpenseActionLock());
  const currency = (e as { currency?: "TJS" | "USD" }).currency ?? "TJS";

  const cancelEdit = () => {
    if (working) return;
    setValue(String(Number(e.amount)));
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    const amount = parseExpenseEditAmount(value);
    if (amount === null) { setError("Введите корректную сумму больше нуля."); return; }
    await actionLock.current(async () => {
      setWorking(true); setError(null);
      try {
        await update.mutateAsync({ id: e.id, amount, version: openingVersion.current });
        setEditing(false);
      } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить расход. Повторите."); }
      finally { setWorking(false); }
    });
  };

  const deleteExpense = async () => {
    await actionLock.current(async () => {
      setWorking(true); setError(null);
      try { await remove.mutateAsync({ id: e.id, version: deleteVersion.current }); setConfirmDelete(false); }
      catch (err) { setError(err instanceof Error ? err.message : "Не удалось удалить расход. Повторите."); }
      finally { setWorking(false); }
    });
  };

  return (
    <>
    <div className="row" data-editing={editing || confirmDelete || undefined}>
      <div className="t">
        <b>{rowTitle(e)}</b>
        <span>
          {EXPENSE_CATEGORY_LABELS[e.category]}
          {e.note ? `, ${e.note}` : ""}
        </span>
      </div>
      {e.autoKey && <span className="chip mute">авто</span>}
      {/* ВСЕ СУММЫ — В СОМОНИ (решение владельца 20.08.2026): в столбце сравнивают
          взглядом, и доллар посреди сомони ломает сравнение. Исходная валюта не
          теряется — остаётся чипом рядом, чтобы строку можно было сверить с
          кабинетом Meta или счётом поставщика. */}
      {currency === "USD" && <span className="chip mute">${Number(e.amount).toFixed(2)}</span>}
      {editing && canManage ? (
        <>
        <label className="field">
          <span className="lab">Сумма в {currency}</span>
        <input
          className="inp"
          autoFocus
          disabled={working}
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === "Enter") { ev.preventDefault(); void save(); }
            if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); cancelEdit(); }
          }}
          inputMode="decimal"
          aria-label={`Сумма расхода в ${currency}`}
          aria-invalid={!!error}
          style={{ maxWidth: 140 }}
        />
        </label>
        <div className="act">
          <button className="pill ghost sm" type="button" disabled={working} onClick={() => void save()}>{working ? "Сохраняем…" : "Сохранить"}</button>
          <button className="pill ghost sm" type="button" disabled={working} onClick={cancelEdit}>Отмена</button>
        </div>
        </>
      ) : (
        <Rh2Money value={Math.round(amountTjs(e, usdToTjs))} style={{ fontSize: "var(--fs-14)" }} />
      )}
      {canManage && !editing && (
        <div className="act on-hover">
          <button className="pill ghost sm" type="button" disabled={working} onClick={() => { openingVersion.current = e.version; setValue(String(Number(e.amount))); setError(null); setEditing(true); }}>
            Изменить
          </button>
          <button className="lnk" type="button" disabled={working} onClick={() => { deleteVersion.current = e.version; setError(null); setConfirmDelete(true); }}>
            Удалить
          </button>
        </div>
      )}
    </div>
    {error && !confirmDelete && <p className="state err" role="alert">{error}</p>}
    {confirmDelete && canManage && <ConfirmDialog
      title="Удалить расход?"
      description={`«${rowTitle(e)}» будет перемещён в архив. Его можно восстановить.`}
      confirmLabel={working ? "Удаляем…" : "Удалить"}
      confirmDisabled={working}
      dismissible={!working}
      onConfirm={() => void deleteExpense()}
      onCancel={() => { if (!working) { setConfirmDelete(false); setError(null); } }}
    >{error && <p className="state err" role="alert">{error}</p>}</ConfirmDialog>}
    </>
  );
}

/**
 * Шторка «Новый расход» — поля прототипа плюс те, которых требует сервер
 * (expenseCreateSchema): канал рекламы для «Рекламы», сотрудник для «Зарплаты»,
 * обязательный комментарий для «Офиса» и «Прочего».
 */
function NewExpenseSheet({ open, onClose, month }: { open: boolean; onClose: () => void; month: string }) {
  const create = useCreateExpense();
  const createRecurring = useCreateRecurring();
  const { data: agents } = useAgents();
  const [note, setNote] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<ExpenseCategory>("OFFICE");
  const [source, setSource] = useState<ClientSource | "">("");
  const [agentId, setAgentId] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [day, setDay] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const needsSource = category === "ADVERTISING";
  const needsAgent = category === "SALARY";
  const needsNote = category === "OFFICE" || category === "OTHER";
  const ready =
    Number(amount) > 0 &&
    (!needsSource || source) &&
    (!needsAgent || agentId) &&
    (!needsNote || note.trim()) &&
    (!repeat || note.trim());

  const submit = async () => {
    setError(null);
    try {
      if (repeat) {
        // Шаблон повторяющегося платежа: дальше CRM заводит строку сама каждый месяц.
        await createRecurring.mutateAsync({
          title: note.trim(),
          amount: Number(amount),
          currency: "TJS",
          category,
          dayOfMonth: Math.min(28, Math.max(1, Number(day) || 1)),
          // Канал и сотрудник шаблона копируются в каждый ежемесячный расход (CRM-07).
          source: needsSource ? (source as ClientSource) : undefined,
          agentId: needsAgent ? agentId : undefined,
        });
      } else {
        await create.mutateAsync({
          month,
          category,
          amount: Number(amount),
          note: note.trim() || undefined,
          source: needsSource ? source : undefined,
          agentId: needsAgent ? agentId : undefined,
        });
      }
      setNote("");
      setAmount("");
      setSource("");
      setAgentId("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  };

  return (
    <Rh2Sheet
      open={open}
      onClose={onClose}
      title={repeat ? "Новый повторяющийся платёж" : "Новый расход"}
      footer={
        <>
          <button className="pill ghost" type="button" onClick={onClose}>
            Отмена
          </button>
          <button
            className="pill ghost"
            type="button"
            disabled={!ready || create.isPending || createRecurring.isPending}
            onClick={submit}
          >
            Добавить
          </button>
        </>
      }
    >
      <label className="field">
        <span className="lab">Что оплатили</span>
        <input
          className="inp"
          style={{ maxWidth: "none" }}
          placeholder="Например: аренда офиса"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <label className="field" style={{ marginTop: 12 }}>
        <span className="lab">Сумма, сомони</span>
        <input
          className="inp"
          style={{ maxWidth: "none" }}
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>

      <div className="sec-t">Категория</div>
      <div className="seg" role="group" aria-label="Категория расхода">
        {EXPENSE_CATEGORIES.map((c) => (
          <button key={c} type="button" aria-selected={category === c} onClick={() => setCategory(c)}>
            {EXPENSE_CATEGORY_LABELS[c]}
          </button>
        ))}
      </div>

      {needsSource && (
        <label className="field" style={{ marginTop: 12 }}>
          <span className="lab">Канал рекламы</span>
          <select
            className="inp"
            style={{ maxWidth: "none" }}
            value={source}
            onChange={(e) => setSource(e.target.value as ClientSource)}
          >
            <option value="">Выберите канал</option>
            {CLIENT_SOURCES.map((s) => (
              <option key={s} value={s}>
                {CLIENT_SOURCE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
      )}

      {needsAgent && (
        <label className="field" style={{ marginTop: 12 }}>
          <span className="lab">Сотрудник</span>
          <select className="inp" style={{ maxWidth: "none" }} value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            <option value="">Выберите сотрудника</option>
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.fullName}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="sec-t">Повторять</div>
      <div className="seg" role="group" aria-label="Повторять платёж">
        <button type="button" aria-selected={!repeat} onClick={() => setRepeat(false)}>
          Разовый
        </button>
        <button type="button" aria-selected={repeat} onClick={() => setRepeat(true)}>
          Каждый месяц
        </button>
      </div>

      {repeat && (
        <>
          <label className="field" style={{ marginTop: 12 }}>
            <span className="lab">Число оплаты</span>
            <input
              className="inp"
              style={{ maxWidth: 140 }}
              inputMode="numeric"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
          <div className="sec-t">Частые платежи</div>
          <div className="seg" role="group" aria-label="Готовые названия платежей">
            {RECURRING_PRESETS.map((p) => (
              <button
                key={p.title}
                type="button"
                aria-selected={note === p.title}
                onClick={() => {
                  setNote(p.title);
                  setCategory(p.category);
                }}
              >
                {p.title}
              </button>
            ))}
          </div>
        </>
      )}

      {repeat && needsSource && !source && (
        <p className="state">Для рекламы выберите канал выше: по нему считается стоимость лида.</p>
      )}
      {error && (
        <p className="state err">
          <span className="dot crit" /> {error}
        </p>
      )}
      <p className="state">
        Комментарий обязателен для категорий «Офис» и «Прочее»: иначе через месяц никто не вспомнит, за что платили.
      </p>
    </Rh2Sheet>
  );
}
