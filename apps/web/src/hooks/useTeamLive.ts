import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface TeamLiveAgent {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  /** Активная нагрузка: лиды в работе (NEW/CONTACTED/HOT/COLD). */
  activeLoad: number;
  /** Назначено, но ещё не принято агентом. */
  pendingAccept: number;
  /** Принято сегодня. */
  acceptedToday: number;
  /** Эскалировано у него (никто не принял за N кругов). */
  escalated: number;
}

export interface UnacceptedLead {
  shortId: number;
  fullName: string;
  agentName: string;
  reassignCount: number;
  escalated: boolean;
  /** Предел передач исчерпан — статус «Потерянный», дальше не распределяется автоматически. */
  lost: boolean;
  waitingMinutes: number;
}

export interface TeamLive {
  agents: TeamLiveAgent[];
  /** Список ограничен 12 записями — для счётчиков берите поля ниже. */
  unaccepted: UnacceptedLead[];
  /** Реально пропущено: лид назначен агенту, но тот его не принял. Не включает лиды, ждущие раздачи волной в 10:00. */
  unacceptedTotal: number;
  escalatedTotal: number;
  /** Лиды без назначенного агента — копятся для раздачи волной, это штатное состояние, не пропуск. */
  queuedTotal: number;
}

/** Живая сводка по команде — обновляется чаще (30 с), чтобы отслеживать в реальном времени. */
export function useTeamLive(enabled = true) {
  return useQuery({
    queryKey: ["dashboard-team-live"],
    queryFn: () => api<TeamLive>("/dashboard/team-live"),
    enabled,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
    staleTime: 15_000,
  });
}
