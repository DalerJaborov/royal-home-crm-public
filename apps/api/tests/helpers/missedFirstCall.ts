import { prisma } from "../../src/db.js";

/**
 * Сколько раз по клиенту разобран сорванный первый звонок.
 *
 * До 16.11.2026 тесты считали строки штрафа call_15min_missed в журнале Royal
 * Score (sourceId `call-missed-<клиент>-…`). Штраф снят владельцем, и признаком
 * «крон признал срыв» стала системная запись в хронологии — её пишут все три
 * ветки handleMissedFirstCalls: «лид остаётся у агента», эскалация и передача
 * («Лид снят и переназначен: первый звонок не совершён…»).
 */
export function missedFirstCallMarks(clientId: string): Promise<number> {
  return prisma.interaction.count({
    where: { clientId, actorKind: "SYSTEM", notes: { contains: "ервый звонок не совершён" } },
  });
}
