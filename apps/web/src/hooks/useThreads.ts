import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Threads (Meta), 23.09.2026 — тот же приём, что useTikTok.ts: кнопка
 * «Подключить» уходит на адрес окна Threads и возвращается на
 * /settings?tab=channels с результатом в query, кнопка «Отключить» — обычный
 * POST. Ручной публикации (в отличие от TikTok) нет — договор задания не
 * просил демо-кнопку, у Threads нет требования ревью с обязательным тестовым
 * постом.
 */

export function useConnectThreads() {
  return useMutation({
    mutationFn: () => api<{ url: string }>("/threads/oauth/start"),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
}

export function useDisconnectThreads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/threads/disconnect", { method: "POST", body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["threads", "profile"] });
    },
  });
}

export interface ThreadsProfile {
  connected: boolean;
  username?: string | null;
  avatarUrl?: string | null;
  connectedAt?: string | null;
  tokenExpiresAt?: string | null;
  error?: string;
}

/** Живой профиль — кэш 60с уже на сервере, здесь обычный опрос. */
export function useThreadsProfile(enabled = true) {
  return useQuery({
    queryKey: ["threads", "profile"],
    queryFn: () => api<ThreadsProfile>("/threads/profile"),
    enabled,
  });
}
