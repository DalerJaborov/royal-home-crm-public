import type { Prisma } from "../generated/prisma/client.js";

/**
 * Shared by the working-list scope and its buyer/seller counters.
 *
 * ОДИН СПИСОК (владелец 16.11.2026: «удалить все папки и статусы, ничего
 * лишнего»). Клиент либо в списке агента, либо с закрытой сделкой, либо в
 * Корзине. Список прячет закрытую сделку (она живёт в «Сделках»), архив (владелец
 * 16.11.2026: «архив — это та же корзина») и назначение, по которому работа уже
 * завершена и ждёт решения руководителя. Старые LOST разовой миграцией
 * 20261117170000_client_lost_back_to_work вернулись в обычную работу.
 */
export const CLIENT_IN_WORK_WHERE = {
  deletedAt: null,
  assignmentCompletedAt: null,
  status: { notIn: ["DEAL_CLOSED", "ARCHIVED"] },
} satisfies Prisma.ClientWhereInput;
