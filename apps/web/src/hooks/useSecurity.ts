import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { keepWhilePagingAt } from "../lib/keepWhilePaging";
import type { Paginated, AgentRef } from "../types";
import type { RefusalReason, RefusalInitiator, SecurityReviewState, ClientKind } from "@royal-home/shared";
import { SAFETY_REFETCH_MS } from "../lib/refetchIntervals";

/** Строка кабинета СБ — общая форма и для «Клиентов в СБ» (kind BUYER/OTHER), и
 *  для «Потерянных объектов» (kind SELLER): обе секции читает один и тот же
 *  Client (см. apps/api/src/routes/security.ts). */
export interface SecurityClientRow {
  id: string;
  shortId: number;
  fullName: string;
  phone: string;
  kind: ClientKind;
  refusalReason: RefusalReason | null;
  refusalCount: number;
  /** Скоринг ИИ на момент открытия кабинета — не снимок на момент отказа (снимков
   *  нет, см. routes/security.ts). Отказ при высоком скоринге — тревожный сам по
   *  себе (антифрод, мозговой штурм владельца 20-21.08.2026). */
  aiScore: number | null;
  securityReview: SecurityReviewState | null;
  securityReviewedAt: string | null;
  securityNote: string | null;
  createdAt: string;
  lastContactAt: string;
  responsibleAgent: AgentRef | null;
  reviewedBy: { id: string; fullName: string } | null;
  initiator: RefusalInitiator | null;
  lossFault: "client_lost_agent_fault" | "client_lost_no_fault";
}

/** «1»/«0» — тот же формат, что и у других строковых булевых фильтров CRM
 *  (не boolean-коэрция намеренно, см. securityListQuerySchema в @royal-home/shared). */
export type AgentFaultFilter = "1" | "0" | undefined;

function toQuery(page: number, verdict: string | undefined, agentFault: AgentFaultFilter) {
  const params = new URLSearchParams({ page: String(page) });
  if (verdict) params.set("verdict", verdict);
  if (agentFault) params.set("agentFault", agentFault);
  return params.toString();
}

export function useLostClients(page: number, verdict: string | undefined, agentFault: AgentFaultFilter, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["security", "lost-clients", page, verdict, agentFault],
    placeholderData: keepWhilePagingAt<Paginated<SecurityClientRow>>(["security", "lost-clients", page, verdict, agentFault], 2),
    queryFn: () => api<Paginated<SecurityClientRow>>(`/security/lost-clients?${toQuery(page, verdict, agentFault)}`),
    enabled,
  });
}

export function useLostProperties(page: number, verdict: string | undefined, agentFault: AgentFaultFilter, enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["security", "lost-properties", page, verdict, agentFault],
    placeholderData: keepWhilePagingAt<Paginated<SecurityClientRow>>(["security", "lost-properties", page, verdict, agentFault], 2),
    queryFn: () => api<Paginated<SecurityClientRow>>(`/security/lost-properties?${toQuery(page, verdict, agentFault)}`),
    enabled,
  });
}

/** Плитки «за неделю» (макет c99db05f, `renderSecurityScreen`): входы с новых
 *  устройств, смены прав доступа, красные флаги антифрод-звонков после показа.
 *  Три честных источника (см. докстринг GET /security/summary) — ни одного
 *  выдуманного числа. */
export interface SecurityAlerts {
  newDeviceLogins: number;
  permissionChangeCount: number;
  lastPermissionChangeAt: string | null;
  callRedFlags: { id: string; clientName: string; detail: string | null; createdAt: string }[];
}

/** Сводная плашка кабинета СБ (шаг 5 переноса): суммы по вердиктам и «вина
 *  агента» ПО ВСЕЙ выборке (kind), не по одной странице списка. */
export interface SecuritySummary {
  pending: number;
  cleared: number;
  confirmed: number;
  agentFault: number;
  pendingOldCount: number;
  total: number;
  alerts: SecurityAlerts;
}

export function useSecuritySummary(tab: "clients" | "properties", enabled = true) {
  return useQuery({
    refetchInterval: SAFETY_REFETCH_MS,
    queryKey: ["security", "summary", tab],
    queryFn: () => api<SecuritySummary>(`/security/summary?tab=${tab}`),
    enabled,
    staleTime: 30_000,
  });
}
