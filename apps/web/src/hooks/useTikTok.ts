import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * TikTok Content Posting API (17.09.2026) — те же два приёма, что useAds.ts
 * (useConnectAds/useDisconnectAds): кнопка «Подключить» уходит на адрес окна
 * TikTok и возвращается на /settings?tab=channels с результатом в query, кнопка
 * «Отключить» — обычный POST. Отличие от ads: адрес выдаёт GET (routes/tiktok.ts),
 * а не POST — сама TikTok-ручка ничего не создаёт и не помнит между вызовами
 * (state подписан HMAC, а не хранится в памяти сервера), так что метод честно GET.
 */

export function useConnectTikTok() {
  return useMutation({
    mutationFn: () => api<{ url: string }>("/tiktok/oauth/start"),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
}

export function useDisconnectTikTok() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/tiktok/disconnect", { method: "POST", body: {} }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["tiktok", "creator-info"] });
    },
  });
}

export interface TikTokCreatorInfo {
  connected: boolean;
  username?: string | null;
  nickname?: string | null;
  avatarUrl?: string | null;
  connectedAt?: string | null;
  privacyLevelOptions?: string[];
  commentDisabled?: boolean;
  duetDisabled?: boolean;
  stitchDisabled?: boolean;
  maxVideoPostDurationSec?: number;
  error?: string;
}

/** Живой список privacy_level_options и рубильников аккаунта — кэш 60с уже на
 *  сервере (лимит TikTok 20 запросов/мин на токен), здесь обычный опрос. */
export function useTikTokCreatorInfo(enabled = true) {
  return useQuery({
    queryKey: ["tiktok", "creator-info"],
    queryFn: () => api<TikTokCreatorInfo>("/tiktok/creator-info"),
    enabled,
  });
}

export interface TikTokPublishResult {
  ok: boolean;
  note?: string;
  error?: string;
}

/**
 * Ручная публикация готового ролика объекта в TikTok (17.09.2026, карточка
 * объекта) — POST /properties/:id/tiktok-publish (routes/properties/videos.ts).
 * Для демо-видео на ревью приложения TikTok (нужен реальный клик в интерфейсе)
 * и повторной отправки, когда объект уже опубликован в остальных каналах.
 * Инвалидирует карточку объекта — publishedChannels меняется на сервере.
 */
export function useTikTokManualPublish(propertyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<TikTokPublishResult>(`/properties/${propertyId}/tiktok-publish`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["properties"] });
      qc.invalidateQueries({ queryKey: ["property"] });
    },
  });
}
