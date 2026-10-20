import type { ClientStatus } from "@royal-home/shared";
import { CLIENT_STATUS_CLASSES, CLIENT_STATUS_LABELS } from "../lib/clientFormat";

/**
 * size="sm" — компактная плашка телефонного списка клиентов: 11px/700,
 * паддинг 2px 7px, радиус 6px, без точки — по прототипу
 * design_handoff_royal_home_crm (isClients → cl.badge).
 *
 * size="card" — плашка под именем в шапке телефонной карточки клиента: по
 * прототипу (vClient, «Горячий лид») 12px/700, паддинг 3px 8px, радиус 7px,
 * без точки. Отличается от "sm" на десятые доли (11 vs 12, 6px vs 7px
 * радиуса) — это разные экраны прототипа, числа не унифицированы в самом
 * макете, поэтому не сводим их в один вариант.
 *
 * Цвета и подписи общие с обычной: второй источник правды для статусов не заводим.
 */
export function ClientStatusBadge({ status, size = "md" }: { status: ClientStatus; size?: "md" | "sm" | "card" }) {
  if (size === "sm") {
    return (
      <span
        className={`inline-flex items-center text-[13px] font-bold rounded-md px-[7px] py-0.5 whitespace-nowrap ${CLIENT_STATUS_CLASSES[status]}`}
      >
        {CLIENT_STATUS_LABELS[status]}
      </span>
    );
  }
  if (size === "card") {
    return (
      <span
        className={`inline-flex items-center text-[13px] font-bold rounded-[7px] px-2 py-[3px] whitespace-nowrap ${CLIENT_STATUS_CLASSES[status]}`}
      >
        {CLIENT_STATUS_LABELS[status]}
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[15px] font-semibold rounded-badge px-2 py-0.5 whitespace-nowrap ${CLIENT_STATUS_CLASSES[status]}`}
    >
      <i className="w-[5px] h-[5px] rounded-full bg-current" />
      {CLIENT_STATUS_LABELS[status]}
    </span>
  );
}
