import { prisma } from "../db.js";

/**
 * СЛЕД РАБОТЫ С КЛИЕНТОМ — сколько было разговоров и попыток связаться.
 *
 * Жил в lib/inactiveTrafficLight.ts как гейт перевода в «Неактивные». Светофор
 * удалён 16.11.2026 (владелец: «ничего лишнего»), а этот подсчёт нужен дальше:
 * им открывается досрочная «Передача» (lib/clientTransfer.ts::canTransferClient).
 *
 * «Попытка» — доведённый до клиента дозвон, измеренный разговор, ручная запись
 * с исходом, расшифровка или звонок мимо CRM (outsideCrm). Неотвеченный
 * ВХОДЯЩИЙ попыткой не считается — там дозванивались до нас.
 */
export interface ContactTrace {
  /** Состоявшихся разговоров: звонок дольше minSeconds или ответ в переписке. */
  talked: number;
  /** Попыток связаться: доведённый до клиента дозвон или ручная запись с исходом. */
  attempts: number;
}

export async function countContactTrace(clientId: string, minSeconds: number): Promise<ContactTrace> {
  const [talkedCalls, attemptCalls, client] = await Promise.all([
    prisma.interaction.count({
      // Звонок РОП «почему в Корзине» (#217) — разбор, а не попытка агента.
      where: { clientId, type: "CALL", archiveReview: false, recordingDurationSec: { gte: minSeconds } },
    }),
    prisma.interaction.count({
      where: {
        clientId,
        type: "CALL",
        archiveReview: false,
        OR: [
          // Станция довела вызов до телефона клиента — взял он трубку или нет.
          { callAttempt: { in: ["TALKED", "NO_ANSWER"] } },
          // Измеренная длительность ставится только когда клиент снял трубку.
          { recordingDurationSec: { gt: 0 } },
          // Ручная запись агента с исходом из формы «Как прошёл звонок».
          { callAttempt: null, outcome: { not: null } },
          // Расшифровка есть только у состоявшегося разговора.
          { transcript: { not: null } },
          // «Связался со своего телефона» — только попытка, не разговор.
          { outsideCrm: true },
        ],
      },
    }),
    prisma.client.findUnique({ where: { id: clientId }, select: { lastClientMessageAt: true } }),
  ]);
  const wroteBack = client?.lastClientMessageAt ? 1 : 0;
  return { talked: talkedCalls + wroteBack, attempts: attemptCalls + wroteBack };
}

/** Порог «состоявшегося разговора» в секундах, когда строки Settings ещё нет. */
export const DEFAULT_LEAD_CALL_MIN_SECONDS = 30;

/** Settings.leadCallMinSeconds — сколько секунд разговора считается настоящим контактом. */
export async function loadLeadCallMinSeconds(): Promise<number> {
  const s = await prisma.settings.findUnique({ where: { id: "singleton" }, select: { leadCallMinSeconds: true } });
  return s?.leadCallMinSeconds ?? DEFAULT_LEAD_CALL_MIN_SECONDS;
}
