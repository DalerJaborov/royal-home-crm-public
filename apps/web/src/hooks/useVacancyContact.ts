import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecruitmentContactOptions, RecruitmentContactPreview, RecruitmentContactPreviewInput, RecruitmentContactConfirmation, RecruitmentContactConfirmInput } from "@royal-home/shared";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";

export function useVacancyContactOptions(id: string, enabled = true) {
  const actor = useAuthStore(s => s.agent?.id), epoch = useAuthStore(s => s.sessionEpoch);
  return useQuery({ queryKey: ["vacancy-contact-options", actor, epoch, id],
    queryFn: () => api<RecruitmentContactOptions>(`/vacancies/${encodeURIComponent(id)}/contact-options`, { expectAgentId: actor }),
    enabled, staleTime: 10_000, refetchOnWindowFocus: true });
}

export function usePreviewVacancyContact(id: string) {
  const actor = useAuthStore(s => s.agent?.id);
  return useMutation({ mutationFn: (body: RecruitmentContactPreviewInput) =>
    api<RecruitmentContactPreview>(`/vacancies/${encodeURIComponent(id)}/invitations/preview`, { method: "POST", body, expectAgentId: actor }), retry: false });
}

export function useConfirmVacancyContact(id: string) {
  const actor = useAuthStore(s => s.agent?.id), cache = useQueryClient();
  return useMutation({ mutationFn: (body: RecruitmentContactConfirmInput) =>
    api<RecruitmentContactConfirmation>(`/vacancies/${encodeURIComponent(id)}/invitations`, { method: "POST", body, expectAgentId: actor }), retry: false,
    onSettled: () => Promise.all([cache.invalidateQueries({ queryKey: ["vacancy-contact-options"] }), cache.invalidateQueries({ queryKey: ["vacancies"] })]) });
}
