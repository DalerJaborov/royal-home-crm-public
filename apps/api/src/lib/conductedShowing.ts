import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";

/**
 * БЫЛ ЛИ У КЛИЕНТА ХОТЯ БЫ ОДИН ФАКТИЧЕСКИ ПРОВЕДЁННЫЙ ПОКАЗ.
 *
 * От этого зависят «Передача» и «Завершить сделку» (ТЗ пп. 16, 19: «до показа
 * кнопка недоступна — это предотвращает фиктивное закрытие клиента без реальной
 * работы»).
 *
 * До 14.08.2026 и фронт, и сервер считали просто НАЛИЧИЕ записи type="SHOWING".
 * Показ создаётся в момент НАЗНАЧЕНИЯ, на будущую дату, — то есть агент назначал
 * показ на следующий месяц и тут же получал обе кнопки. Отменённый показ
 * засчитывался наравне с проведённым. Правило ТЗ не работало вовсе.
 *
 * Проведённым считается показ, который:
 *  • не отменён (`declinedAt` пуст — отмена, см. Interaction.declinedAt), И
 *  • либо отмечен выполненным (`completedAt`),
 *  • либо записан задним числом (`nextActionDate` пуст — так пишут уже
 *    состоявшийся показ из карточки),
 *  • либо его время уже прошло (назначенный показ, до которого дожили).
 *
 * Последний пункт совпадает с тем, по какому признаку CRM открывает обязательное
 * окно «Итог показа» (lib/pendingSummaries.ts): если система уже спрашивает про
 * итог показа, то для неё показ состоялся.
 */
export function conductedShowingWhere(clientId: string, now: Date = new Date()): Prisma.InteractionWhereInput {
  return { clientId, ...conductedShowingBaseWhere(now) };
}

/**
 * То же условие «проведён», но БЕЗ привязки к конкретному клиенту — нужно
 * разделу «Контроль руководителя» (routes/oversight.ts, сигнал «Тишина после
 * показа»), который ищет проведённые показы сразу по всей базе, а не по одной
 * карточке. Вынесено отдельно 22.08.2026, чтобы не заводить второе, слегка иное
 * определение «проведён» рядом с этим.
 */
export function conductedShowingBaseWhere(now: Date = new Date()): Prisma.InteractionWhereInput {
  return {
    type: "SHOWING",
    taskCancelledAt: null,
    declinedAt: null,
    OR: [{ completedAt: { not: null } }, { nextActionDate: null }, { nextActionDate: { lte: now } }],
  };
}

export async function hadConductedShowing(clientId: string): Promise<boolean> {
  return (await prisma.interaction.count({ where: conductedShowingWhere(clientId) })) > 0;
}

/**
 * То же самое определение «проведён», применённое к уже прочитанной в память
 * записи (а не к Prisma-запросу) — нужно там, где показ уже вытянут другим
 * запросом (например «последнее взаимодействие клиента» в oversight.ts) и
 * гонять его через базу второй раз незачем. Держим оба варианта рядом: любая
 * правка критерия «проведён» обязана попасть в оба сразу, поэтому они лежат
 * в одном файле, а не расходятся по разным местам кода.
 */
export function isConductedShowing(
  interaction: { type: string; declinedAt: Date | null; completedAt: Date | null; nextActionDate: Date | null; taskCancelledAt?: Date | null },
  now: Date = new Date()
): boolean {
  if (interaction.type !== "SHOWING" || interaction.declinedAt !== null || interaction.taskCancelledAt) return false;
  return interaction.completedAt !== null || interaction.nextActionDate === null || interaction.nextActionDate <= now;
}
