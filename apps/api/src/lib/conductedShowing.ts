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
 * Исторические записи evidenceVersion=0 сохраняют прежнее правило:
 *  • не отменён (`declinedAt` пуст — отмена, см. Interaction.declinedAt), И
 *  • либо отмечен выполненным (`completedAt`),
 *  • либо записан задним числом (`nextActionDate` пуст — так пишут уже
 *    состоявшийся показ из карточки),
 *  • либо его время уже прошло (назначенный показ, до которого дожили).
 *
 * Новые записи evidenceVersion>=1 требуют известного объекта (или явного
 * описания вне CRM) и прошедшей даты/времени. Ранняя отметка completedAt сама
 * по себе не превращает будущую встречу в проведённую.
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
    OR: [
      // Retain historical reporting semantics, never manufacture a new legacy row.
      { showingEvidenceVersion: 0, OR: [{ completedAt: { not: null } }, { nextActionDate: null }, { nextActionDate: { lte: now } }] },
      { showingEvidenceVersion: { gte: 1 }, nextActionDate: { not: null, lte: now },
        OR: [{ propertyId: { not: null } }, { showingOffCrm: true, showingOffCrmDetails: { not: null } }] },
    ],
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
  interaction: { type: string; declinedAt: Date | null; completedAt: Date | null; nextActionDate: Date | null; taskCancelledAt?: Date | null;
    showingEvidenceVersion?: number; propertyId?: string | null; showingOffCrm?: boolean; showingOffCrmDetails?: string | null },
  now: Date = new Date()
): boolean {
  if (interaction.type !== "SHOWING" || interaction.declinedAt !== null || interaction.taskCancelledAt) return false;
  if ((interaction.showingEvidenceVersion ?? 0) >= 1) return !!interaction.nextActionDate && interaction.nextActionDate <= now
    && (!!interaction.propertyId || interaction.showingOffCrm === true && (interaction.showingOffCrmDetails?.trim().length ?? 0) >= 10);
  return interaction.completedAt !== null || interaction.nextActionDate === null || interaction.nextActionDate <= now;
}
