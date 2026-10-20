import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { mergeMeCache } from "../lib/meCache";
import { useAuthStore } from "../store/auth";
import { useActiveCall } from "./useActiveCall";
import type { ClientKind, MontageCopiesUpdate, PropertyType, OwnerQuestionView } from "@royal-home/shared";

import type { MyProfile } from "../lib/meProfile";
export type { MyProfile } from "../lib/meProfile";

/**
 * Как быстро у сотрудника обновляются СВОИ права после того, как руководитель их
 * поменял (ночная проверка 01.10.2026, №251). Правящий гасит ["me"] только у себя
 * (AgentPermissionsModal), а у самого сотрудника кэш жил до пяти минут — он видел
 * кнопки, на которые сервер отвечал 403. Живого события `agent.updated` с адресатом
 * в общем пакете пока нет (его добавление требует правки packages/shared), поэтому
 * кэш профиля делаем коротким и обновляем при возврате на вкладку: пока не придёт
 * событие, права догоняют не дольше минуты после того, как человек посмотрел на экран.
 * Сервер права проверяет заново на каждый запрос — защита не страдает, только вид.
 */
export const ME_STALE_MS = 60 * 1000;

export function useMyProfile() {
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api<MyProfile>("/me"),
    staleTime: ME_STALE_MS,
    // Без своего refetchInterval унаследовал бы общий 60с (queryClient.ts); пять минут —
    // фоновая страховка, а основной путь обновления — возврат на вкладку (ниже).
    refetchInterval: 5 * 60 * 1000,
    // С staleTime в минуту фокус дёргает GET /me не чаще раза в минуту.
    refetchOnWindowFocus: true,
  });
}

export function useUpdateMyProfile() {
  const qc = useQueryClient();
  const updateAgent = useAuthStore((s) => s.updateAgent);
  return useMutation({
    mutationFn: (body: Record<string, unknown>) => api<MyProfile>("/me", { method: "PATCH", body }),
    onSuccess: (data) => {
      updateAgent({ fullName: data.fullName, phone: data.phone, avatarUrl: data.avatarUrl });
      qc.setQueryData<MyProfile>(["me"], (old) => mergeMeCache(old, data));
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/** Заводит одноразовый код и (если известно имя бота) готовую ссылку
 *  t.me/<бот>?start=<код> — сама привязка происходит переходом по ней/отправкой
 *  кода боту, не этим запросом. */
export function useCreateTelegramLink() {
  return useMutation({
    mutationFn: () => api<{ code: string; deepLink: string | null }>("/me/telegram-link", { method: "POST" }),
  });
}

export function useUnlinkTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: true }>("/me/telegram-unlink", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

/** «Копии монтажа в Telegram» — PATCH /me/montage-copies. */
export function useUpdateMontageCopies() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MontageCopiesUpdate) =>
      api<{ montageCopiesTelegram: boolean; telegramLinked: boolean }>("/me/montage-copies", { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

/** Включать копии монтажа может только руководство — та же проверка, что на сервере. */
export function canReceiveMontageCopies(role: string | undefined): boolean {
  return role === "ADMIN" || role === "DIRECTOR";
}

/** Тумблер «модерация в Telegram» — только у кого есть право properties.moderate. */
export function useSetTelegramModeration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ telegramModeration: boolean }>("/me/telegram-moderation", { method: "PATCH", body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

/** Тумблер «готовые ролики на проверку в Telegram» — тот же приём, что у
 *  useSetTelegramModeration, свой роут (PATCH /me/clip-review-telegram). */
export function useSetClipReviewTelegram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      api<{ clipReviewTelegram: boolean }>("/me/clip-review-telegram", { method: "PATCH", body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useUploadMyAvatar() {
  const qc = useQueryClient();
  const updateAgent = useAuthStore((s) => s.updateAgent);
  return useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("avatar", file);
      return api<MyProfile>("/me/avatar", { method: "POST", body: form, isForm: true });
    },
    onSuccess: (data) => {
      updateAgent({ avatarUrl: data.avatarUrl });
      qc.setQueryData<MyProfile>(["me"], (old) => mergeMeCache(old, data));
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}

/**
 * «Не принимаю лиды» — агент сам выходит из распределения на несколько часов.
 *
 * Срок обрезается потолком на сервере: человек просит «на неделю», получает
 * максимум и видит, до какого момента. KPI при этом идёт как обычно.
 */
export function usePauseLeads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hours: number) =>
      api<{ ok: boolean; pausedUntil: string; maxHours: number }>("/me/lead-pause", {
        method: "POST",
        body: { hours },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

export function useResumeLeads() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ ok: boolean }>("/me/lead-pause", { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me"] }),
  });
}

/**
 * ОБЯЗАТЕЛЬНЫЕ ОКНА УДАЛЕНЫ 13.09.2026 (владелец: «вообще убери»).
 *
 * Здесь жили `PendingSummary`, `usePendingSummaries`, снятие/закрытие/заполнение
 * требования и `useRecordCall`. Механизм и так стоял на паузе рубильником с
 * 08.09.2026 — окна не показывались, лиды из-за них не задерживались, — то есть
 * удалено мёртвое тело, а не работающее правило.
 *
 * Чем заменено: ничем, и это осознанно. Записать разговор, показ или встречу
 * задним числом можно обычной формой взаимодействия на карточке клиента —
 * тем же путём, которым это делали всегда, только без принуждения.
 */
/** Вопрос, который бот пообещал клиенту уточнить у собственника. */
export type OwnerQuestion = OwnerQuestionView;

export function useOwnerQuestions(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["owner-questions"],
    queryFn: () => api<{ items: OwnerQuestion[] }>("/me/owner-questions"),
    refetchInterval: 60_000,
    // Та же причина, что у usePendingSummaries: баннер перемонтируется на каждом
    // переходе между разделами.
    staleTime: 55_000,
    enabled: options?.enabled ?? true,
  });
}

export interface ScoreMonthStats {
  points: number;
  acceptedClients: number;
  showings: number;
  deals: number;
  monthStart: string;
}

export interface ScoreMonthsView {
  current: ScoreMonthStats;
  previous: ScoreMonthStats;
  pointsDiff: number;
}

/** «Вы против себя» на главной агента — очки и показатели этого месяца против
 *  прошлого, GET /me/score-months. Сравнение с собой, не с коллегами: мест и
 *  очков других агентов этот запрос не отдаёт. */
export function useMyScoreMonths() {
  return useQuery({
    queryKey: ["me", "score-months"],
    queryFn: () => api<ScoreMonthsView>("/me/score-months"),
  });
}

/** Ответ уходит клиенту сам — сотрудник ничего не пересылает руками. */
export function useAnswerOwnerQuestion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, answer, expectedRevision }: { id: string; answer: string; expectedRevision?: string }) =>
      api<{ ok: boolean; delivered: boolean; message: string; managedRevision?: string; deliveryStatus?: string }>(`/me/owner-questions/${id}/answer`, {
        method: "POST",
        body: { answer, ...(expectedRevision ? { expectedRevision } : {}) },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["owner-questions"] }),
    onError: () => { void qc.invalidateQueries({ queryKey: ["owner-questions"] }); },
  });
}
