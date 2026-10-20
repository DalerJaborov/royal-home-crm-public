import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatePropertyChangeRequestInput, PropertyChangeRequestDto } from "@royal-home/shared";
import { api } from "../lib/api";

/**
 * Заявки агента на изменение опубликованного объекта (07.10.2026) — то же устройство,
 * что заявки на удаление объекта (useDeleteRequests.ts): очередь руководства живёт
 * отдельно от карточки, свежесть держит поток событий (lib/liveEvents.ts).
 * Контракт — packages/shared/src/propertyChangeRequest.ts.
 */

const KEY = "property-change-requests";

/** Заявки по одному объекту: автору — его собственные, директору и админу — все. */
export function usePropertyChangeRequests(propertyId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [KEY, "property", propertyId],
    queryFn: () => api<{ items: PropertyChangeRequestDto[] }>(`/properties/${propertyId}/change-requests`),
    enabled: enabled && !!propertyId,
  });
}

/** Входящие руководства: заявки, ждущие решения, по всем объектам (право properties.delete). */
export function usePendingPropertyChangeRequests(enabled = true) {
  return useQuery({
    queryKey: [KEY, "inbox", "PENDING"],
    queryFn: () =>
      api<{ items: PropertyChangeRequestDto[]; nextCursor: string | null }>(
        "/properties/change-requests?status=PENDING&limit=50"
      ),
    enabled,
    staleTime: 60_000,
    // ЗАПАСНОЙ ПУТЬ, А НЕ ОСНОВНОЙ: свежесть держит поток событий, таймер — на случай,
    // когда поток не дошёл (тот же приём, что у usePropertyDeleteRequests).
    refetchInterval: 300_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: [KEY] });
    // Принятая заявка меняет саму карточку (цена, данные, статус ролика) и её списки.
    qc.invalidateQueries({ queryKey: ["property"] });
    qc.invalidateQueries({ queryKey: ["properties"] });
  };
}

export function useCreatePropertyChangeRequest(propertyId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    // Ключ повтора держит форма до успеха: двойное нажатие «Отправить» не заведёт две заявки.
    mutationFn: (vars: { body: CreatePropertyChangeRequestInput; idempotencyKey: string }) =>
      api<{ request: PropertyChangeRequestDto }>(`/properties/${propertyId}/change-requests`, {
        method: "POST",
        body: vars.body,
        idempotencyKey: vars.idempotencyKey,
      }),
    // silent: форма сама показывает результат — общий тост дублировал бы его.
    meta: { silent: true },
    onSuccess: invalidate,
  });
}

export function useApprovePropertyChangeRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; note?: string }) =>
      api<{ request: PropertyChangeRequestDto }>(`/properties/change-requests/${vars.id}/approve`, {
        method: "POST",
        body: { note: vars.note },
      }),
    // Итог (в том числе «Не выполнилось») показывает сама карточка заявки.
    meta: { silent: true },
    onSuccess: invalidate,
  });
}

export function useRejectPropertyChangeRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string; note: string }) =>
      api<{ request: PropertyChangeRequestDto }>(`/properties/change-requests/${vars.id}/reject`, {
        method: "POST",
        body: { note: vars.note },
      }),
    meta: { silent: true },
    onSuccess: invalidate,
  });
}

export function useCancelPropertyChangeRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (vars: { id: string }) =>
      api<{ request: PropertyChangeRequestDto }>(`/properties/change-requests/${vars.id}/cancel`, { method: "POST" }),
    meta: { silent: true },
    onSuccess: invalidate,
  });
}
