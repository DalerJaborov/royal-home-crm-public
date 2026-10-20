import { describe, expect, it } from "vitest";
import { buildAgentTodo, type AgentTodoInput } from "../agentFocus";
import type { Client, Interaction } from "../../types";

/**
 * Порядок «Сначала это» и очереди на Главной агента (06.10.2026, E1).
 * Объекты собраны ровно из полей, которые читает счёт; остальное не нужно.
 */
const NOW = Date.parse("2026-10-06T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const client = (id: string, over: Partial<Client> = {}): Client =>
  ({
    id,
    shortId: Number(id.replace(/\D/g, "")) || 1,
    fullName: `Клиент ${id}`,
    status: "CONTACTED",
    lastContactAt: new Date(NOW - DAY).toISOString(),
    nextStep: { nextAction: "позвонить", nextActionDate: new Date(NOW + DAY).toISOString() },
    ...over,
  }) as unknown as Client;

const task = (id: string, type: string, clientId?: string): Interaction =>
  ({ id, type, client: clientId ? { id: clientId } : undefined }) as unknown as Interaction;

const empty = (over: Partial<AgentTodoInput> = {}): AgentTodoInput => ({
  pending: [],
  duplicates: [],
  offers: [],
  supervisor: [],
  firstCall: [],
  tasks: [],
  portfolio: [],
  now: NOW,
  ...over,
});

describe("buildAgentTodo", () => {
  it("лид на принятие стоит выше срока первого звонка и задачи", () => {
    const todo = buildAgentTodo(
      empty({
        pending: [client("p1")],
        firstCall: [{ id: "f1", shortId: 2, fullName: "Ф", phone: "1", dueAt: new Date(NOW + 60_000).toISOString() }],
        tasks: [task("t1", "CALL", "c1")],
      }),
    );
    expect(todo.focus?.kind).toBe("pending");
    expect(todo.queue.map((i) => i.kind)).toEqual(["firstCall", "task"]);
  });

  it("без срочного фокус берёт самого остывшего, а в очереди его нет", () => {
    const fresh = client("c1", { lastContactAt: new Date(NOW - DAY).toISOString() });
    const cold = client("c2", { lastContactAt: new Date(NOW - 11 * DAY).toISOString() });
    const colder = client("c3", { lastContactAt: new Date(NOW - 20 * DAY).toISOString() });
    const todo = buildAgentTodo(empty({ portfolio: [fresh, cold, colder] }));
    expect(todo.focus).toMatchObject({ kind: "cold", days: 20 });
    expect(todo.queue.map((i) => (i.kind === "client" ? i.client.id : i.kind))).toEqual(["c1", "c2"]);
  });

  it("совсем нечего: фокуса нет", () => {
    const todo = buildAgentTodo(empty({ portfolio: [client("c1")] }));
    expect(todo.focus).toBeNull();
    expect(todo.queue).toHaveLength(1);
  });

  it("показы не идут в очередь, но могут стать фокусом", () => {
    const only = buildAgentTodo(empty({ tasks: [task("t1", "SHOWING", "c1")] }));
    expect(only.focus?.kind).toBe("task");
    const two = buildAgentTodo(empty({ tasks: [task("t1", "CALL", "c1"), task("t2", "SHOWING", "c2")] }));
    expect(two.focus?.kind).toBe("task");
    expect(two.queue).toHaveLength(0);
  });

  it("клиент со сроком или задачей не повторяется строкой портфеля", () => {
    const c1 = client("c1");
    const c2 = client("c2");
    const todo = buildAgentTodo(
      empty({
        tasks: [task("t1", "CALL", "c1")],
        portfolio: [c1, c2],
      }),
    );
    const ids = todo.queue.flatMap((i) => (i.kind === "client" ? [i.client.id] : []));
    expect(ids).toEqual(["c2"]);
  });
});
