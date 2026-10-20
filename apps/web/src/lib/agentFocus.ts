import type { Client, Interaction } from "../types";
import type { DashboardSummary } from "../hooks/useDashboard";
import type { DuplicateReviewItem, ReactivationOffer } from "../hooks/useClients";
import { buildNoContact, daysSince, stepDay, urgencyOf, type Urgency } from "./agentDay";
import { CLIENT_SOURCE_LABELS } from "./clientFormat";

/**
 * «СНАЧАЛА ЭТО» И «ОЧЕРЕДЬ» ГЛАВНОЙ АГЕНТА — один счёт на обе ширины
 * (06.10.2026, контракт оболочки, задание E1).
 *
 * Раньше «что горит» считали два экрана своими руками: ПК и телефон держали
 * по своему порядку строк. Теперь экран один, а порядок живёт здесь, чистой
 * функцией над уже полученными данными (запросов нет), чтобы его можно было
 * проверить тестом, а не глазами.
 *
 * ПОРЯДОК (сверху то, что нельзя откладывать):
 *   1. лид ждёт принятия: от этого идёт таймер до передачи другому агенту;
 *   2. «это ваш клиент?»: пока агент не ответит, похожая заявка никому не
 *      раздаётся (закон раздела L, 03.09.2026);
 *   3. прежний клиент написал снова: вернуть карточку себе или отказаться;
 *   4. клиента назначил руководитель: принят сразу, ждёт звонка;
 *   5. срок первого звонка;
 *   6. задача дня (показ, перезвон);
 *   7. самый остывший клиент (молчит дольше `NO_CONTACT_DAYS`).
 * Всё, что не заняло «Сначала это», встаёт в очередь тем же порядком, а за
 * ним идут остальные клиенты портфеля по срочности (`buildPortfolio`).
 */

export type FirstCallDueItem = DashboardSummary["firstCallDue"][number];
export type SupervisorAssignedItem = NonNullable<DashboardSummary["assignedBySupervisor"]>[number];

export type AgentTodoItem =
  | { kind: "pending"; key: string; client: Client }
  | { kind: "duplicate"; key: string; review: DuplicateReviewItem }
  | { kind: "reactivation"; key: string; offer: ReactivationOffer }
  | { kind: "supervisor"; key: string; item: SupervisorAssignedItem }
  | { kind: "firstCall"; key: string; item: FirstCallDueItem }
  | { kind: "task"; key: string; task: Interaction }
  | { kind: "cold"; key: string; client: Client; days: number }
  | { kind: "client"; key: string; client: Client; urgency: Urgency; days: number };

export interface AgentTodoInput {
  /** Ждут принятия (серверный срез `pendingAcceptance`), старые первыми. */
  pending: Client[];
  duplicates: DuplicateReviewItem[];
  offers: ReactivationOffer[];
  /** Уже без тех, что стоят строкой по сроку первого звонка. */
  supervisor: SupervisorAssignedItem[];
  firstCall: FirstCallDueItem[];
  tasks: Interaction[];
  /** Результат `buildPortfolio`: просроченные, потом без шага, потом остальные. */
  portfolio: Client[];
  now: number;
}

export interface AgentTodo {
  /** Карточка «Сначала это»; `null`, когда делать нечего. */
  focus: AgentTodoItem | null;
  /** Остальное по порядку, без показов (они стоят в «Сегодня»). */
  queue: AgentTodoItem[];
}

/** Чем заявка интересна: канал и что человек ищет («Instagram · 1-комн · Фирдавси»). */
export function leadHint(c: Client): string {
  const parts = [CLIENT_SOURCE_LABELS[c.source]];
  if (c.desiredRooms) parts.push(`${c.desiredRooms}-комн`);
  if (c.desiredDistrict?.name) parts.push(c.desiredDistrict.name);
  return parts.filter(Boolean).join(" · ");
}

/** Следующий шаг одной строкой: «позвонить, завтра 15:00» либо подсказка назначить его. */
export function nextStepLine(c: Client): string {
  const step = c.nextStep;
  if (!step?.nextAction) return "Договоритесь о следующем шаге";
  return step.nextActionDate ? `${step.nextAction}, ${stepDay(step.nextActionDate)}` : step.nextAction;
}

/** Задача-показ живёт в «Сегодня» с временем; в очередь она не идёт. */
export function isShowingTask(task: Interaction): boolean {
  return task.type === "SHOWING" || task.type === "MEETING";
}

export function buildAgentTodo(input: AgentTodoInput): AgentTodo {
  const { now } = input;
  const items: AgentTodoItem[] = [];

  for (const client of input.pending) items.push({ kind: "pending", key: `pending-${client.id}`, client });
  for (const review of input.duplicates) items.push({ kind: "duplicate", key: `dup-${review.id}`, review });
  for (const offer of input.offers) items.push({ kind: "reactivation", key: `react-${offer.id}`, offer });
  for (const item of input.supervisor) items.push({ kind: "supervisor", key: `sup-${item.id}`, item });
  for (const item of input.firstCall) items.push({ kind: "firstCall", key: `call-${item.id}`, item });
  for (const task of input.tasks) items.push({ kind: "task", key: `task-${task.id}`, task });

  // Один клиент не стоит двумя строками: у кого уже есть срок или задача, тот
  // из портфеля не повторяется.
  const taken = new Set<string>();
  for (const i of items) {
    if (i.kind === "supervisor" || i.kind === "firstCall") taken.add(i.item.id);
    else if (i.kind === "task" && i.task.client?.id) taken.add(i.task.client.id);
    else if (i.kind === "pending") taken.add(i.client.id);
  }

  const portfolio = input.portfolio.filter((c) => !taken.has(c.id));
  const portfolioItems: AgentTodoItem[] = portfolio.map((client) => ({
    kind: "client",
    key: `client-${client.id}`,
    client,
    urgency: urgencyOf(client, now),
    days: daysSince(client.lastContactAt, now),
  }));

  const focusIdx = items.findIndex((i) => i.kind !== "client");
  let focus: AgentTodoItem | null = null;
  let rest = items;
  let tail = portfolioItems;
  if (focusIdx >= 0) {
    focus = items[focusIdx];
    rest = items.filter((_, i) => i !== focusIdx);
  } else {
    // Срочного нет: «Сначала это» занимает самый остывший клиент.
    const coldest = buildNoContact(portfolio, now)[0];
    if (coldest) {
      focus = { kind: "cold", key: `cold-${coldest.id}`, client: coldest, days: daysSince(coldest.lastContactAt, now) };
      tail = portfolioItems.filter((i) => i.kind === "client" && i.client.id !== coldest.id);
    }
  }

  const queue = [...rest, ...tail].filter((i) => !(i.kind === "task" && isShowingTask(i.task)));
  return { focus, queue };
}
