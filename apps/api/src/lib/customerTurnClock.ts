// ЧАСЫ ХОДА ЯДРА (27.11.2026) — одна дверь на вопрос «от какого момента считать срок хода».
//
// Ядро отвечает на сообщение клиента в пределах 120 секунд (customerAgentRevision.ts), а подписанный вход
// живёт 15 минут (customerIngressAuthority.ts). Отсчёт шёл только от "receivedAt" — момента, когда Meta
// принесла сообщение. Сообщение, пришедшее во время паузы бота (сотрудник ответил руками) или во время
// сбоя ядра, к концу паузы было уже «просрочено» навсегда: клиент оставался без ответа (прод 27.11, 12:26–12:41).
//
// "resumedAt" ставит ОДИН РАЗ сторож догоняния (customerTurnCatchUp.ts, CAS + триггер в базе). С этого момента
// считается новый срок хода того же сообщения. Подлинность входа (подпись Meta, порядок, ключ события)
// по-прежнему сверяется по "receivedAt": меняются только часы, не личность сообщения.

/** Окно Meta на ответ клиенту — сутки; позже возобновлять бессмысленно (та же граница — CHECK в базе). */
export const CUSTOMER_TURN_RESUME_MAX_AGE_MS = 24 * 60 * 60_000;

/** Часы хода билета: "resumedAt", если он есть и честный (не раньше получения и не позже суток), иначе "receivedAt".
 *  Нечестное значение не продлевает ничего: остаются исходные часы (защита по умолчанию). */
export function customerTicketTurnClock(row: { receivedAt: Date | null; resumedAt?: Date | null }): number | null {
  if (!row.receivedAt) return null;
  const received = row.receivedAt.getTime();
  const resumed = row.resumedAt ? row.resumedAt.getTime() : NaN;
  if (!Number.isSafeInteger(received)) return null;
  if (!Number.isSafeInteger(resumed) || resumed < received || resumed - received > CUSTOMER_TURN_RESUME_MAX_AGE_MS) return received;
  return resumed;
}
