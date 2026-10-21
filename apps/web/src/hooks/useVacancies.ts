import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";
import { useAuthStore } from "../store/auth";
import { vacancyFiltersQuery } from "../lib/vacancyFilters";
import type { VacancyFilters, VacanciesResponse, VacancyConversation, VacancyPatch, VacancyPatchResponse } from "../types/vacancies";
export type { JobApplication, VacancyConversation, VacancyPatch, VacancyPatchResponse, VacanciesResponse,
  VacancyPriorityFilter, VacancyStage, VacancyBucket, VacancyFilters } from "../types/vacancies";

export function useVacancies(enabled = true, filters: VacancyFilters = {}) {
  const actor = useAuthStore(s => s.agent?.id);
  const epoch = useAuthStore(s => s.sessionEpoch);
  const qs = vacancyFiltersQuery(filters);
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["vacancies", actor, epoch, qs],
    queryFn: () => api<VacanciesResponse>(`/vacancies${qs ? `?${qs}` : ""}`, { expectAgentId: actor }),
    enabled,
    // Очередь разбирают руководитель и админ параллельно — освежаем по фокусу вкладки.
    refetchOnWindowFocus: true,
    // A different search/filter must never expose the previous candidate's actions.
  });
}

/**
 * Переписка одной анкеты. Отдельным запросом и только когда карточка раскрыта:
 * тянуть тексты всех диалогов ради списка — это секунды ожидания и лишние
 * мегабайты на каждом открытии раздела.
 */
export function useVacancyConversation(id: string | null) {
  const actor = useAuthStore(s => s.agent?.id);
  const epoch = useAuthStore(s => s.sessionEpoch);
  return useQuery({
    queryKey: ["vacancy-conversation", actor, epoch, id],
    queryFn: () => api<VacancyConversation>(`/vacancies/${id}/conversation`, { expectAgentId: actor }),
    enabled: !!id,
    // Переписка кандидата за время разбора анкеты не меняется — лишние
    // перезапросы при каждом возврате во вкладку тут ни к чему.
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

/** Смена стадии и/или полей воронки (дата собеседования, заметка, причина
 *  отказа, кадровый резерв) — одной ручкой, как их и принимает PATCH на бэке. */
export function useSetVacancyStatus() {
  const qc = useQueryClient();
  const actor = useAuthStore(s => s.agent?.id);
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & VacancyPatch) =>
      api<VacancyPatchResponse>(`/vacancies/${id}`, { method: "PATCH", body: patch, expectAgentId: actor }),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: ["vacancies"] }),
      qc.invalidateQueries({ queryKey: ["vacancy-contact-options"] }),
    ]),
  });
}

/** Звонок кандидату через станцию (POST /vacancies/:id/call, 29.09.2026): сначала
 *  звонит трубка сотрудника, потом АТС набирает кандидата — не личный телефон. */
export function useCallCandidate(applicationId: string) {
  const actor = useAuthStore(s => s.agent?.id);
  return useMutation({
    mutationFn: () => api<{ ok: true; channelId?: string }>(`/vacancies/${applicationId}/call`, { method: "POST", expectAgentId: actor }),
    meta: { silent: true },
  });
}

/** Запись последнего разговора робота с кандидатом — ссылка на 10 минут,
 *  запрашивается заново на каждое нажатие (как записи живого голоса в Настройках). */
export function useInviteCallRecordingUrl() {
  const actor = useAuthStore(s => s.agent?.id);
  return useMutation({
    mutationFn: (applicationId: string) => api<{ url: string }>(`/vacancies/${applicationId}/invite-call-recording`, { expectAgentId: actor }),
    meta: { silent: true },
  });
}
