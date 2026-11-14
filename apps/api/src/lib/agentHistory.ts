import { prisma } from "../db.js";

/**
 * ЕСТЬ ЛИ У СОТРУДНИКА ИСТОРИЯ, КОТОРУЮ УДАЛЕНИЕ СТЁРЛО БЫ КАСКАДОМ
 * (находка №195, ночная проверка 24.09.2026).
 *
 * В схеме у этих таблиц `onDelete: Cascade` на сотрудника: удалишь строку —
 * база молча унесёт журнал входов, Royal Score, KPI, журнал ИИ-ассистента,
 * его заявки на удаление клиентов и объектов, споры о счёте, запросы
 * перемонтажа, черновики, разборы звонков и требования. Раньше «Удалить
 * сотрудника» без звонков и сделок (маркетолог, монтажёр, безопасник, админ)
 * стирал всё это и уходил без следа. Схему не меняем (это миграция), поэтому
 * маршрут удаления спрашивает здесь заранее и при любой записи идёт той же
 * веткой, что и при сделках: учётка отключается, телефон освобождается, история
 * остаётся.
 *
 * СПИСОК СВЕРЯЕТСЯ СО СХЕМОЙ ТЕСТОМ (07.11.2026, ревью пачки 2 Шабнам):
 * `tests/agent-cascade-history-guard.test.ts` находит в schema.prisma все модели с
 * `onDelete: Cascade` на Agent и требует, чтобы каждая была либо в
 * AGENT_CASCADE_HISTORY (проверяется здесь), либо в AGENT_CASCADE_NOT_HISTORY с
 * причиной. Новая таблица без решения — красный тест, а не молча стёртая история.
 * Так нашлась PropertyChangeRequest (заявки на правку объекта): её не было в списке.
 */
type HistoryProbe = (agentId: string) => Promise<{ id: string } | null>;

const byAgent = (agentId: string) => ({ where: { agentId }, select: { id: true } }) as const;
const byAuthor = (agentId: string) => ({ where: { requestedById: agentId }, select: { id: true } }) as const;

/** Модель → проверка «есть ли хоть одна строка этого сотрудника». */
export const AGENT_CASCADE_HISTORY: Record<string, HistoryProbe> = {
  LoginLog: (id) => prisma.loginLog.findFirst(byAgent(id)),
  RoyalScoreEvent: (id) => prisma.royalScoreEvent.findFirst(byAgent(id)),
  KpiDailyScore: (id) => prisma.kpiDailyScore.findFirst(byAgent(id)),
  AiAssistantAuditLog: (id) => prisma.aiAssistantAuditLog.findFirst(byAgent(id)),
  AiAssistantTurnLog: (id) => prisma.aiAssistantTurnLog.findFirst(byAgent(id)),
  CallAnalysis: (id) => prisma.callAnalysis.findFirst(byAgent(id)),
  CardSuggestion: (id) => prisma.cardSuggestion.findFirst(byAgent(id)),
  PropertyDraft: (id) => prisma.propertyDraft.findFirst(byAgent(id)),
  PendingSummary: (id) => prisma.pendingSummary.findFirst(byAgent(id)),
  ClientDeleteRequest: (id) => prisma.clientDeleteRequest.findFirst(byAuthor(id)),
  PropertyDeleteRequest: (id) => prisma.propertyDeleteRequest.findFirst(byAuthor(id)),
  PropertyCountDispute: (id) => prisma.propertyCountDispute.findFirst(byAuthor(id)),
  // Предложение объекта коллеге (10.11.2026): кто кому предлагал и что ответили — история работы.
  PropertyClientOffer: (id) => prisma.propertyClientOffer.findFirst({ where: { OR: [{ fromAgentId: id }, { toAgentId: id }] }, select: { id: true } }),
  VideoRemakeRequest: (id) => prisma.videoRemakeRequest.findFirst(byAuthor(id)),
  PropertyChangeRequest: (id) => prisma.propertyChangeRequest.findFirst({ where: { authorId: id }, select: { id: true } }),
};

/** Каскад на сотрудника, который историей НЕ считается — с причиной. */
export const AGENT_CASCADE_NOT_HISTORY: Record<string, string> = {
  Session: "состояние устройства, не история",
  PushSubscription: "состояние устройства, не история",
  Notification: "колокольчик сотрудника, не журнал работы",
  PushActionToken: "одноразовый токен действия из пуша",
  Passkey: "ключ входа устройства",
  LoginSmsCode: "одноразовый код входа",
  AgentHandoverBatch: "снимок раздачи создаёт сам маршрут удаления прямо перед проверкой",
  AssistantStepUpChallenge: "ожидание кода Google Authenticator у помощницы; хранится сутки, след — в AuditLog",
  StaffNotice: "журнал рассылок помощницы (что и когда ушло); хранится 90 дней, настройки — в Agent.pushMuted",
};

export async function agentHasCascadeHistory(agentId: string): Promise<boolean> {
  const found = await Promise.all(Object.values(AGENT_CASCADE_HISTORY).map((probe) => probe(agentId)));
  return found.some((row) => row !== null);
}
