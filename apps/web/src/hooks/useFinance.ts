import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ClientSource, CommissionForecast, Currency, ExpenseCategory } from "@royal-home/shared";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export interface Expense {
  id: string;
  version?: number;
  category: ExpenseCategory;
  source: ClientSource | null;
  agentId: string | null;
  agent: { id: string; fullName: string } | null;
  /** Непустой — строку ведёт CRM (реклама, ИИ, повторяющийся платёж, зарплата). */
  autoKey?: string | null;
  amount: string;
  /** Новые расходы вводятся в TJS; исторические записи могут храниться в USD. */
  currency: Currency;
  month: string;
  note: string | null;
  deletedAt?: string | null;
}

/** Одна сделка внутри выплаты агента — «Финансы» (ночная проверка 24.09.2026,
 *  находка №206: раньше рядом со сделкой не печаталась дата выплаты вовсе). */
export interface AgentPayoutDeal {
  dealId: string;
  clientName: string | null;
  propertyTitle: string;
  realtor: number;
  /** null — комиссия ещё не выплачена (см. DealDocumentsModal, «Отметить выплаченной»). */
  payoutAt: string | null;
}

export interface AgentPayout {
  agentId: string;
  name: string;
  realtor: number;
  total: number;
  deals: AgentPayoutDeal[];
}

export interface FinanceMonth {
  month: string;
  /** Валовая комиссия — всё, что заплатили клиенты по закрытым сделкам месяца. */
  revenue: number;
  /** Из валовой: выплаты риелторам и доход компании (0,5% «за приём объекта»
   *  отменены 11.09.2026 — эта доля больше не выделяется отдельно). */
  realtorPayouts: number;
  companyRevenue: number;
  /** Прозрачность выплат: кому сколько причитается за месяц. */
  payouts: AgentPayout[];
  expenses: Partial<Record<ExpenseCategory, number>>;
  totalExpenses: number;
  /** Из расходов — авто-строки «Зарплата из сделок»: доли агентов, которые уже
   *  не входят в доход компании и второй раз из прибыли не вычитаются. */
  dealSalaryExpenses: number;
  /** Расходы, вычитаемые из дохода компании: все, кроме зарплат из сделок. */
  operatingExpenses: number;
  /** Прибыль = доход компании − operatingExpenses. */
  profit: number;
  leads: number;
  costPerLead: {
    source: ClientSource;
    spent: number;
    leads: number;
    costPerLead: number | null;
    deals: number;
    /** «Сомони за сделку»: расход канала / его закрытые сделки месяца; 0 сделок → прочерк. */
    costPerDeal: number | null;
  }[];
}

export function useFinanceSummary(months = 6, enabled = true, throughMonth?: string) {
  return useQuery({
    queryKey: throughMonth ? ["finance-summary", months, throughMonth] : ["finance-summary", months],
    // usdToTjsRate сервер отдаёт вместе со сводкой — курс в CRM один, и экран
    // расходов обязан считать по нему же, иначе на одной странице оказываются две
    // разные суммы расходов месяца (поймано при дизайн-проверке 20.08.2026).
    queryFn: () => api<{ months: FinanceMonth[]; usdToTjsRate: number; truncated?: boolean }>(`/expenses/summary?months=${months}${throughMonth ? `&through=${encodeURIComponent(throughMonth)}` : ""}`),
    enabled,
    // Данные месячные: глобальный опрос раз в 25 секунд гонял бы тяжёлый
    // запрос впустую на каждой открытой вкладке.
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

/** Скачивание полной бухгалтерии (сделки с разбивкой комиссии + расходы) в CSV для Excel. */
export async function downloadFinanceCsv(months: number) {
  const blob = await api<Blob>(`/expenses/export?months=${months}`, { responseType: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `royal-home-finance.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function useExpenses(month: string) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["expenses", month],
    queryFn: () => api<Expense[]>(`/expenses?month=${month}`),
  });
}

/** Что гасить после любой правки расходов. Вынесено отдельно ради теста (F7). */
export function invalidateExpenseQueries(qc: Pick<ReturnType<typeof useQueryClient>, "invalidateQueries">) {
  qc.invalidateQueries({ queryKey: ["expenses"] });
  qc.invalidateQueries({ queryKey: ["finance-summary"] });
  // Архив — отдельный ключ (не префикс ["expenses"]): без него удалённая строка
  // появлялась в архиве только через пять минут (staleTime архива).
  qc.invalidateQueries({ queryKey: ["expenses-archive"] });
}

const invalidate = (qc: ReturnType<typeof useQueryClient>) => () => invalidateExpenseQueries(qc);

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api("/expenses", { method: "POST", body }),
    onSuccess: invalidate(qc),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: string | { id: string; version?: number }) => {
      const { id, version } = typeof value === "string" ? { id: value, version: undefined } : value;
      return api(`/expenses/${id}${version === undefined ? "" : `?version=${version}`}`, { method: "DELETE" });
    },
    // Удаление отвечало «Сохранено» — глагол не тот (аудит 22.08.2026, раунд 6,
    // тот же класс, что «Проверить связь» в раунде 4). Строка исчезает из списка
    // на глазах, так что подтверждение словом здесь и не нужно.
    meta: { successText: "Расход удалён" },
    onSuccess: invalidate(qc),
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    // note допускает null: стёртый комментарий обязан уехать как null, иначе
    // undefined выпадет из JSON и очистка не сохранится.
    mutationFn: ({ id, ...body }: { id: string; version?: number; amount?: number; note?: string | null }) =>
      api(`/expenses/${id}`, { method: "PATCH", body }),
    onSuccess: invalidate(qc),
  });
}

/** Архив — удалённые расходы (мягкое удаление, ничего не пропадает физически). */
export function useExpenseArchive(range: { from?: string; to?: string }, enabled = true) {
  return useQuery({
    queryKey: ["expenses-archive", range],
    queryFn: () => {
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      const qs = params.toString();
      return api<Expense[]>(`/expenses/archive${qs ? `?${qs}` : ""}`);
    },
    enabled,
    // Данные месячные: глобальный опрос раз в 25 секунд гонял бы тяжёлый
    // запрос впустую на каждой открытой вкладке.
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

export function useRestoreExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/expenses/${id}/restore`, { method: "PATCH" }),
    onSuccess: () => {
      invalidate(qc)();
      qc.invalidateQueries({ queryKey: ["expenses-archive"] });
    },
  });
}

export interface ExpenseForecast {
  month: string;
  spentTjs: number;
  projectedTjs: number;
  averageTjs: number;
  overrun: boolean;
}

/** Прогноз «куда идём по темпу месяца» — считает сервер (lib/financeAutomation.ts). */
export function useExpenseForecast() {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["expenses", "forecast"],
    queryFn: () => api<ExpenseForecast>("/expenses/forecast"),
    staleTime: 10 * 60 * 1000,
  });
}

/**
 * ПРОГНОЗ КОМИССИИ К КОНЦУ МЕСЯЦА (GET /finance/forecast).
 *
 * Право у маршрута то же, что у раздела «Финансы» (finance.view), поэтому
 * запрос включается флагом: на пульте блок «Деньги» видит более широкий круг,
 * и без флага у части сотрудников каждая загрузка пульта давала бы 403.
 *
 * Данные месячные и тяжёлые (воронка по всем открытым сделкам) — опрашивать их
 * по таймеру незачем, как и сводку финансов рядом.
 */
export function useCommissionForecast(enabled = true, month?: string) {
  return useQuery({
    queryKey: ["finance-forecast", month ?? "current"],
    queryFn: () => api<CommissionForecast>(`/finance/forecast${month ? `?month=${month}` : ""}`),
    enabled,
    refetchInterval: false as const,
    staleTime: 5 * 60 * 1000,
  });
}

export interface RecurringExpense {
  id: string;
  title: string;
  category: ExpenseCategory;
  amount: string;
  currency: "TJS" | "USD";
  dayOfMonth: number;
  note: string | null;
  active: boolean;
  lastCreatedMonth: string | null;
  /** Канал рекламы (только ADVERTISING) и сотрудник (только SALARY): копируются в
   *  ежемесячный расход. null у шаблонов, заведённых до CRM-07. */
  source?: ClientSource | null;
  agentId?: string | null;
}

export function useRecurringExpenses(enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["expenses", "recurring"],
    queryFn: () => api<RecurringExpense[]>("/expenses/recurring"),
    enabled,
  });
}

export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      title: string;
      amount: number;
      currency: string;
      category: ExpenseCategory;
      dayOfMonth: number;
      note?: string;
      source?: ClientSource;
      agentId?: string;
    }) =>
      api<RecurringExpense>("/expenses/recurring", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["expenses", "recurring"] }),
  });
}

export function useUpdateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Partial<{ title: string; amount: number; dayOfMonth: number; active: boolean; note: string; source: ClientSource; agentId: string }>) =>
      api<RecurringExpense>(`/expenses/recurring/${id}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["expenses", "recurring"] }),
  });
}

export function useDeleteRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(`/expenses/recurring/${id}`, { method: "DELETE" }),
    // «Сохранено» на удалении шаблона — неверный глагол, а последствие тихое:
    // будущие ежемесячные строки больше не создаются (аудит 22.08.2026, раунд 6).
    meta: { successText: "Шаблон удалён — новые строки по нему создаваться не будут" },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["expenses", "recurring"] }),
  });
}

export type PulsePeriod = "today" | "week" | "month" | "year";

export interface PulseBucket {
  period: PulsePeriod;
  label: string;
  incomeTjs: number;
  expenseTjs: number;
  balanceTjs: number;
  previousIncomeTjs: number;
  previousExpenseTjs: number;
  previousBalanceTjs: number;
}

/**
 * Пульс денег. Открытие раздела само освежает автоматические строки на сервере
 * (расходы на ИИ — сразу, сверка с рекламным кабинетом — в фоне, если устарела),
 * поэтому при refreshing перечитываем ответ, пока сверка не закончится.
 */
export function useFinancePulse(enabled = true) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ["expenses", "pulse"],
    queryFn: async () => {
      const data = await api<{ buckets: PulseBucket[]; refreshing: boolean; syncedAt: string | null }>("/expenses/pulse");
      const previous = client.getQueryData<{ buckets: PulseBucket[] }>(["expenses", "pulse"]);
      // This GET upserts automatic AI expenses. An older concurrent summary
      // must not win the race and remain cached beside the newer pulse.
      if (!previous || JSON.stringify(previous.buckets) !== JSON.stringify(data.buckets)) {
        await refreshFinanceReadModels(client);
      }
      return data;
    },
    enabled,
    refetchInterval: (query) => (query.state.data?.refreshing ? 20_000 : false),
  });
}

export async function refreshFinanceReadModels(client: QueryClient) {
  const filters = {
    predicate: (query: { queryKey: readonly unknown[] }) => {
      const [root, part] = query.queryKey;
      return root === "finance-summary" || (root === "expenses" && typeof part === "string"
        && (/^\d{4}-\d{2}$/.test(part) || ["claude-feed", "claude-page", "claude-pivot"].includes(part)));
    },
  };
  await client.cancelQueries(filters);
  await client.invalidateQueries(filters);
}
