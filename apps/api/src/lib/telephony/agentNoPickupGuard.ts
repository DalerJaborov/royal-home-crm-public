/**
 * АГЕНТ НЕ ПОДНИМАЕТ СВОЮ ЖЕ ТРУБКУ (AGENT_NO_PICKUP) — БЕЗ ЗАЩИТЫ (найдено
 * ревью 24.09.2026). До этой правки исход был чисто информационным: кнопка
 * «Позвонить» из карточки (routes/clients/communications.ts) тут же позволяла
 * набрать ТУ ЖЕ карточку заново, хотя станция ещё не успела даже дозвониться
 * агенту с прошлой попытки, — а серия таких недозвонов подряд (аппарат агента
 * вообще не звонит: SIP не зарегистрирован, телефон выключен, занята линия)
 * не сообщалась никому, хотя это ровно тот класс поломки, который дороже
 * заметить сразу, чем через день молчания агента.
 *
 * НЕ ПУТАТЬ с lib/noAnswerStreak.ts — там серия НЕДОЗВОНОВ КЛИЕНТУ (телефон
 * клиента звонил, клиент не поднял). Здесь — телефон самого АГЕНТА не звонит
 * или он не берёт трубку; это симптом поломки на стороне сотрудника/станции,
 * а не «клиент недоступен».
 *
 * Память процесса, а не база — то же решение, что у `calls` в callTracker.ts
 * (см. докстринг там): состояние живёт минуты и не нужно назавтра. Процесс
 * API один (PM2 без кластера, DEPLOY.md), синхронизация между копиями не
 * нужна.
 */
import { prisma } from "../../db.js";
import { enqueueDirectorAlert } from "../directorAlertQueue.js";
import { logSystemError } from "../systemError.js";

/** Повторный набор ТОЙ ЖЕ карточки ТЕМ ЖЕ агентом запрещён на этот срок после
 *  AGENT_NO_PICKUP — предыдущий вызов ещё может физически идти на станции. */
const REDIAL_THROTTLE_MS = 30_000;

/** Окно, в котором считаем недозвоны агента подряд идущими. */
const AGENT_STREAK_WINDOW_MS = 15 * 60_000;

/** Столько подряд без единого ответа агента — сигнал руководству. */
const AGENT_STREAK_ALERT_THRESHOLD = 3;

/** `clientId:agentId` → момент, до которого повторный набор запрещён. */
const redialThrottle = new Map<string, number>();

interface AgentStreak {
  count: number;
  windowStartedAt: number;
}
/** agentId → серия AGENT_NO_PICKUP подряд в текущем 15-минутном окне. */
const agentStreaks = new Map<string, AgentStreak>();

function throttleKey(clientId: string, agentId: string): string {
  return `${clientId}:${agentId}`;
}

/**
 * Сколько ещё секунд ждать перед повторным набором ЭТОЙ карточки ЭТИМ
 * агентом — 0, если звонить можно прямо сейчас. Вызывается из
 * routes/clients/communications.ts перед originateCallToClient.
 */
export function secondsUntilRedialAllowed(clientId: string, agentId: string, now: Date = new Date()): number {
  const until = redialThrottle.get(throttleKey(clientId, agentId));
  if (until === undefined) return 0;
  const secondsLeft = Math.ceil((until - now.getTime()) / 1000);
  return secondsLeft > 0 ? secondsLeft : 0;
}

/**
 * Станция досчитала исход звонка — вызывается из finishCall (callTracker.ts)
 * для КАЖДОГО завершённого звонка через CRM, не только AGENT_NO_PICKUP: любой
 * другой исход (агент таки поднял трубку, сам отменил вызов) обязан прервать
 * серию, иначе она никогда не обнулится у агента, который просто перезвонил
 * успешно в четвёртый раз.
 */
export function recordAgentCallAttempt(
  agentId: string,
  clientId: string,
  callAttempt: "TALKED" | "CANCELLED" | "NO_ANSWER" | "AGENT_NO_PICKUP",
  at: Date = new Date()
): void {
  if (callAttempt !== "AGENT_NO_PICKUP") {
    agentStreaks.delete(agentId);
    return;
  }

  redialThrottle.set(throttleKey(clientId, agentId), at.getTime() + REDIAL_THROTTLE_MS);

  const prev = agentStreaks.get(agentId);
  const withinWindow = !!prev && at.getTime() - prev.windowStartedAt <= AGENT_STREAK_WINDOW_MS;
  const next: AgentStreak = withinWindow
    ? { count: prev!.count + 1, windowStartedAt: prev!.windowStartedAt }
    : { count: 1, windowStartedAt: at.getTime() };
  agentStreaks.set(agentId, next);

  if (next.count >= AGENT_STREAK_ALERT_THRESHOLD) {
    // Сбрасываем сразу — иначе следующий же недозвон подряд снова перевалит
    // порог и аларм уйдёт на каждый звонок после третьего, а не один раз.
    agentStreaks.delete(agentId);
    void notifyAgentNoPickupStreak(agentId, next.count).catch((err) =>
      console.error("[звонок] серия недозвонов агента:", err instanceof Error ? err.message : err)
    );
  }
}

async function notifyAgentNoPickupStreak(agentId: string, count: number): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { id: agentId }, select: { fullName: true } });
  const who = agent?.fullName ?? agentId;
  const message = `У сотрудника ${who} не звонит телефон: ${count} набора подряд без ответа на его аппарате`;

  // Тот же приём, что у notifyNoAnswerEscalation (lib/noAnswerStreak.ts):
  // журнал ошибок — источник правды и дедуп, enqueueDirectorAlert — пуш
  // руководству через общую очередь алармов (не напрямую sendPushToAgents),
  // чтобы соблюдать часы алармов и не плодить второй путь доставки.
  void logSystemError("telephony", message, { dedupKey: `agent-no-pickup:${agentId}` });
  await enqueueDirectorAlert({
    title: "⚠️ Телефон агента не отвечает",
    body: `${message}. Проверьте SIP-регистрацию и телефон сотрудника.`,
    tag: `agent-no-pickup-${agentId}`,
    recipientPermission: "clients.assign",
  });
}

/** Только для тестов. */
export function resetAgentNoPickupGuard(): void {
  redialThrottle.clear();
  agentStreaks.clear();
}
