import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { keepWhilePagingAt } from "../lib/keepWhilePaging";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

export interface SiteEditNotification {
  id: string;
  propertyId: string;
  action: "CREATED" | "UPDATED" | "DELETED";
  changes: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
  resolution: "ACCEPTED" | "REJECTED" | null;
  property: { id: string; shortId: number; title: string; publishedOnSite: boolean };
}

/** Ответ сервера — одна страница списка и `total`, честное число ВСЕХ
 *  неразобранных: без него бейдж/счётчик молчат о старых уведомлениях за
 *  пределами страницы (см. routes/siteNotifications.ts GET /). */
export interface SiteNotificationsResponse {
  items: SiteEditNotification[];
  total: number;
  page: number;
  pageSize: number;
}

/** Размер страницы «Изменений с сайта». Бейджи меню зовут хук без страницы и
 *  попадают в тот же ключ, что первая страница экрана, — один запрос на двоих. */
export const SITE_NOTIFICATIONS_PAGE_SIZE = 50;

export function useSiteNotifications(options?: { enabled?: boolean; page?: number }) {
  const page = options?.page ?? 1;
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["site-notifications", page, SITE_NOTIFICATIONS_PAGE_SIZE],
    placeholderData: keepWhilePagingAt<SiteNotificationsResponse>(["site-notifications", page, SITE_NOTIFICATIONS_PAGE_SIZE], 1),
    queryFn: () =>
      api<SiteNotificationsResponse>(`/site-notifications?page=${page}&pageSize=${SITE_NOTIFICATIONS_PAGE_SIZE}`),
    enabled: options?.enabled ?? true,
  });
}

export function useResolveSiteNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolution }: { id: string; resolution: "ACCEPTED" | "REJECTED" }) =>
      api(`/site-notifications/${id}/resolve`, { method: "POST", body: { resolution } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["site-notifications"] }),
  });
}

/** «Разобрать все» — принимает непросмотренные правки сайта как есть одним
 *  решением (тот же приём, что useResolveAllSystemErrors в useMissionControl.ts). */
export function useResolveAllSiteNotifications() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<{ queued: number; remaining: number }>("/site-notifications/resolve-all", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["site-notifications"] }),
  });
}
