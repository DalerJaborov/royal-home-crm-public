import type { Client } from "../types";

/**
 * Пачка 16 (11.09.2026, docs/archive/agent-briefs/ownership-security-11-09.md): агент,
 * у которого клиента забрали, открывает карточку по старой ссылке и получает
 * `client.access` от GET /clients/:id (routes/clients/card.ts) вместо 403.
 * Логика вынесена из ClientDetail.tsx в чистые функции — компонент огромный и
 * не рендерится в тестах этого репозитория (нет testing-library/jsdom в
 * зависимостях apps/web), а эти два места и обязаны остаться верными сами по
 * себе: баннер должен назвать причину и нового агента, а «Позвонить» — не
 * протечь бывшему агенту без права `clients.assign`.
 */

export interface TransferBanner {
  /** «Клиент передан {агент|в очередь руководителя}». */
  headline: string;
  /** Текст последней системной Interaction о смене агента, или null, если её нет. */
  reason: string | null;
}

/** null, если карточка обычная (или `access` не пришёл вовсе). */
export function transferBannerOf(client: Pick<Client, "access">): TransferBanner | null {
  const access = client.access;
  if (!access?.readOnly) return null;
  return {
    headline: `Клиент передан ${access.transferredTo?.fullName ?? "в очередь руководителя"}`,
    reason: access.reason,
  };
}

/**
 * «Позвонить» — единственное действие, которое остаётся видно на read-only
 * карточке переданного клиента (остальные кнопки просто отсутствуют, не
 * disabled — см. ClientDetail.tsx, п.2 брифа). Право то же, что уже отпирает
 * запись в чужую карточку (`clients.assign`): рядовому бывшему агенту звонить
 * клиенту, которого у него забрали, мимо решения руководителя нельзя.
 */
export function canCallOnTransferredCard(client: Pick<Client, "access">, canAssignForeign: boolean): boolean {
  return !!client.access?.readOnly && canAssignForeign;
}
