import { useQuery } from "@tanstack/react-query";
import type { AbsenceKind, ClientStatus, Role } from "@royal-home/shared";
import { api } from "../lib/api";

export interface TeamMember {
  id: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  avatarUrl: string | null;
  lastSeenAt: string | null;
  online: boolean;
  frozen: boolean;
  frozenAt: string | null;
  /** Вид и срок отсутствия (владелец 09.09.2026). Пусто у прежней экстренной
   *  заморозки «для разбирательства» — она виду не соответствует. */
  absenceKind?: AbsenceKind | null;
  absenceUntil?: string | null;
  frozenReason: string | null;
  frozenReasonVoiceUrl?: string | null;
  frozenReasonVoiceTranscript?: string | null;
  /** Пауза приёма лидов (24.09.2026): до какого момента, кто поставил (null —
   *  сам сотрудник) и причина. Истёкшая пауза приходит как null. */
  leadsPausedUntil?: string | null;
  leadsPausedByName?: string | null;
  leadsPausedReason?: string | null;
  /** Личные выходные (11.10.2026), 0 — воскресенье. Пусто — работает каждый день. */
  weeklyDaysOff?: number[];
  points: number;
  /** Активные покупатели в работе прямо сейчас — тот же счётчик, что запирает раздачу. */
  activeLoad: number;
  /** Общий предел портфеля из Настроек; 0 = без лимита. */
  leadLimit: number;
  month: {
    leads: number;
    interactions: number;
    showings: number;
    dealsCompleted: number;
    /** null — у смотрящего нет finance.view (ночная проверка 24.09.2026, №159/М4). */
    commission: number | null;
    conversion: number | null;
    avgAcceptMinutes: number | null;
  };
}

export function useTeam(enabled = true) {
  return useQuery({
    queryKey: ["team"],
    queryFn: () => api<TeamMember[]>("/team"),
    enabled,
    // «Онлайн» живёт 3 минуты — обновляем список, пока экран открыт. Присутствие
    // сотрудника меняется само собой, без действия в CRM, поэтому таймер здесь
    // остаётся ОСНОВНЫМ путём: серверного сигнала «агент ушёл офлайн» нет.
    refetchInterval: 60_000,
  });
}

/** Ответ GET /team/stages — экран «Команда по этапам» (антифрод, мозговой штурм
 *  владельца 20-21.08.2026): снимок портфеля каждого агента прямо сейчас, не за
 *  месяц, как остальная карточка команды. */
export interface TeamStagesAgent {
  id: string;
  byStatus: Partial<Record<ClientStatus, number>>;
  showingsScheduled: number;
  dealsInProgress: number;
}

export interface TeamStages {
  statuses: ClientStatus[];
  agents: TeamStagesAgent[];
}

export function useTeamStages(enabled = true) {
  return useQuery({
    queryKey: ["team", "stages"],
    queryFn: () => api<TeamStages>("/team/stages"),
    enabled,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ (13.09.2026). Свежесть держит поток событий
    // (lib/liveEvents.ts), таймер оставлен на случай, когда поток не дошёл.
    refetchInterval: 300_000,
  });
}
