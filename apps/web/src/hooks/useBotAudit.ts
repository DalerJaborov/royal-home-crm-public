import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/**
 * Аудит бота — судья вычитывает недавние переписки против реальных правил бота
 * (apps/api/src/ai/botAudit.ts). Раньше жил в BotAuditSection.tsx собственным
 * useState/useEffect — перенесён на TanStack Query (17.09.2026, страницы по
 * группам + честный чип «в промте» потребовали делить данные между
 * BotAuditSection и плитками AiLearning.tsx, а держать это в двух местах
 * копией — заводить именно ту рассинхронизацию, от которой в репозитории уже
 * есть отдельное правило «один источник правды»).
 */
export interface AuditRunSummary {
  conversationsChecked: number;
  findingsCreated: number;
}

export interface AuditFinding {
  id: string;
  type: string;
  quote: string;
  why: string;
  severity: string;
  createdAt: string;
}

export interface AuditGroup {
  /** Ключ группы с сервера (type + начало why) — по нему общий
   *  useAccumulatedPages склеивает группу, попавшую в две порции «Показать ещё». */
  id: string;
  type: string;
  why: string;
  severity: string;
  count: number;
  examples: AuditFinding[];
}

export interface AuditList {
  total: number;
  /** Сколько находок висит неразобранными и сколько уже закрыто — по ВСЕЙ таблице. */
  unresolvedTotal: number;
  resolvedTotal: number;
  groups: AuditGroup[];
  /** Сколько РАЗНЫХ групп всего (обычно на порядок меньше unresolvedTotal). */
  groupsTotal: number;
  /** Смещение для следующей порции групп — «Показать ещё». null — дальше нет. */
  groupsNextOffset: number | null;
}

export function useBotAuditList() {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["bot-audit"],
    queryFn: () => api<AuditList>("/bot-audit"),
  });
}

/** Следующая порция ГРУПП (17.09.2026, «страницы по группам»). Отдельная
 *  функция, не второй useQuery — тот же приём, что у loadMoreBotLessons: копит
 *  сам компонент через useAccumulatedPages, ключ кэша группам не нужен. */
export function loadMoreAuditGroups(offset: number) {
  return api<AuditList>(`/bot-audit?groupsOffset=${offset}`);
}

export interface GroupExamplesPage {
  items: AuditFinding[];
  nextCursor: string | null;
}

/** «Ещё цитат» внутри уже раскрытой группы — группа несёт только первые три
 *  примера, остальное по требованию. */
export function loadMoreGroupExamples(type: string, why: string, cursor: string | null) {
  const params = new URLSearchParams({ type, why });
  if (cursor) params.set("cursor", cursor);
  return api<GroupExamplesPage>(`/bot-audit/group-examples?${params.toString()}`);
}

export function useRunBotAudit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<AuditRunSummary>("/bot-audit/run", { method: "POST", body: {} }),
    onSuccess: (res) => {
      // Список тянем заново только когда есть что показать: пустая проверка
      // ничего не меняет, а лишний запрос мигает списком под кнопкой.
      if (res.findingsCreated > 0) qc.invalidateQueries({ queryKey: ["bot-audit"] });
    },
  });
}

/** Вердикт по ОДНОЙ находке — старое поведение «Разобрался» без вердикта живёт
 *  здесь же (verdict необязателен). */
export function useResolveAuditFinding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, verdict }: { id: string; verdict?: "bot_right" | "bot_error" }) =>
      api(`/bot-audit/${id}/resolve`, { method: "POST", body: verdict ? { verdict } : {} }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-audit"] }),
  });
}

/**
 * Вердикт на ВСЮ группу разом (17.09.2026: «действия на всю группу», «Бот
 * ошибся — учесть» заводит ОДИН урок на группу, «Бот прав» закрывает все и
 * группа больше не всплывает у судьи заново — см. lib/botAuditGroups.ts).
 */
export function useResolveAuditGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ type, why, verdict }: { type: string; why: string; verdict: "bot_right" | "bot_error" }) =>
      api<{ resolved: number; lessonCreated: boolean }>("/bot-audit/group/resolve", {
        method: "POST",
        body: { type, why, verdict },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-audit"] }),
  });
}

export function useResolveAllAuditFindings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ resolved: number }>("/bot-audit/resolve-all", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["bot-audit"] }),
  });
}
