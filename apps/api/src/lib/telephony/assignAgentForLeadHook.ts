/**
 * КРЮЧОК ВМЕСТО ИМПОРТА services/leads/assignment.js — тот же приём, что у
 * pickAgentForLeadHook.ts (см. его шапку про аудит циклов 03.09.2026).
 *
 * assignment.ts импортирует `pickAgentForLead` напрямую из selection.ts, а тот
 * приходит обратно в qualifyIncoming.ts через agentOccupancyShield.ts →
 * callTracker.ts → callRecordings.ts → autoLeadFromCall.ts. Прямой импорт
 * `assignAgentForLead` из qualifyIncoming.ts замкнул бы тот же цикл на
 * agentOccupancyShield.ts — крючок нужен здесь по той же причине.
 *
 * Заведён Пачкой 1 (11.09.2026): звонки переводятся на assignAgentForLead,
 * чтобы правило «свой объект» (показ/совпадение/явный объект из разговора)
 * работало для них так же, как для переписки, а не только общая очередь KPI.
 *
 * src/index.ts и src/worker.ts регистрируют настоящую функцию один раз при
 * старте — тем же способом, что и setPickAgentForLeadHook.
 */
import type { LeadAssignContext, LeadAssignment } from "../../services/leads/assignmentTypes.js";

type AssignAgentForLead = (ctx: LeadAssignContext, excludeAgentIds?: string | string[]) => Promise<LeadAssignment>;
type RecordAssignReason = (clientId: string, agentId: string, assignment: LeadAssignment) => Promise<void>;

let assign: AssignAgentForLead | null = null;
let record: RecordAssignReason | null = null;

export function setAssignAgentForLeadHook(fn: AssignAgentForLead): void {
  assign = fn;
}

/** Тот же крючок для recordAssignReason — прямой импорт из assignment.ts тянет
 *  за собой весь модуль (и его импорт selection.ts) даже если используется
 *  только эта функция: value-импорт в ESM загружает модуль целиком. */
export function setRecordAssignReasonHook(fn: RecordAssignReason): void {
  record = fn;
}

/** До регистрации (модульный тест без index.ts) — ведёт себя как режим "manual":
 *  агента не назначает, лид ждёт руководителя. */
export async function assignAgentForLead(
  ctx: LeadAssignContext,
  excludeAgentIds?: string | string[]
): Promise<LeadAssignment> {
  if (!assign) return { agentId: null, reason: "queue" };
  return assign(ctx, excludeAgentIds);
}

/** До регистрации — молча ничего не пишет (тот же компромисс, что у assignAgentForLead). */
export async function recordAssignReason(clientId: string, agentId: string, assignment: LeadAssignment): Promise<void> {
  if (!record) return;
  return record(clientId, agentId, assignment);
}
