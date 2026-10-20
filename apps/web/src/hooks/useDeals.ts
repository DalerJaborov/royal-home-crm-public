import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { ApiError } from "../lib/apiError";
import { withRetryKey, type RetryKey } from "./useRetryKey";
import { OfflineQueuedError } from "../lib/offlineQueue";
import { currentSessionEpoch, rollbackInSameSession } from "../lib/sessionGuard";
import { attachDealVersion, findCachedDeal } from "../lib/dealVersion";
import type { Deal } from "../types";

export function useDeals(filters: { stage?: string; agentId?: string } = {}) {
  const params = new URLSearchParams();
  if (filters.stage) params.set("stage", filters.stage);
  if (filters.agentId) params.set("agentId", filters.agentId);
  const qs = params.toString();

  return useQuery({
    queryKey: ["deals", filters],
    queryFn: () => api<Deal[]>(`/deals${qs ? `?${qs}` : ""}`),
  });
}

/** `retryKey` — см. hooks/useRetryKey.ts: повтор после обрыва не создаёт вторую сделку. */
export function useCreateDeal(retryKey?: RetryKey) {
  const qc = useQueryClient();
  return useMutation({
    // Офлайн создание сделки не теряется: сохраняется в очередь и уйдёт при появлении
    // сети (форма показывает сообщение из OfflineQueuedError). Оптимистичную вставку
    // в доску не делаем — у карточки сделки есть связи (объект/клиент), которых офлайн
    // нет; появится на доске после синка.
    mutationFn: (body: Record<string, unknown>) =>
      withRetryKey(retryKey, (idempotencyKey) => api<Deal>("/deals", { method: "POST", body, queueOffline: true, idempotencyKey })),
    onSuccess: () => invalidateAfterDealChange(qc),
  });
}

/**
 * Сделка меняет далеко не только саму себя: сервер переставляет статус объекта
 * (RESERVED/SOLD/AVAILABLE) и его риелтора, статус клиента (DEAL_CLOSED/HOT),
 * заводит взаимодействие и пересчитывает всю денежную агрегацию. Раньше
 * инвалидировался только ключ "deals", и остальные экраны догонялись лишь
 * 25-секундным поллингом — закрыл сделку, перешёл в «Объекты», а там ещё
 * «В продаже». Сбрасываем всё, что реально зависит от сделки.
 */
export function invalidateAfterDealChange(qc: Pick<ReturnType<typeof useQueryClient>, "invalidateQueries">) {
  for (const key of [
    "deals",
    "properties",
    "property",
    "clients",
    "client",
    "dashboard-summary",
    "counters",
    "finance-summary",
    "finance-forecast",
    "expenses",
    "mission-control",
    "team",
  ]) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/**
 * «Аннулировать» закрытую сделку (C10, 02.10.2026) — POST /deals/:id/annul с
 * причиной. Не офлайн: это решение руководства с последствиями для денег и
 * объекта, его подтверждает ответ сервера, а не очередь.
 */
export function useAnnulDeal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api<{ id: string; stage: string; propertyReturnedToSale: boolean }>(`/deals/${id}/annul`, {
        method: "POST",
        body: { reason },
      }),
    meta: { silent: true },
    onSuccess: () => invalidateAfterDealChange(qc),
  });
}

export function useUpdateDeal() {
  const qc = useQueryClient();
  return useMutation({
    // ЗАМОК ВЕРСИИ (24.09.2026, ночная проверка, круг «Сайт: кэш и мутации»,
    // находка 2): сервер пишет условно и отвечает 409, только если версия
    // ЕСТЬ в теле — канбан и форма сделки её не слали, и запоздалый офлайн-
    // PATCH тихо перезаписывал более новое состояние сделки. Берём версию
    // из уже загруженной сделки в кэше ["deals"] и кладём в тело сами —
    // вызывающему коду (Deals.tsx) ничего передавать не нужно.
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => {
      const cached = qc.getQueriesData<Deal[]>({ queryKey: ["deals"] }).map(([, data]) => data);
      const deal = findCachedDeal(cached, id);
      return api<Deal>(`/deals/${id}`, { method: "PATCH", body: attachDealVersion(body, deal), queueOffline: true });
    },
    // silent: у смены этапа своя обратная связь — карточка перелетает в колонку
    // (успех) и своя же именная плашка с «Понятно» прямо на доске (отказ, см.
    // Deals.tsx::banners). Общий тост поверх них не добавлял ничего, кроме
    // дубля одного и того же текста двумя разными способами одновременно
    // (найдено при аудите 22.08.2026 — «сообщение об ошибке показывалось дважды»).
    meta: { silent: true },
    // Перетаскивание по этапам работает офлайн: карточку двигаем в кэше сразу,
    // PATCH уходит в очередь и досылается при появлении сети.
    onMutate: async ({ id, body }) => {
      await qc.cancelQueries({ queryKey: ["deals"] });
      const prev = qc.getQueriesData<Deal[]>({ queryKey: ["deals"] });
      qc.setQueriesData<Deal[]>({ queryKey: ["deals"] }, (old) =>
        old?.map((d) => (d.id === id ? ({ ...d, ...body } as Deal) : d))
      );
      return { prev, epoch: currentSessionEpoch() };
    },
    onError: (err, _vars, ctx) => {
      // 409 замка версии: сделку изменили без нас, поэтому снимок `prev` из
      // onMutate тоже устарел — откат к нему вернул бы то же старое состояние
      // поверх свежего. Вместо отката перечитываем сделки с сервера; текст
      // ошибки сервера человек видит через updateDeal.error в баннере
      // (Deals.tsx::banners), он остаётся и без отката.
      if (err instanceof ApiError && err.status === 409) {
        void qc.invalidateQueries({ queryKey: ["deals"] });
        return;
      }
      // Обычная ошибка — откат; офлайн-очередь оставляем (досошлётся сама).
      // И только в своей сессии: после выхода/входа кэш уже чужой (WEB-01).
      if (!(err instanceof OfflineQueuedError)) {
        rollbackInSameSession(ctx?.epoch, () => ctx?.prev?.forEach(([key, data]) => qc.setQueryData(key, data)));
      }
    },
    // Знак ИИ радуется закрытой сделке. Отдельного `useCloseDeal` в проекте
    // нет — закрытие это PATCH этапа, поэтому повод узнаём из аргументов
    // мутации: сервер возвращает сделку целиком, но именно ПЕРЕХОД в
    // COMPLETED (а не «она и так была закрыта») виден только здесь.
    onSuccess: () => {
      invalidateAfterDealChange(qc);
    },
  });
}
