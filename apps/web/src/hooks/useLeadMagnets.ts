import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LeadMagnetCampaign, LeadMagnetCampaignInput, LeadMagnetDelivery } from "@royal-home/shared";
import { api } from "../lib/api";
import type { Paginated } from "../types";

/**
 * Кампании воронки «комментарий → чек-лист в директ».
 *
 * Закрыты правом настроек: кампания решает, что CRM напишет постороннему человеку
 * от имени компании. Сервер — routes/leadMagnets.ts, автомат — lib/leadMagnet.ts.
 */

/** Кампания вместе с публичным адресом файла: им владелец проверяет, что файл
 *  вообще открывается снаружи. null — адрес CRM не настроен, и Meta файл не
 *  заберёт; вкладка обязана сказать это до запуска рекламы, а не после. */
export type LeadMagnetCampaignRow = LeadMagnetCampaign & {
  fileUrl: string | null;
  /**
   * Два поля проверки подписки (30.08.2026). Сервер их и хранит, и принимает
   * (`leadMagnetCampaignInputSchema`), и отдаёт, но в описании ответа
   * `LeadMagnetCampaign` их пока нет — дописаны здесь необязательными, чтобы форма
   * читала настоящее значение, а не подставляла «выключено» каждой кампании.
   * Когда поля появятся в `@royal-home/shared`, эти две строки нужно убрать.
   */
  requireFollowAll?: boolean;
  deliverOnSecondClaim?: boolean;
};

export function useLeadMagnets(enabled = true) {
  return useQuery<LeadMagnetCampaignRow[]>({
    queryKey: ["lead-magnets"],
    queryFn: () => api("/lead-magnets"),
    enabled,
  });
}

export function useCreateLeadMagnet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadMagnetCampaignInput) =>
      api<LeadMagnetCampaignRow>("/lead-magnets", { method: "POST", body: input }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-magnets"] }),
  });
}

/**
 * `silent` — только для формы редактора кампании (settings/FunnelEditor.tsx): она
 * сама рисует отказ через <MutationError>, и общий тост повторял его вторым
 * сообщением.
 *
 * ПО УМОЛЧАНИЮ ТОСТ ОСТАЁТСЯ, и это не недоделка: тем же хуком переключается
 * тумблер «кампания включена» в списке (settings/FunnelTab.tsx и
 * mobile/MobileFunnel.tsx), а у тумблера тост — ЕДИНСТВЕННОЕ подтверждение, что
 * переключение сохранилось. Глухое заглушение вернуло бы жалобу «нажал и не понял,
 * сохранилось ли» (тот же разбор, что у useUpdateSettings в раунде 4).
 */
export function useUpdateLeadMagnet(options?: { silent?: boolean }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: LeadMagnetCampaignInput & { id: string }) =>
      api<LeadMagnetCampaignRow>(`/lead-magnets/${id}`, { method: "PATCH", body: input }),
    meta: options?.silent ? { silent: true } : undefined,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-magnets"] }),
  });
}

/**
 * Тумблер «включена/выключена»: шлёт ТОЛЬКО `enabled` на отдельный маршрут.
 * Раньше он отправлял в PATCH весь снимок кампании, и устаревший снимок откатывал
 * тексты и адреса, сохранённые другим оператором (аудит 04.10.2026, WEB-PAGES13).
 * НЕ silent: общий тост остаётся единственным подтверждением успеха тумблера.
 */
export function useToggleLeadMagnetEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api<LeadMagnetCampaignRow>(`/lead-magnets/${id}/enabled`, { method: "PATCH", body: { enabled } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-magnets"] }),
  });
}

/**
 * Дублировать кампанию — целиком, вместе с PDF (см. POST /lead-magnets/:id/duplicate).
 *
 * Копирует СЕРВЕР, а не форма: файл лежит на диске, и «скопировать» его в браузере
 * можно было бы только заставив владельца приложить PDF заново — то самое «одно и
 * то же дважды», ради ухода от которого кнопка и появилась. Копия приходит
 * выключенной; включает её владелец сам, поменяв публикацию.
 */
export function useDuplicateLeadMagnet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<LeadMagnetCampaignRow>(`/lead-magnets/${id}/duplicate`, { method: "POST" }),
    // silent: оба вызывающих (settings/FunnelTab.tsx и mobile/MobileFunnel.tsx)
    // рисуют отказ через <MutationError mutation={duplicate}>, а на успехе сразу
    // открывают редактор с копией — общий тост дублировал одно и повторял другое
    // не тем словом (аудит 22.08.2026, раунд 5).
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-magnets"] }),
  });
}

export function useDeleteLeadMagnet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ ok: true }>(`/lead-magnets/${id}`, { method: "DELETE" }),
    // silent: удаление ничего не сохраняет — тост «Сохранено» на удалённой
    // кампании читался прямо неверно; отказ оба вызывающих печатают через
    // <MutationError mutation={remove}>, успех виден по исчезнувшей карточке.
    meta: { silent: true },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-magnets"] }),
  });
}

/** Загрузка PDF. Отдельной мутацией, а не полем формы: файл уходит на сервер
 *  сразу, а не ждёт «Сохранить» — иначе кампанию можно включить с обещанием
 *  файла, которого на диске ещё нет. */
export function useUploadLeadMagnetFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => {
      const form = new FormData();
      form.append("file", file);
      return api<LeadMagnetCampaignRow>(`/lead-magnets/${id}/file`, { method: "POST", body: form, isForm: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-magnets"] }),
  });
}

export function useDeleteLeadMagnetFile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<LeadMagnetCampaignRow>(`/lead-magnets/${id}/file`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["lead-magnets"] }),
  });
}

/** Одна реплика репетиции — см. rehearseCampaign на сервере. */
export interface RehearsalStep {
  who: "client" | "us" | "note";
  place?: "comment" | "dm";
  text: string;
  button?: string;
  file?: string;
}

/** Репетиция кампании: прогон подставным комментарием без Instagram и без записей.
 *  Мутация, а не запрос: прогон запускают руками и с разными фразами подряд. */
export function useRehearseLeadMagnet() {
  return useMutation({
    mutationFn: ({ id, comment, following }: { id: string; comment: string; following: "yes" | "no" | "unknown" }) =>
      api<{ steps: RehearsalStep[]; enabled: boolean }>(`/lead-magnets/${id}/rehearse`, {
        method: "POST",
        body: { comment, following },
      }),
  });
}

/** Журнал выдач: кто пришёл по рекламе и чем у него кончилось. */
export function useLeadMagnetDeliveries(
  filters: { campaignId?: string; state?: string; page?: number },
  enabled = true
) {
  const params = new URLSearchParams();
  if (filters.campaignId) params.set("campaignId", filters.campaignId);
  if (filters.state) params.set("state", filters.state);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const qs = params.toString();

  return useQuery<Paginated<LeadMagnetDelivery>>({
    queryKey: ["lead-magnet-deliveries", filters],
    queryFn: () => api(`/lead-magnets/deliveries${qs ? `?${qs}` : ""}`),
    // Во время рекламы выдачи идут потоком, и владелец смотрит на этот список
    // именно тогда. Раз в полминуты — не чаще: страница не должна дёргаться.
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    enabled,
  });
}
