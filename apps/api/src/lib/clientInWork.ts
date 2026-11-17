import type { Prisma } from "../generated/prisma/client.js";
import { TERMINAL_CLIENT_STATUSES } from "./clientContact.js";

/**
 * Shared by the working-list scope and its buyer/seller counters.
 *
 * INACTIVE (светофор молчания) остаётся «в работе» (владелец 10.11.2026, жалоба
 * «у агентов не все клиенты отображаются»). С #62 (30.10) условие требовало
 * `workStatus: "ACTIVE"`, и вкладка «В работе» молча прятала 112 из 496 живых
 * карточек, в том числе клиентов уволенного сотрудника, розданных агентам
 * «Передачей дел». Неактивный — тот, с кем ещё работают (routes/clients/list.ts,
 * 23.09.2026), а не потерянный; вкладка «Неактивные» остаётся отдельным срезом.
 */
export const CLIENT_IN_WORK_WHERE = {
  deletedAt: null,
  assignmentCompletedAt: null,
  status: { notIn: [...TERMINAL_CLIENT_STATUSES] },
} satisfies Prisma.ClientWhereInput;
